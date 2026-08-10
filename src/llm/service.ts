/**
 * Wires the persisted provider config (ProviderVM + encrypted keys) into the M1
 * LLM layer: builds ChatProvider instances, a RoutingPolicy, and an LlmRouter.
 * This is the seam between "what the user configured" and "how a turn is run".
 */
import type { ChatProvider } from './types';
import { makeProvider, PRESETS } from './presets';
import type { OpenAiCompatibleProvider } from './openai-compatible';
import { LlmRouter, type RoutingPolicy, type RouteRequest, type RoutePlan, type Role } from './router';
import type { ProviderVM } from '../data/types';
import { getSecret } from '../lib/keystore';
import { repo } from '../db/repo';
import { Capacitor } from '@capacitor/core';

/**
 * Default model per role for a provider kind (falls back to the first model).
 *
 * An empty `models` list — a slot the user added but never pulled a catalog for,
 * or one whose catalog came back empty — used to return `undefined` typed as
 * `string`. That travelled all the way into the request body as
 * `"model": undefined`, which JSON.stringify drops, so the provider answered
 * with an opaque 400 about a missing field and the config page reported it as a
 * network problem. Fail here, where the message can name the actual cause.
 */
function modelForRole(vm: ProviderVM, role: Role): string {
  const m = vm.models;
  if (m.length === 0) {
    throw new Error(`Provider「${vm.label || vm.id}」没有配置任何模型——请先在 API 设置里拉取或填写模型 id`);
  }
  if (vm.kind === 'deepseek') {
    if (role === 'reasoning') return m.find((x) => /reasoner/i.test(x)) ?? m[0];
    return m.find((x) => /chat/i.test(x)) ?? m[0];
  }
  return m[0];
}

function buildProvider(vm: ProviderVM): ChatProvider {
  return makeProvider({
    id: vm.id,
    kind: vm.kind,
    baseUrl: vm.baseUrl,
    fallbackBaseUrl: vm.fallbackBaseUrl,
    getKey: () => getSecret(vm.keyAlias),
    defaultModels: vm.models,
    // Catalog self-heal persistence: the provider found the live model list
    // after a bad_model — store it so every later call starts from truth.
    onCatalogRefresh: (models) => {
      void repo.putProvider({ ...vm, models });
      invalidateRouter();
    },
  });
}

export interface ResolvedConfig {
  providers: ProviderVM[];
  /** Provider id chosen for everyday chat/director/memory. */
  defaultProviderId?: string;
  /** Provider id used for the NSFW-full permissive route. */
  nsfwProviderId?: string;
}

/**
 * Model ids that used to ship as preset defaults but have rotated out of the
 * providers' catalogs (requests with them 400 as "model not found"). Only a
 * list that still EXACTLY equals the stale default is migrated — a user-edited
 * list is theirs and stays untouched.
 */
const STALE_DEFAULT_MODELS: Record<string, string[][]> = {
  zen: [
    ['deepseek-v3', 'glm-4.6', 'kimi-k2'],
    ['big-pickle', 'minimax-m2.5-free'], // shipped briefly; minimax-m2.5-free rotated out
  ],
  minimax: [['MiniMax-Text-01', 'abab6.5s-chat']],
};

async function migrateStaleModels(providers: ProviderVM[]): Promise<void> {
  for (const p of providers) {
    const staleLists = STALE_DEFAULT_MODELS[p.kind];
    const fresh = PRESETS[p.kind]?.defaultModels;
    if (!staleLists || !fresh) continue;
    const isStale = staleLists.some(
      (stale) => p.models.length === stale.length && p.models.every((m, i) => m === stale[i]),
    );
    if (isStale) {
      p.models = [...fresh];
      await repo.putProvider(p);
    }
  }
}

/** Run the stale-id migration for UI surfaces that read providers directly. */
export async function ensureFreshModelDefaults(): Promise<void> {
  await migrateStaleModels(await repo.getProviders());
}

