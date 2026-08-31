/**
 * ASR (speech-to-text) client — OpenAI-compatible `/audio/transcriptions`
 * (M-I9, 微信「按住说话」的转写端).
 *
 * Design mirrors the chat adapter layer deliberately:
 *   - user-filled key, stored ONLY via the keystore (constitution rule #2 —
 *     the settings row carries a `keyAlias`, never a key);
 *   - preset descriptors like `presets.ts` (SiliconFlow / OpenAI / Groq are
 *     first-class; any OpenAI-compatible endpoint works as 自定义);
 *   - the same transport policy as `http.ts`: the WebView's own fetch is the
 *     PRIMARY channel even on a device (the M-D live-device verdict), with the
 *     CapacitorHttp bridge as multipart fallback for no-CORS gateways;
 *   - and the same hard rule from the constitution's trap list: the bridge
 *     cannot be interrupted from JS, so its deadline is `raceDeadline` — a
 *     timer that actually REJECTS — never a fire-and-forget setTimeout.
 *
 * This module is transport + config only. Recording lives in
 * `src/lib/recorder.ts`; the hold-to-talk UI in `features/chat/VoiceInput.tsx`.
 */
import { repo } from '../db/repo';
import { getSecret, hasSecret } from '../lib/keystore';
import { recordUsage } from '../lib/usage';
import { nativeHttp, raceDeadline } from './http';

/* ------------------------------------------------------------------ */
/* Presets                                                             */
/* ------------------------------------------------------------------ */

export interface AsrPresetDescriptor {
  kind: string;
  label: string;
  baseUrl: string;
  /** Model ids known to work on this endpoint; first one is the default. */
  models: string[];
  note?: string;
}

/**
 * All three speak the OpenAI `/audio/transcriptions` multipart shape. Model
 * catalogs rotate (Groq especially); everything here is a user-editable
 * default, not a hard-coded truth.
 */
export const ASR_PRESETS: Record<string, AsrPresetDescriptor> = {
  siliconflow: {
    kind: 'siliconflow',
    label: 'SiliconFlow 硅基流动（国内直连）',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['FunAudioLLM/SenseVoiceSmall'],
    note: 'SenseVoice 中文识别快且便宜，国内可直连。语言留空自动检测。',
  },
  openai: {
    kind: 'openai',
    label: 'OpenAI（Whisper / 4o-transcribe）',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini-transcribe', 'whisper-1'],
    note: '大陆需代理。语言填 zh 可提升中文短句准确率。',
  },
  groq: {
    kind: 'groq',
    label: 'Groq（Whisper 极速）',
    baseUrl: 'https://api.groq.com/openai/v1',
    models: ['whisper-large-v3-turbo', 'whisper-large-v3'],
    note: '转写速度最快的一档；模型目录轮换较快，报 model 错误时改用官网现行 id。',
  },
};

/** The settings row key. The row stores an AsrConfigVM — never a key. */
export const ASR_SETTING = 'asrConfig';

export interface AsrConfigVM {
  /** Preset kind or 'custom'. */
  kind: string;
  label: string;
  baseUrl: string;
  model: string;
  /** Keystore alias; the actual key never touches the DB (rule #2). */
  keyAlias: string;
  /** ISO-639-1 hint ('zh'…); empty = provider auto-detect. */
  language?: string;
  /**
   * 铁律 6 的**入站**面 (M-I18): may this endpoint receive 全开档 speech?
   *
   * The rule has always been enforced outbound — the router refuses to send
   * full-tier prompts to a domestic official endpoint. Speech is the same
   * context travelling the other way: what the user says out loud in a
   * full-tier call is uploaded verbatim, and ASR does not go through the
   * router, so nothing was checking it.
   *
   * Undeclared means NO. The user marks a transcription endpoint as permissive
   * the same way they choose a permissive LLM channel — it is their key and
   * their endpoint, but the safe answer has to be the default.
   */
  nsfwSafe?: boolean;
}

/** Build a fresh config from a preset kind (parallel to presetToVm). */
export function asrPresetToConfig(kind: string): AsrConfigVM {
  const p = ASR_PRESETS[kind];
  if (p) {
    return {
      kind: p.kind,
      label: p.label,
      baseUrl: p.baseUrl,
      model: p.models[0],
      keyAlias: `key_asr_${p.kind}`,
      language: 'zh',
    };
  }
  return {
    kind: 'custom',
    label: '自定义（OpenAI 兼容）',
    baseUrl: '',
    model: '',
    keyAlias: 'key_asr_custom',
    language: 'zh',
  };
}

