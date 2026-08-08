import { describe, it, expect } from 'vitest';
import { makePolicy, type ResolvedConfig } from '../../src/llm/service';
import { LlmRouter, type RoutingPolicy, type RoutePlan } from '../../src/llm/router';
import type { ChatProvider, GenerateOptions, CompletionResult, Bubble } from '../../src/llm/types';
import type { ProviderVM } from '../../src/data/types';

/**
 * Constitution rule #6 closure (M-C1 P0): full-tier NSFW context must NEVER
 * reach a domestic official endpoint (deepseek/minimax) — not via the primary
 * route, not via the fallback ladder, and not via a sticky pin created on a
 * lower tier. These tests were written against two real leaks:
 *   - makePolicy built full-tier fallbacks from ALL providers (unfiltered), and
 *     an unset nsfwProviderId silently fell back to providers[0];
 *   - LlmRouter's sticky pin ignored the tier, so a domestic pin from an
 *     'off'-tier refusal would carry later full-tier turns.
 */

const prov = (id: string, kind: ProviderVM['kind'], models: string[]): ProviderVM => ({
  id,
  kind,
  label: id,
  baseUrl: `https://${id}.test/v1`,
  keyAlias: `key_${id}`,
  models,
  enabled: true,
});

const DOMESTIC_KINDS = ['deepseek', 'minimax'];

describe('makePolicy full-tier closure (rule #6)', () => {
  const fullHouse: ResolvedConfig = {
    providers: [
      prov('prov_deepseek', 'deepseek', ['deepseek-chat']),
      prov('prov_minimax', 'minimax', ['MiniMax-M2.5']),
      prov('prov_zen', 'zen', ['big-pickle']),
      prov('prov_custom', 'custom', ['whatever']),
    ],
    defaultProviderId: 'prov_deepseek',
    nsfwProviderId: 'prov_zen',
  };

  it('full-tier primary AND every fallback are permissive-only', () => {
    const plan = makePolicy(fullHouse).plan({ role: 'chat', nsfwTier: 'full' });
    expect(DOMESTIC_KINDS).not.toContain(plan.provider.kind);
    for (const fb of plan.fallbacks) {
      expect(DOMESTIC_KINDS).not.toContain(fb.provider.kind);
    }
    // The permissive custom slot IS still available as a fallback.
    expect(plan.fallbacks.map((f) => f.provider.id)).toEqual(['prov_custom']);
  });

  it('an unset nsfwProviderId must not fall back to providers[0] (domestic)', () => {
    const plan = makePolicy({ ...fullHouse, nsfwProviderId: undefined }).plan({
      role: 'chat',
      nsfwTier: 'full',
    });
    expect(plan.provider.id).toBe('prov_zen');
  });

  it('a misconfigured nsfwProviderId pointing at a domestic provider is ignored', () => {
    const plan = makePolicy({ ...fullHouse, nsfwProviderId: 'prov_deepseek' }).plan({
      role: 'chat',
      nsfwTier: 'full',
    });
    expect(DOMESTIC_KINDS).not.toContain(plan.provider.kind);
  });

  it('full tier with zero permissive providers throws instead of leaking', () => {
    const domesticOnly: ResolvedConfig = {
      providers: [prov('prov_deepseek', 'deepseek', ['deepseek-chat'])],
      defaultProviderId: 'prov_deepseek',
    };
    expect(() => makePolicy(domesticOnly).plan({ role: 'chat', nsfwTier: 'full' })).toThrow(
      /宽松通道/,
    );
  });

  it('lower tiers keep the full ladder with the permissive provider first', () => {
    const plan = makePolicy(fullHouse).plan({ role: 'chat', nsfwTier: 'off' });
    expect(plan.provider.id).toBe('prov_deepseek');
    expect(plan.fallbacks[0].provider.id).toBe('prov_zen');
    // Domestic minimax is still allowed as a later fallback on non-full tiers.
    expect(plan.fallbacks.map((f) => f.provider.id)).toContain('prov_minimax');
  });
});

/** Counts calls so tests can assert a provider was NEVER touched. */
class CountingProvider implements ChatProvider {
  calls = 0;
  constructor(
    public readonly id: string,
    public readonly kind: string,
    private script: (n: number) => CompletionResult,
  ) {}
  async complete(_opts: GenerateOptions): Promise<CompletionResult> {
    this.calls++;
    return this.script(this.calls);
  }
  async *generate(): AsyncIterable<Bubble> {
    /* unused */
  }
  async listModels() {
    return [];
  }
}

const ok = (text: string): CompletionResult => ({ text, finishReason: 'stop' });
const refused = (): CompletionResult => ({
  text: '抱歉，我无法继续这个话题',
  finishReason: 'content_filter',
});

describe('LlmRouter sticky pins are tier-scoped (rule #6)', () => {
  it('a domestic pin from an off-tier refusal never serves a full-tier turn', async () => {
    // off tier: primary refuses → domestic fallback succeeds → pinned (off only).
    const offPrimary = new CountingProvider('p_off', 'zen', () => refused());
    const domestic = new CountingProvider('p_ds', 'deepseek', () => ok('国内端点回复'));
    const permissive = new CountingProvider('p_zen', 'zen', () => ok('宽松通道回复'));

    const policy: RoutingPolicy = {
      plan(req): RoutePlan {
        if (req.nsfwTier === 'full')
          return { provider: permissive, model: 'z', fallbacks: [] };
        return { provider: offPrimary, model: 'm', fallbacks: [{ provider: domestic, model: 'd' }] };
      },
    };
    const router = new LlmRouter(policy);

    const r1 = await router.complete({ role: 'chat', nsfwTier: 'off' }, { messages: [] }, {}, 'conv1');
    expect(r1.text).toBe('国内端点回复'); // pin now exists for (conv1, off)

    const r2 = await router.complete({ role: 'chat', nsfwTier: 'full' }, { messages: [] }, {}, 'conv1');
    expect(r2.text).toBe('宽松通道回复');
    // The leak this pins down: pre-fix, the off-tier pin carried the full turn.
    expect(domestic.calls).toBe(1);

    // The off-tier pin still works within its own tier.
    const r3 = await router.complete({ role: 'chat', nsfwTier: 'off' }, { messages: [] }, {}, 'conv1');
    expect(r3.text).toBe('国内端点回复');
    expect(domestic.calls).toBe(2);
  });

  it('clearSticky removes pins across every tier of the conversation', async () => {
    const primary = new CountingProvider('p', 'zen', (n) => (n === 1 ? refused() : ok('primary 恢复了')));
    const fb = new CountingProvider('fb', 'custom', () => ok('fallback'));
    const policy: RoutingPolicy = {
      plan(): RoutePlan {
        return { provider: primary, model: 'm', fallbacks: [{ provider: fb, model: 'f' }] };
      },
    };
    const router = new LlmRouter(policy);

    await router.complete({ role: 'chat', nsfwTier: 'ambiguous' }, { messages: [] }, {}, 'conv9');
    expect(fb.calls).toBe(1); // pinned at (conv9, ambiguous)

    router.clearSticky('conv9');
    const r = await router.complete({ role: 'chat', nsfwTier: 'ambiguous' }, { messages: [] }, {}, 'conv9');
    expect(r.text).toBe('primary 恢复了'); // pin gone → back to primary
    expect(fb.calls).toBe(1);
  });
});