async function loadConfig(): Promise<ResolvedConfig> {
  const providers = (await repo.getProviders()).filter((p) => p.enabled);
  await migrateStaleModels(providers);
  const defaultProviderId = await repo.getSetting<string>('defaultProviderId');
  const nsfwProviderId = await repo.getSetting<string>('nsfwProviderId');
  return { providers, defaultProviderId, nsfwProviderId };
}

/** A concrete policy built from resolved config. Pure given its inputs. */
/** Channels allowed to carry full-tier NSFW context (constitution rule #6). */
const PERMISSIVE_KINDS = new Set(['zen', 'custom']);
const isPermissive = (p: ProviderVM): boolean => PERMISSIVE_KINDS.has(p.kind);

export function makePolicy(cfg: ResolvedConfig): RoutingPolicy {
  const byId = new Map(cfg.providers.map((p) => [p.id, p]));
  const pick = (id?: string): ProviderVM | undefined =>
    (id && byId.get(id)) || cfg.providers[0];

  return {
    plan(req: RouteRequest): RoutePlan {
      // The configured NSFW provider only counts if it actually IS a permissive
      // kind — an unset id must never silently fall back to providers[0], which
      // can be a domestic official endpoint.
      const configured = cfg.nsfwProviderId ? byId.get(cfg.nsfwProviderId) : undefined;
      const permissive =
        (configured && isPermissive(configured) ? configured : undefined) ??
        cfg.providers.find(isPermissive);

      // Persona-preferred provider (modelChat = "providerId:model") — but the
      // full-tier permissive routing rule always wins (constitution rule #6).
      const preferredVm = req.preferProvider ? byId.get(req.preferProvider) : undefined;
      let primaryVm: ProviderVM | undefined;
      if (req.nsfwTier === 'full') {
        // Hard constraint, not a preference: with no permissive channel there is
        // NO route — failing (→ persona refusal upstream) beats leaking context.
        if (!permissive)
          throw new Error('NSFW 全开档需要宽松通道 Provider（Zen/自定义），当前未配置');
        primaryVm = permissive;
      } else {
        primaryVm = preferredVm ?? pick(cfg.defaultProviderId);
      }
      if (!primaryVm) throw new Error('未配置任何可用的 API Provider');

      const provider = buildProvider(primaryVm);
      // The preferred model only applies when this provider actually lists it.
      const model =
        req.preferModel && primaryVm.models.includes(req.preferModel)
          ? req.preferModel
          : modelForRole(primaryVm, req.role);

      // Fallbacks: the full tier is a CLOSED set — permissive providers only,
      // domestic endpoints never appear even as a last resort. Other tiers try
      // the permissive provider first (for refusals), then the rest.
      let fbVms = cfg.providers.filter((p) => p.id !== primaryVm.id);
      if (req.nsfwTier === 'full') {
        fbVms = fbVms.filter(isPermissive);
      } else if (permissive && permissive.id !== primaryVm.id) {
        fbVms.sort((a, b) => (a.id === permissive.id ? -1 : b.id === permissive.id ? 1 : 0));
      }
      const fallbacks = fbVms.map((vm) => ({
        provider: buildProvider(vm),
        model: modelForRole(vm, req.role),
      }));

      return { provider, model, fallbacks };
    },
  };
}

let routerPromise: Promise<LlmRouter> | null = null;

/**
 * The app-wide router, built once from persisted config. A singleton is what
 * makes the permissive-chain stickiness in LlmRouter actually stick — a fresh
 * router per message forgets it (and re-reads config from IDB every turn).
 */
export function getRouter(): Promise<LlmRouter> {
  if (!routerPromise) {
    routerPromise = loadConfig().then((cfg) => new LlmRouter(makePolicy(cfg)));
    // A failed load must not poison the cache forever.
    routerPromise.catch(() => {
      routerPromise = null;
    });
  }
  return routerPromise;
}

