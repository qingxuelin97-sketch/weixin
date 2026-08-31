/**
 * Image generation client — OpenAI-compatible `/images/generations` (M-J3,
 * 她真的能拍一张给你看).
 *
 * This is the SECOND module in the repo that talks to the network directly
 * (the first is ./http, whose transport policy it rides). Everything the ASR
 * client learned the hard way applies verbatim:
 *   - user-filled key, stored ONLY via the keystore (constitution rule #2 —
 *     the settings row carries a `keyAlias`, never a key);
 *   - preset descriptors (SiliconFlow is first-class; any OpenAI-compatible
 *     endpoint works as 自定义);
 *   - fetch-first / native-bridge-fallback transport via `httpJson`, whose
 *     deadline is a timer that actually REJECTS (constitution trap list);
 *   - failures degrade, never surface: every caller falls back to the asset
 *     pool, so a broken endpoint costs a picture, not a conversation.
 *
 * 铁律 6, outbound, for pixels (the heaviest line in this module): a full-tier
 * prompt describes full-tier content, and SiliconFlow is a MAINLAND OFFICIAL
 * endpoint exactly like DeepSeek/MiniMax — so `generateImage` refuses the call
 * at the full tier unless the user has explicitly marked a CUSTOM endpoint as
 * capable of carrying it. `tier` is a REQUIRED parameter with no default: a
 * call site that forgets it fails to compile instead of silently declaring the
 * material safe (the M-I18 lesson, applied on day one).
 */
import { repo } from '../db/repo';
import { getSecret, hasSecret } from '../lib/keystore';
import { recordUsage } from '../lib/usage';
import { httpJson, nativeHttp, raceDeadline } from './http';
import type { NsfwTier } from './router';

/* ------------------------------------------------------------------ */
/* Presets                                                             */
/* ------------------------------------------------------------------ */

export interface ImagePresetDescriptor {
  kind: ImageProviderVM['kind'];
  label: string;
  baseUrl: string;
  /** Default model id; user-editable, catalogs rotate. */
  model: string;
  /** Sizes the endpoint accepts; first one is the default. */
  sizes: string[];
  note?: string;
}

export const IMAGE_PRESETS: Record<string, ImagePresetDescriptor> = {
  siliconflow: {
    kind: 'siliconflow',
    label: 'SiliconFlow 硅基流动（国内直连）',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Kwai-Kolors/Kolors',
    sizes: ['1024x1024', '960x1280', '768x1024', '512x512'],
    note: 'Kolors 中文提示词效果好且便宜，国内可直连。国内官方端点：全开档内容绝不会走这里。',
  },
  openai: {
    kind: 'openai',
    label: 'OpenAI（gpt-image / DALL·E）',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-image-1',
    sizes: ['1024x1024', '1024x1536', '512x512'],
    note: '大陆需代理。模型 id 会更新，报错时改用官网现行 id。',
  },
};

/** The settings row key. The row stores an ImageProviderVM — never a key. */
export const IMAGE_SETTING = 'imageProvider';

export interface ImageProviderVM {
  /** Preset kind or 'custom'. */
  kind: 'siliconflow' | 'openai' | 'custom';
  label: string;
  baseUrl: string;
  /** Keystore alias; the actual key never touches the DB (rule #2). */
  keyAlias: string;
  model: string;
  /** Sizes offered in pickers; requests clamp to this list. */
  sizes: string[];
  /**
   * 铁律 6：这个端点可以承载全开档的生成提示吗？只对 kind==='custom' 有意义 —
   * 预设端点（SiliconFlow 是国内官方！）在全开档下**无条件拒绝**，勾了也没用，
   * 与 ASR 的 `nsfwSafe` 和 LLM 宽松通道是同一个用户判断。未声明即 NO。
   */
  nsfwCapable?: boolean;
}

/** Build a fresh config from a preset kind (parallel to asrPresetToConfig). */
export function imagePresetToConfig(kind: string): ImageProviderVM {
  const p = IMAGE_PRESETS[kind];
  if (p) {
    return {
      kind: p.kind,
      label: p.label,
      baseUrl: p.baseUrl,
      keyAlias: `key_img_${p.kind}`,
      model: p.model,
      sizes: [...p.sizes],
    };
  }
  return {
    kind: 'custom',
    label: '自定义（OpenAI 兼容）',
    baseUrl: '',
    keyAlias: 'key_img_custom',
    model: '',
    sizes: ['1024x1024', '512x512'],
  };
}

/* ------------------------------------------------------------------ */
/* Config persistence                                                  */
/* ------------------------------------------------------------------ */

export async function getImageProvider(): Promise<ImageProviderVM | null> {
  const cfg = await repo.getSetting<ImageProviderVM>(IMAGE_SETTING);
  // Defensive shape check: a hand-edited or half-restored row must read as
  // "not configured", not detonate deep inside an engine turn.
  if (!cfg || typeof cfg.baseUrl !== 'string' || typeof cfg.keyAlias !== 'string') return null;
  return cfg;
}

export async function saveImageProvider(cfg: ImageProviderVM): Promise<void> {
  await repo.putSetting(IMAGE_SETTING, cfg);
}

