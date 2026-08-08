import { describe, it, expect } from 'vitest';
import { makePolicy, type ResolvedConfig } from '../../src/llm/service';
import { preferredRoute } from '../../src/ai/engine';
import type { ProviderVM } from '../../src/data/types';

/**
 * Per-persona model routing (bug #2: modelChat existed in the schema and the
 * editor now exposes it — these pin the rules that make it actually route):
 *  - "providerId:model" steers both provider and model,
 *  - the full NSFW tier ALWAYS wins over a persona preference (rule #6),
 *  - a model the provider doesn't list falls back to the role default.
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

const cfg: ResolvedConfig = {
  providers: [
    prov('prov_deepseek', 'deepseek', ['deepseek-chat', 'deepseek-reasoner']),
    prov('prov_zen', 'zen', ['zen-large']),
  ],
  defaultProviderId: 'prov_deepseek',
  nsfwProviderId: 'prov_zen',
};

describe('preferredRoute', () => {
  it('splits providerId:model, passes bare model through, handles empty', () => {
    expect(preferredRoute('prov_zen:zen-large')).toEqual({
      preferProvider: 'prov_zen',
      preferModel: 'zen-large',
    });
    expect(preferredRoute('deepseek-chat')).toEqual({ preferModel: 'deepseek-chat' });
    expect(preferredRoute(undefined)).toEqual({});
  });
});

describe('makePolicy with persona preference', () => {
  it('routes to the preferred provider and model', () => {
    const plan = makePolicy(cfg).plan({
      role: 'chat',
      nsfwTier: 'off',
      preferProvider: 'prov_zen',
      preferModel: 'zen-large',
    });
    expect(plan.provider.id).toBe('prov_zen');
    expect(plan.model).toBe('zen-large');
  });

  it('the full tier overrides any persona preference (constitution rule #6)', () => {
    const plan = makePolicy(cfg).plan({
      role: 'chat',
      nsfwTier: 'full',
      preferProvider: 'prov_deepseek',
      preferModel: 'deepseek-chat',
    });
    // The permissive channel wins; the mainland provider must not be chosen.
    expect(plan.provider.id).toBe('prov_zen');
  });

  it('an unlisted preferred model falls back to the role default', () => {
    const plan = makePolicy(cfg).plan({
      role: 'chat',
      nsfwTier: 'off',
      preferProvider: 'prov_deepseek',
      preferModel: 'gpt-oops-not-here',
    });
    expect(plan.provider.id).toBe('prov_deepseek');
    expect(plan.model).toBe('deepseek-chat');
  });

  it('an unknown preferred provider falls back to the configured default', () => {
    const plan = makePolicy(cfg).plan({
      role: 'chat',
      nsfwTier: 'off',
      preferProvider: 'prov_deleted',
    });
    expect(plan.provider.id).toBe('prov_deepseek');
  });
});