/** Call after any provider/default/nsfw config edit so the next turn sees it. */
export function invalidateRouter(): void {
  routerPromise = null;
}

/** Whether at least one enabled provider has a stored key (i.e. chat can work). */
export async function hasUsableProvider(): Promise<boolean> {
  const cfg = await loadConfig();
  for (const p of cfg.providers) {
    if (await getSecret(p.keyAlias)) return true;
  }
  return false;
}

/**
 * Live model catalog for the config page's "拉取模型列表" button. Gateways
 * rotate catalogs (Zen especially); a stale hardcoded id 400s and looks like a
 * protocol bug. Returns [] (instead of the stale defaults) on failure so the
 * UI can tell "couldn't fetch" apart from "fetched these".
 */
export async function fetchModels(vm: ProviderVM): Promise<string[]> {
  const provider = buildProvider(vm);
  // listModelsLive answers null on failure — a successful fetch that happens to
  // equal the stored list is still a success (the old contents-comparison hack
  // reported a false error on every re-pull after the first).
  const live = await (provider as OpenAiCompatibleProvider).listModelsLive?.();
  return live ?? [];
}

/**
 * Staged network diagnosis (M-D hotfix: "测试一直卡进度" on device). Each stage
 * has its own hard deadline and reports elapsed ms + the raw error, so a hang
 * points at the exact layer: key read → catalog GET → completion POST.
 * The #1 real-world cause is a per-app proxy not covering this app — the GET
 * stage times out while the phone browser works fine.
 */
