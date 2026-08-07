import { describe, it, expect } from 'vitest';
import { LlmRouter, isRefusal, type RoutingPolicy, type RoutePlan } from '../../src/llm/router';
import type { ChatProvider, GenerateOptions, CompletionResult, Bubble } from '../../src/llm/types';

/** A scripted provider that returns queued completions in order. */
class FakeProvider implements ChatProvider {
  constructor(
    public readonly id: string,
    private queue: Array<CompletionResult | Error>,
  ) {}
  readonly kind = 'fake';
  async complete(_opts: GenerateOptions): Promise<CompletionResult> {
    const next = this.queue.shift();
    if (!next) throw new Error('queue empty');
    if (next instanceof Error) throw next;
    return next;
  }
  async *generate(): AsyncIterable<Bubble> {
    /* not used in these tests */
  }
  async listModels() {
    return [];
  }
}

const ok = (text: string): CompletionResult => ({ text, finishReason: 'stop' });
const refused = (): CompletionResult => ({ text: '抱歉，我无法继续这个话题', finishReason: 'content_filter' });

function policyWith(primary: ChatProvider, fallbacks: Array<{ provider: ChatProvider; model: string }>): RoutingPolicy {
  return {
    plan(): RoutePlan {
      return { provider: primary, model: 'm-primary', fallbacks };
    },
  };
}

describe('isRefusal', () => {
  it('flags content_filter finish reason', () => {
    expect(isRefusal({ text: 'anything', finishReason: 'content_filter' })).toBe(true);
  });
  it('flags short refusal prose', () => {
    expect(isRefusal({ text: '作为一个AI，我不能这样做', finishReason: 'stop' })).toBe(true);
  });
  it('flags empty output', () => {
    expect(isRefusal({ text: '   ', finishReason: 'stop' })).toBe(true);
  });
  it('passes normal content', () => {
    expect(isRefusal({ text: '好呀，我们聊聊', finishReason: 'stop' })).toBe(false);
  });
});

describe('LlmRouter degradation ladder', () => {
  it('returns the primary result when it does not refuse', async () => {
    const primary = new FakeProvider('p', [ok('你好呀')]);
    const router = new LlmRouter(policyWith(primary, []));
    const r = await router.complete({ role: 'chat', nsfwTier: 'off' }, { messages: [] });
    expect(r.text).toBe('你好呀');
  });

  it('falls through to a permissive fallback on refusal and pins it sticky', async () => {
    const primary = new FakeProvider('p', [refused(), refused()]);
    const fb = new FakeProvider('zen', [ok('当然可以'), ok('第二条也走这里')]);
    const router = new LlmRouter(policyWith(primary, [{ provider: fb, model: 'glm' }]));

    const r1 = await router.complete({ role: 'chat', nsfwTier: 'full' }, { messages: [] }, {}, 'conv1');
    expect(r1.text).toBe('当然可以');

    // Next call for the same conv should hit the sticky fallback directly.
    const r2 = await router.complete({ role: 'chat', nsfwTier: 'full' }, { messages: [] }, {}, 'conv1');
    expect(r2.text).toBe('第二条也走这里');
  });

  it('tier-1 soften+prefill can rescue without switching providers', async () => {
    const primary = new FakeProvider('p', [refused(), ok('好的我们继续')]);
    const router = new LlmRouter(policyWith(primary, []));
    const r = await router.complete(
      { role: 'chat', nsfwTier: 'ambiguous' },
      { messages: [{ role: 'user', content: '...' }] },
      { prefixPrefill: '嗯' },
    );
    expect(r.text).toBe('好的我们继续');
  });

  it('yields persona refusal bubbles when the whole ladder fails', async () => {
    const primary = new FakeProvider('p', [refused(), refused()]);
    const router = new LlmRouter(policyWith(primary, []));
    const bubbles: Bubble[] = [];
    for await (const b of router.generate(
      { role: 'chat', nsfwTier: 'full' },
      { messages: [] },
      { personaRefusal: () => [{ type: 'text', content: '讨厌啦～不要问这个' }] },
    )) {
      bubbles.push(b);
    }
    expect(bubbles).toEqual([{ type: 'text', content: '讨厌啦～不要问这个' }]);
  });

  it('does not ladder on an auth error', async () => {
    const { LlmError } = await import('../../src/llm/types');
    const primary = new FakeProvider('p', [new LlmError('auth', 'bad key')]);
    const fb = new FakeProvider('zen', [ok('should not reach')]);
    const router = new LlmRouter(policyWith(primary, [{ provider: fb, model: 'glm' }]));
    await expect(router.complete({ role: 'chat', nsfwTier: 'off' }, { messages: [] })).rejects.toThrow();
  });
});