/* ------------------------------------------------------------------ */
/* Config persistence                                                  */
/* ------------------------------------------------------------------ */

export async function getAsrConfig(): Promise<AsrConfigVM | null> {
  const cfg = await repo.getSetting<AsrConfigVM>(ASR_SETTING);
  // Defensive shape check: a hand-edited or half-restored row must read as
  // "not configured", not detonate deep inside a pointerup handler.
  if (!cfg || typeof cfg.baseUrl !== 'string' || typeof cfg.keyAlias !== 'string') return null;
  return cfg;
}

export async function saveAsrConfig(cfg: AsrConfigVM): Promise<void> {
  await repo.putSetting(ASR_SETTING, cfg);
}

export async function clearAsrConfig(): Promise<void> {
  await repo.putSetting(ASR_SETTING, null);
}

/**
 * Whether hold-to-talk can actually transcribe: a config exists, its endpoint
 * and model are filled, and a key has been saved under the alias. The UI asks
 * this BEFORE opening the mic so "record 30s, then learn it can't be sent"
 * never happens.
 */
export async function isAsrReady(): Promise<boolean> {
  const cfg = await getAsrConfig();
  if (!cfg || !cfg.baseUrl.trim() || !cfg.model.trim()) return false;
  return hasSecret(cfg.keyAlias);
}

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

export type AsrErrorKind =
  | 'not_configured' // no config / no saved key
  | 'auth' // 401/403
  | 'rate_limit' // 429
  | 'timeout'
  | 'network'
  | 'server' // 5xx
  | 'bad_response' // 2xx but unparseable, or 4xx protocol errors
  | 'aborted'
  | 'tier_blocked'; // 铁律 6: 全开档语音不许上传到未声明的转写端点

export class AsrError extends Error {
  constructor(
    public kind: AsrErrorKind,
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = 'AsrError';
  }
}

/** One-line human message for a toast. Raw provider errors never hit the UI. */
export function friendlyAsrError(e: unknown): string {
  if (e instanceof AsrError) {
    switch (e.kind) {
      case 'not_configured':
        return '还没配置语音识别——设置 → 语音输入 里选一家填上 key';
      case 'auth':
        return '语音识别密钥无效，去设置里检查一下';
      case 'rate_limit':
        return '识别服务限流了，稍等几秒再试';
      case 'timeout':
        return '转写超时了——网络慢或代理没覆盖本应用';
      case 'network':
        return '转写失败：网络不通';
      case 'server':
        return '识别服务出错了（5xx），稍后再试';
      case 'aborted':
        return '已取消';
      case 'tier_blocked':
        return '全开档下这个转写服务没被标记为可用——改用打字，或去 设置 → 语音输入 换一家并勾选';
      default:
        return `转写失败：${e.message}`;
    }
  }
  return `转写失败：${e instanceof Error ? e.message : String(e)}`;
}

/* ------------------------------------------------------------------ */
/* Transcription                                                       */
/* ------------------------------------------------------------------ */

export interface TranscribeOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Override the config's language hint for one call. */
  language?: string;
  /**
   * NSFW tier of the surface this speech belongs to (M-I18). 'full' uploads
   * only to an endpoint the user marked `nsfwSafe`; omit for surfaces that
   * carry no graded content. See `AsrConfigVM.nsfwSafe`.
   */
  tier?: 'off' | 'ambiguous' | 'full';
}

/** Uploads are small (<1MB for 60s opus) but ASR backends can be slow. */
export const DEFAULT_ASR_TIMEOUT = 30_000;

function endpointOf(baseUrl: string): string {
  return `${baseUrl.trim().replace(/\/+$/, '')}/audio/transcriptions`;
}

/** Filename extension by blob mime — providers sniff format from the name. */
export function fileNameFor(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes('webm')) return 'speech.webm';
  if (m.includes('mp4') || m.includes('m4a') || m.includes('aac')) return 'speech.m4a';
  if (m.includes('mpeg') || m.includes('mp3')) return 'speech.mp3';
  if (m.includes('ogg') || m.includes('opus')) return 'speech.ogg';
  if (m.includes('wav')) return 'speech.wav';
  return 'speech.webm';
}

/**
 * Transcribe a recorded clip using the saved config. Resolves with the
 * (trimmed) recognized text — possibly '' for silence; the caller decides how
 * to phrase "heard nothing". Throws AsrError only.
 */
