/**
 * Wires the persisted provider config (ProviderVM + encrypted keys) into the M1
 * LLM layer: builds ChatProvider instances, a RoutingPolicy, and an LlmRouter.
 * This is the seam between "what the user configured" and "how a turn is run".
 */
import type { ChatProvider } from './types';
import { makeProvider } from './presets';
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
  });
}

export interface ResolvedConfig {
  providers: ProviderVM[];
  /** Provider id chosen for everyday chat/director/memory. */
  defaultProviderId?: string;
  /** Provider id used for the NSFW-full permissive route. */
  nsfwProviderId?: string;
}

async function loadConfig(): Promise<ResolvedConfig> {
  const providers = (await repo.getProviders()).filter((p) => p.enabled);
  const defaultProviderId = await repo.getSetting<string>('defaultProviderId');
  const nsfwProviderId = await repo.getSetting<string>('nsfwProviderId');
  return { providers, defaultProviderId, nsfwProviderId };
}

/** A concrete policy built from resolved config. Pure given its inputs. */
export function makePolicy(cfg: ResolvedConfig): RoutingPolicy {
  const byId = new Map(cfg.providers.map((p) => [p.id, p]));
  const pick = (id?: string): ProviderVM | undefined =>
    (id && byId.get(id)) || cfg.providers[0];

  return {
    plan(req: RouteRequest): RoutePlan {
      const permissive =
        pick(cfg.nsfwProviderId) ??
        cfg.providers.find((p) => p.kind === 'zen' || p.kind === 'custom') ??
        cfg.providers[0];
      const primaryVm = req.nsfwTier === 'full' ? permissive : pick(cfg.defaultProviderId);
      if (!primaryVm) throw new Error('未配置任何可用的 API Provider');

      const provider = buildProvider(primaryVm);
      const model = req.preferModel ?? modelForRole(primaryVm, req.role);

      // Fallbacks: the permissive provider first (for refusals), then the rest.
      const fbVms = cfg.providers.filter((p) => p.id !== primaryVm.id);
      if (permissive && permissive.id !== primaryVm.id) {
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

/** Build a router from the currently-persisted config. Rebuild after config edits. */
export async function getRouter(): Promise<LlmRouter> {
  const cfg = await loadConfig();
  return new LlmRouter(makePolicy(cfg));
}

/** Whether at least one enabled provider has a stored key (i.e. chat can work). */
export async function hasUsableProvider(): Promise<boolean> {
  const cfg = await loadConfig();
  for (const p of cfg.providers) {
    if (await getSecret(p.keyAlias)) return true;
  }
  return false;
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
    });
    return { ok: true, message: res.text.slice(0, 40) || '连接成功' };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}
