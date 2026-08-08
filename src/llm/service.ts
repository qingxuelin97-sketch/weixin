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

/** Default model per role for a provider kind (falls back to the first model). */
function modelForRole(vm: ProviderVM, role: Role): string {
  const m = vm.models;
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
  const t2 = t();
  const [bridge, webview] = await Promise.all([
    withDeadline(provider.listModelsLive(), 12_000).then(
      (ids) => ({ ok: ids != null && ids.length > 0, ms: t() - t2, detail: ids ? `目录 ${ids.length} 个` : '无目录' }),
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
  lines.push(
    `② 原生通道（App 发请求走的路）：${bridge.ok ? 'OK' : '失败'}（${bridge.ms}ms，${bridge.detail}）`,
  );
  lines.push(`②b WebView 通道（不走原生桥）：${webview.ok ? 'OK' : '失败'}（${webview.ms}ms，${webview.detail}）`);
  if (!bridge.ok && webview.ok) {
    lines.push('→ 判定：手机到服务商的网络是通的，但 App 的原生请求通道坏了/没发出去——是 App 的问题，不是代理的问题');
    return lines;
  }
  if (!bridge.ok && !webview.ok) {
    lines.push('→ 判定：两条通道都到不了该域——App 内所有网络路径都不通（代理未覆盖 WebView 与原生栈，或断网）');
    return lines;
  }
  if (!bridge.ok) return lines;

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