export async function transcribe(audio: Blob, opts: TranscribeOptions = {}): Promise<string> {
  const cfg = await getAsrConfig();
  if (!cfg || !cfg.baseUrl.trim() || !cfg.model.trim()) {
    throw new AsrError('not_configured', '语音识别未配置');
  }
  // 铁律 6, inbound (M-I18). The caller passes the tier of the surface the
  // speech belongs to; refusing here — in the one function every push-to-talk
  // path goes through — is what makes the rule structural rather than a note
  // in a spec. `undefined` tier means "not a graded surface" and passes.
  if (opts.tier === 'full' && !cfg.nsfwSafe) {
    throw new AsrError('tier_blocked', '全开档语音不上传到未声明可用的转写端点');
  }
  const key = await getSecret(cfg.keyAlias);
  if (!key) throw new AsrError('not_configured', '语音识别密钥未保存');
  return transcribeWith(cfg, key, audio, opts);
}

/**
 * Core upload, config and key passed in explicitly (the settings page's test
 * button reuses this with a not-yet-saved config draft).
 */
export async function transcribeWith(
  cfg: AsrConfigVM,
  key: string,
  audio: Blob,
  opts: TranscribeOptions = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_ASR_TIMEOUT;
  const language = (opts.language ?? cfg.language ?? '').trim();
  if (opts.signal?.aborted) throw new AsrError('aborted', 'aborted');

  // Paid call, ONE per upload attempt no matter how many transport channels it
  // burns (the bridge fallback re-sends the same clip, not a new job) — M-J3.
  void recordUsage('asr', Date.now()).catch(() => {});

  // Same policy as http.ts: WebView fetch is the primary transport everywhere;
  // the native bridge exists only as a fallback for no-CORS gateways.
  const native = await nativeHttp();
  if (opts.signal?.aborted) throw new AsrError('aborted', 'aborted');

  if (!native) {
    return webTranscribe(cfg, key, audio, language, timeoutMs, opts.signal);
  }

  let fetchErr: unknown;
  try {
    return await webTranscribe(cfg, key, audio, language, timeoutMs, opts.signal);
  } catch (e) {
    if (opts.signal?.aborted || (e instanceof AsrError && e.kind === 'aborted')) throw e;
    // Protocol-level answers (auth, 429, 5xx, bad body) mean the bytes DID
    // arrive — retrying the same upload over the bridge cannot change the
    // verdict, it only doubles the bill. Only transport failures fall through.
    if (e instanceof AsrError && e.kind !== 'network' && e.kind !== 'timeout') throw e;
    fetchErr = e;
  }

  try {
    const b64 = await blobToBase64(audio);
    const entries: Array<Record<string, string>> = [
      {
        type: 'base64File',
        key: 'file',
        value: b64,
        fileName: fileNameFor(audio.type),
        contentType: audio.type || 'audio/webm',
      },
      { type: 'string', key: 'model', value: cfg.model },
      { type: 'string', key: 'response_format', value: 'json' },
    ];
    if (language) entries.push({ type: 'string', key: 'language', value: language });

    // CONSTITUTION TRAP (原生桥的"超时"必须是真拒绝): CapacitorHttp cannot be
    // aborted from JS, so this race against a REJECTING timer is the only
    // thing standing between a hung bridge call and an eternal await.
    const res = await raceDeadline(
      native.request({
        url: endpointOf(cfg.baseUrl),
        method: 'POST',
        headers: {
          // No boundary given: the Android side generates one and rewrites the
          // header itself (extractBoundaryFromContentType finds none → UUID).
          'Content-Type': 'multipart/form-data',
          Authorization: `Bearer ${key}`,
        },
        dataType: 'formData',
        data: entries,
        connectTimeout: timeoutMs,
        readTimeout: timeoutMs,
      }),
      timeoutMs,
      opts.signal,
    );
    return parseTranscription(res.status, res.data);
  } catch (bridgeErr) {
    if (opts.signal?.aborted) throw new AsrError('aborted', 'aborted');
    if (bridgeErr instanceof AsrError && bridgeErr.kind !== 'network') throw bridgeErr;
    // LlmError('timeout') from raceDeadline, or a bridge transport failure.
    const isTimeout =
      bridgeErr instanceof Error && 'kind' in bridgeErr && (bridgeErr as { kind?: string }).kind === 'timeout';
    const fe = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
    const be = bridgeErr instanceof Error ? bridgeErr.message : String(bridgeErr);
    throw new AsrError(
      isTimeout ? 'timeout' : 'network',
      `网页通道: ${fe}；原生通道: ${be}`,
    );
  }
}