export async function diagnoseProvider(vm: ProviderVM): Promise<string[]> {
  const lines: string[] = [];
  const t = () => Date.now();

  // Stage 1: key from secure storage (hangs here = keystore/DB problem).
  let key: string | null = null;
  const t1 = t();
  try {
    key = await withDeadline(getSecret(vm.keyAlias), 5_000);
    lines.push(key ? `① 密钥读取 OK（${t() - t1}ms）` : '① 密钥读取：未保存密钥——先保存再测');
  } catch (e) {
    lines.push(`① 密钥读取卡死/失败（${t() - t1}ms）：${msg(e)}`);
    return lines;
  }
  if (!key) return lines;

  // Stage 2: the SAME origin probed over BOTH transports in parallel. This is
  // the decisive split the user asked for — "did the request even leave the
  // app?": the WebView's own fetch (no-cors, no native bridge) proves whether
  // packets can reach the host at all, independent of the CapacitorHttp path.
  const origin = (() => {
    try {
      return new URL(vm.baseUrl).origin;
    } catch {
      return vm.baseUrl;
    }
  })();
  const provider = buildProvider(vm) as OpenAiCompatibleProvider;
  // Which transport stage ② actually exercises. httpJson() only uses the native
  // bridge when Capacitor says we are native; in a browser it silently falls
  // back to fetch. Labelling it "原生通道" there is a guaranteed false
  // accusation: any provider without CORS headers (Zen has none — its OPTIONS
  // preflight 404s) makes the browser fail stage ② while ②b's no-cors probe
  // succeeds, printing "是 App 的问题" every single time.
  const isNative = Capacitor.isNativePlatform();
  const t2 = t();
  const [bridge, webview] = await Promise.all([
    withDeadline(provider.probeCatalog(), 12_000).then(
      (r) => ({
        ok: r.ok,
        ms: t() - t2,
        detail: r.ok ? `目录 ${r.models.length} 个` : (r.error ?? '未知失败'),
      }),
      (e: unknown) => ({ ok: false, ms: t() - t2, detail: msg(e) }),
    ),
    (async () => {
      const tw = t();
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 10_000);
        // no-cors: an opaque response still RESOLVES when the host answered —
        // reachability signal without CORS noise.
        await fetch(origin, { mode: 'no-cors', signal: ctrl.signal });
        clearTimeout(timer);
        return { ok: true, ms: t() - tw, detail: '有响应' };
      } catch (e) {
        return { ok: false, ms: t() - tw, detail: msg(e) };
      }
    })(),
  ]);
  const chan = isNative ? '实际请求通道（网页优先→原生兜底）' : '浏览器 fetch 通道（受 CORS 限制）';
  lines.push(`② ${chan}：${bridge.ok ? 'OK' : '失败'}（${bridge.ms}ms，${bridge.detail}）`);
  lines.push(`②b 裸可达性探针（no-cors）：${webview.ok ? 'OK' : '失败'}（${webview.ms}ms，${webview.detail}）`);

  // In a browser the split below proves nothing about the App: there is no
  // native bridge here, so stage ② is just a CORS-constrained fetch. Say that
  // instead of blaming the App.
  if (!isNative) {
    lines.push('※ 当前在浏览器里运行，没有原生桥可测——② 走的是普通 fetch。');
    if (!bridge.ok && webview.ok) {
      lines.push(
        '→ 判定：该域可达，② 的失败极可能只是浏览器 CORS（服务商未回 Access-Control-Allow-Origin）。' +
          '这**不能**说明 App 有问题——装 APK 后请求走原生桥，不受 CORS 约束。请在 App 内重跑本诊断。',
      );
      return lines;
    }
    if (!bridge.ok && !webview.ok) {
      lines.push('→ 判定：浏览器连该域都到不了——是网络/代理问题（或该域被墙），与 App 无关。');
      return lines;
    }
    if (!bridge.ok) return lines;
  } else {
    // Transport policy since the device verdict: fetch-first, bridge-fallback —
    // stage ② already tried BOTH channels in order.
    if (!bridge.ok && webview.ok) {
      lines.push(
        '→ 判定：该域可达，但网页与原生两条请求通道都失败。DeepSeek/MiniMax 支持网页直连，' +
          '本应直达；若这是不支持网页直连的服务商（如 Zen），说明它依赖的原生兜底通道在本机是坏的',
      );
      return lines;
    }
    if (!bridge.ok && !webview.ok) {
      lines.push('→ 判定：两条通道都到不了该域——App 内所有网络路径都不通（代理未覆盖 WebView 与原生栈，或断网）');
      return lines;
    }
    if (!bridge.ok) return lines;
  }

  // Stage 3: one-token completion (the full call path).
  const t3 = t();
  try {
    const res = await withDeadline(
      provider.complete({
        model: modelForRole(vm, 'chat'),
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 4,
        temperature: 0,
        timeoutMs: 15_000,
      }),
      20_000,
    );
    lines.push(`③ 对话补全 OK（${t() - t3}ms）：「${res.text.slice(0, 20)}」`);
  } catch (e) {
    lines.push(`③ 对话补全失败（${t() - t3}ms）：${msg(e)}`);
  }
  return lines;
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * UI-level hard deadline. The native bridge is supposed to time out on its own,
 * but the device symptom "spinner forever" proves some layer can still hang —
 * the UI must never trust lower layers with its own liveness.
 */
export function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`等待 ${Math.round(ms / 1000)}s 无响应——请求没有返回，通常是代理未覆盖本应用或断网`)),
        ms,
      ),
    ),
  ]);
}

/** Quick connectivity probe used by the API config page's "测试连接" button. */
export async function testConnection(vm: ProviderVM): Promise<{ ok: boolean; message: string }> {
  try {
    const provider = buildProvider(vm);
    const res = await provider.complete({
      model: modelForRole(vm, 'chat'),
      messages: [{ role: 'user', content: '你好，请只回复"ok"两个字' }],
      maxTokens: 16,
      temperature: 0,
      // A probe must answer fast or fail fast — never leave the button spinning.
      timeoutMs: 15_000,
    });
    return { ok: true, message: res.text.slice(0, 40) || '连接成功' };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