export async function clearImageProvider(): Promise<void> {
  await repo.putSetting(IMAGE_SETTING, null);
}

/**
 * 铁律 6 的分档闸门，独立成纯函数好钉测试：全开档只放行「custom 且用户显式
 * 勾了 nsfwCapable」的端点。SiliconFlow/OpenAI 预设在全开档下**无条件**出局 —
 * SiliconFlow 是国内官方端点，OpenAI 也不是用户声明过的宽松通道。
 */
export function imageAllowedAtTier(cfg: Pick<ImageProviderVM, 'kind' | 'nsfwCapable'>, tier: NsfwTier): boolean {
  if (tier !== 'full') return true;
  return cfg.kind === 'custom' && cfg.nsfwCapable === true;
}

/**
 * Whether generation can actually run right now, at this tier: a config
 * exists, endpoint + model are filled, a key is saved, and the tier gate
 * passes. Callers ask this BEFORE building a prompt so the "no provider"
 * path costs nothing and falls back to the asset pool silently.
 */
export async function isImageGenReady(tier: NsfwTier): Promise<boolean> {
  const cfg = await getImageProvider();
  if (!cfg || !cfg.baseUrl.trim() || !cfg.model.trim()) return false;
  if (!imageAllowedAtTier(cfg, tier)) return false;
  return hasSecret(cfg.keyAlias);
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export type ImageGenErrorKind =
  | 'not_configured'
  | 'tier_blocked' // 铁律 6：全开档提示词不发往未声明的生成端点
  | 'auth'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'server'
  | 'bad_response';

export class ImageGenError extends Error {
  constructor(
    public kind: ImageGenErrorKind,
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = 'ImageGenError';
  }
}

/* ------------------------------------------------------------------ */
/* Generation                                                          */
/* ------------------------------------------------------------------ */

export interface GenerateImageOptions {
  /** Must be one of the config's sizes; clamps to the first otherwise. */
  size?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

/** Diffusion backends are slow; 90s covers a cold Kolors queue. */
export const DEFAULT_IMAGE_TIMEOUT = 90_000;

function endpointOf(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}/images/generations`;
}

/** OpenAI shape and SiliconFlow's native shape, both read defensively. */
interface ImagesResponse {
  data?: Array<{ b64_json?: string; url?: string }>;
  images?: Array<{ url?: string; b64_json?: string }>;
  error?: { message?: string };
  message?: string;
}

/**
 * Generate one image.
 *
 * `tier` is the NSFW tier of the SURFACE the prompt came from — derived by the
 * caller via src/lib/nsfw-tier.ts, never invented here and never defaulted
 * (rule #6 is a compile-time constraint in this repo). At 'full' the call is
 * refused outright unless the endpoint is a user-declared capable custom one;
 * the refusal happens BEFORE the key is read and before any bytes move.
 *
 * Resolves with raw image bytes; the caller decides where they live (media
 * library via `putGeneratedMedia`). Throws ImageGenError only.
 */
export async function generateImage(
  prompt: string,
  tier: NsfwTier,
  opts: GenerateImageOptions = {},
): Promise<{ blob: Blob; mime: string }> {
  const cfg = await getImageProvider();
  if (!cfg || !cfg.baseUrl.trim() || !cfg.model.trim()) {
    throw new ImageGenError('not_configured', '图片生成未配置');
  }
  // 铁律 6, before anything else: the prompt describes graded content, and a
  // mainland official endpoint (SiliconFlow included) must never receive it.
  if (!imageAllowedAtTier(cfg, tier)) {
    throw new ImageGenError('tier_blocked', '全开档提示词不发往未声明可承载的生成端点');
  }
  const key = await getSecret(cfg.keyAlias);
  if (!key) throw new ImageGenError('not_configured', '图片生成密钥未保存');

  const size = opts.size && cfg.sizes.includes(opts.size) ? opts.size : (cfg.sizes[0] ?? '1024x1024');
  const timeoutMs = opts.timeoutMs ?? DEFAULT_IMAGE_TIMEOUT;

  // Every generation is a paid call, backfill-materialized ones included —
  // counted up front like the router does, so failures spend honestly too.
  void recordUsage('image', Date.now()).catch(() => {});

  // SiliconFlow's native field names differ from OpenAI's; both are asked for
  // base64 first so the answer needs no second fetch. Extra unknown fields are
  // what OpenAI-compatible gateways 400 on, so the bodies stay disjoint.
  const body: Record<string, unknown> =
    cfg.kind === 'siliconflow'
      ? { model: cfg.model, prompt, image_size: size, batch_size: 1, response_format: 'b64_json' }
      : { model: cfg.model, prompt, size, n: 1, response_format: 'b64_json' };

  const res = await httpJson({
    url: endpointOf(cfg.baseUrl),
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body,
    signal: opts.signal,
    timeoutMs,
  }).catch((e) => {
    throw mapTransportError(e);
  });

  if (res.status >= 400) throw statusToError(res.status, res.data);

  const parsed = res.data as ImagesResponse;
  const item = parsed?.data?.[0] ?? parsed?.images?.[0];
  // b64_json preferred — one round trip, no CDN CORS to fight.
  const b64 = item?.b64_json;
  if (b64 && typeof b64 === 'string') {
    return { blob: b64ToBlob(b64, 'image/png'), mime: 'image/png' };
  }
  // url fallback: some backends (SiliconFlow's Kolors among them) only serve a
  // short-lived CDN link — fetch it into a blob NOW, before it expires.
  const url = item?.url;
  if (url && typeof url === 'string') {
    return fetchImageBlob(url, timeoutMs, opts.signal);
  }
  throw new ImageGenError('bad_response', `生成端点未返回图片：${snippet(parsed)}`);
}

/**
 * Download generated bytes from a result URL. Same transport policy as
 * everything else: plain fetch first; on a device where the CDN serves no
 * CORS headers, the native bridge fetches it as base64 — raced against a
 * REJECTING timer, because the bridge cannot be interrupted from JS.
 */
export async function fetchImageBlob(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ blob: Blob; mime: string }> {
  let fetchErr: unknown;
  try {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new ImageGenError('bad_response', `图片下载失败（${res.status}）`, res.status);
      const blob = await res.blob();
      return { blob, mime: blob.type || mimeFromUrl(url) };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  } catch (e) {
    if (e instanceof ImageGenError && e.kind !== 'network') throw e;
    fetchErr = e;
  }

  const native = await nativeHttp();
  if (!native) throw new ImageGenError('network', `图片下载失败：${msg(fetchErr)}`);
  try {
    const res = await raceDeadline(
      native.request({ url, method: 'GET', responseType: 'blob', readTimeout: timeoutMs, connectTimeout: timeoutMs }),
      timeoutMs,
      signal,
    );
    if (res.status >= 400 || typeof res.data !== 'string') {
      throw new ImageGenError('bad_response', `图片下载失败（原生通道 ${res.status}）`, res.status);
    }
    const mime = mimeFromUrl(url);
    return { blob: b64ToBlob(res.data, mime), mime };
  } catch (e) {
    if (e instanceof ImageGenError) throw e;
    const isTimeout = e instanceof Error && 'kind' in e && (e as { kind?: string }).kind === 'timeout';
    throw new ImageGenError(
      isTimeout ? 'timeout' : 'network',
      `网页通道: ${msg(fetchErr)}；原生通道: ${msg(e)}`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* Settings-page probe                                                 */
/* ------------------------------------------------------------------ */

/**
 * Full-path test for the config page: really generates one small image (the
 * cheapest honest probe — a /models GET proves nothing about a diffusion
 * queue). Mirrors testAsrConnection: answer fast or fail fast, never hang.
 */
export async function testImageGeneration(cfg: ImageProviderVM): Promise<{ ok: boolean; message: string }> {
  try {
    await saveImageProvider(cfg); // test what will actually be used
    const smallest = [...cfg.sizes].sort((a, b) => pixels(a) - pixels(b))[0];
    const t0 = Date.now();
    const { blob } = await generateImage('一只可爱的橘猫，简笔画', 'off', {
      size: smallest,
      timeoutMs: 60_000,
    });
    return {
      ok: true,
      message: `生成通了（${Math.round((Date.now() - t0) / 1000)}s，${Math.round(blob.size / 1024)}KB）`,
    };
  } catch (e) {
    return { ok: false, message: msg(e) };
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function pixels(size: string): number {
  const m = /^(\d+)x(\d+)$/.exec(size);
  return m ? Number(m[1]) * Number(m[2]) : Number.MAX_SAFE_INTEGER;
}

function mapTransportError(e: unknown): ImageGenError {
  if (e instanceof ImageGenError) return e;
  const kind = e instanceof Error && 'kind' in e ? (e as { kind?: string }).kind : undefined;
  if (kind === 'timeout') return new ImageGenError('timeout', `生成超时：${msg(e)}`);
  return new ImageGenError('network', `生成请求未达：${msg(e)}`);
}

function statusToError(status: number, data: unknown): ImageGenError {
  const detail = (data as ImagesResponse)?.error?.message ?? (data as ImagesResponse)?.message ?? snippet(data);
  if (status === 401 || status === 403) return new ImageGenError('auth', `密钥被拒（${status}）`, status);
  if (status === 429) return new ImageGenError('rate_limit', '限流（429）', status);
  if (status >= 500) return new ImageGenError('server', `服务端错误（${status}）`, status);
  return new ImageGenError('bad_response', `请求被拒（${status}）：${detail}`, status);
}

function b64ToBlob(b64: string, mime: string): Blob {
  const clean = b64.replace(/^data:[^,]*,/, '');
  const bytes = Uint8Array.from(atob(clean), (ch) => ch.charCodeAt(0));
  return new Blob([bytes], { type: mime });
}

function mimeFromUrl(url: string): string {
  const m = /\.(png|jpe?g|webp|gif)(?:\?|$)/i.exec(url);
  if (!m) return 'image/png';
  const ext = m[1].toLowerCase();
  return ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
}

function snippet(data: unknown): string {
  const s = typeof data === 'string' ? data : JSON.stringify(data);
  return (s ?? '').slice(0, 120);
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