/** Browser/WebView multipart upload with a real abortable deadline. */
async function webTranscribe(
  cfg: AsrConfigVM,
  key: string,
  audio: Blob,
  language: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const form = new FormData();
  // A named File (not a bare Blob) — several backends 400 on a missing filename.
  form.append('file', new File([audio], fileNameFor(audio.type), { type: audio.type || 'audio/webm' }));
  form.append('model', cfg.model);
  form.append('response_format', 'json');
  if (language) form.append('language', language);

  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort);
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(endpointOf(cfg.baseUrl), {
      method: 'POST',
      // Content-Type deliberately NOT set: fetch writes the boundary itself.
      headers: { Authorization: `Bearer ${key}` },
      body: form,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* plain-text transcription bodies are legitimate */
    }
    return parseTranscription(res.status, data);
  } catch (e) {
    if (e instanceof AsrError) throw e;
    if (signal?.aborted) throw new AsrError('aborted', 'aborted');
    if (ctrl.signal.aborted) throw new AsrError('timeout', `转写超时（${timeoutMs}ms）`);
    throw new AsrError('network', e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Normalize a provider answer (or error status) into text / AsrError. */
export function parseTranscription(status: number, data: unknown): string {
  if (status === 401 || status === 403) {
    throw new AsrError('auth', `密钥被拒（${status}）`, status);
  }
  if (status === 429) throw new AsrError('rate_limit', '限流（429）', status);
  if (status >= 500) throw new AsrError('server', `服务端错误（${status}）`, status);
  if (status >= 400) {
    throw new AsrError('bad_response', `请求被拒（${status}）：${snippet(data)}`, status);
  }
  // 2xx: OpenAI shape { text }, some gateways return the string directly.
  if (data && typeof data === 'object' && typeof (data as { text?: unknown }).text === 'string') {
    return cleanupTranscript((data as { text: string }).text);
  }
  if (typeof data === 'string') return cleanupTranscript(data);
  throw new AsrError('bad_response', `无法解析转写结果：${snippet(data)}`);
}

/**
 * Whisper-family models pad short clips with whitespace and sometimes emit
 * SenseVoice-style event tags (`<|zh|><|NEUTRAL|>…`); strip both so what lands
 * in the input box is only the words.
 */
export function cleanupTranscript(raw: string): string {
  return raw
    .replace(/<\|[^|>]*\|>/g, '')
    .replace(/\s+/g, (m) => (/[\n\r]/.test(m) ? '\n' : ' '))
    .trim();
}

function snippet(data: unknown): string {
  const s = typeof data === 'string' ? data : JSON.stringify(data);
  return (s ?? '').slice(0, 120);
}

/* ------------------------------------------------------------------ */
/* Settings-page probe                                                 */
/* ------------------------------------------------------------------ */

/**
 * Full-path test for the config page: uploads a short silent WAV through the
 * real transcribe pipeline. Success = the endpoint accepted the audio and
 * answered in the transcription shape (an empty text for silence is a PASS).
 * Mirrors `testConnection` in service.ts: answer fast or fail fast.
 */
export async function testAsrConnection(cfg: AsrConfigVM): Promise<{ ok: boolean; message: string }> {
  try {
    const key = await getSecret(cfg.keyAlias);
    if (!key) return { ok: false, message: '先保存密钥再测试' };
    const text = await transcribeWith(cfg, key, makeSilentWav(), { timeoutMs: 20_000 });
    return { ok: true, message: text ? `识别通了：「${text.slice(0, 30)}」` : '识别通了（静音样本，空结果符合预期）' };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * A deterministic 240ms 16kHz mono 16-bit PCM WAV of silence (no randomness,
 * no clock — the same bytes every run, so the probe is replayable and cheap).
 */
export function makeSilentWav(ms = 240): Blob {
  const sampleRate = 16_000;
  const samples = Math.round((sampleRate * ms) / 1000);
  const dataLen = samples * 2;
  const buf = new ArrayBuffer(44 + dataLen);
  const v = new DataView(buf);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  v.setUint32(4, 36 + dataLen, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  v.setUint32(16, 16, true); // PCM chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  writeStr(36, 'data');
  v.setUint32(40, dataLen, true);
  // Sample bytes stay zero — that IS the silence.
  return new Blob([buf], { type: 'audio/wav' });
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

/**
 * Blob → base64 without FileReader (absent in the test env) and without
 * `String.fromCharCode(...allBytes)` (blows the call stack past ~120KB —
 * a 60s opus clip is several times that). Chunked, boring, correct.
 */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
