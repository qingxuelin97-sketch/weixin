/**
 * LLM 配置的轻量门面 (M-L1，从 service.ts 抽出)。
 *
 * 页面在**渲染时**或保存时要用的那几样——读配置、有没有可用的模型、给原生调用设硬
 * 截止、某种 Provider 是不是宽松通道、改了配置让路由器下次重建——都在这里，而且这个
 * 文件**不许**引入路由器、Provider 类、bubbles 或 zod（守卫：l1-lean-main.test.ts）。
 * 真正去调模型的东西（getRouter / testConnection / fetchModels / diagnoseProvider）
 * 仍在 service.ts，页面在按钮按下时经 app/ai-runtime 这一个懒入口拿它们。
 *
 * 此前 ChatPage 为了一个 hasUsableProvider、两个语音设置页为了一个 withDeadline，
 * 静态导入 service.ts，于是路由器、三家 Provider、多气泡解析与 zod 都在每一次冷启动里。
 */
import { PRESETS } from './preset-data';
import type { ProviderVM } from '../data/types';
import { getSecret } from '../lib/keystore';
import { repo } from '../db/repo';

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

export async function loadConfig(): Promise<ResolvedConfig> {
  const providers = (await repo.getProviders()).filter((p) => p.enabled);
  await migrateStaleModels(providers);
  const defaultProviderId = await repo.getSetting<string>('defaultProviderId');
  const nsfwProviderId = await repo.getSetting<string>('nsfwProviderId');
  return { providers, defaultProviderId, nsfwProviderId };
}

/** Channels allowed to carry full-tier NSFW context (constitution rule #6). */
const PERMISSIVE_KINDS = new Set(['zen', 'custom']);
export const isPermissive = (p: ProviderVM): boolean => PERMISSIVE_KINDS.has(p.kind);

/**
 * Whether a provider KIND qualifies as a permissive channel (M-J3, for the
 * config page's badge). Exported as a function over the same set the policy
 * reads, so the badge can never say one thing while the router does another.
 */
export const isPermissiveKind = (kind: string): boolean => PERMISSIVE_KINDS.has(kind);

/**
 * Config epoch (M-L1): bumped by every provider/default/nsfw edit. The router
 * singleton in service.ts remembers the epoch it was built at and rebuilds when
 * they differ — which is how a config page can invalidate the router without
 * importing it.
 */
let epoch = 0;
export const configEpoch = (): number => epoch;

/** Call after any provider/default/nsfw config edit so the next turn sees it. */
export function invalidateRouter(): void {
  epoch++;
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
