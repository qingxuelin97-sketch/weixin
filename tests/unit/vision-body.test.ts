/**
 * M-J0 red-guards for the request-body vision path.
 *
 * Two bugs hid here for a whole round:
 *  1. DeepSeekProvider.buildBody rebuilt `messages` from opts.messages to add
 *     the prefix flag — silently DROPPING the multi-part (text + image_url)
 *     bodies the base class had just built. Break the fix and the first test
 *     goes red.
 *  2. modelSupportsVision guessed by name only; a per-slot declaration now
 *     overrides it (covered in nsfw-callsite.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { DeepSeekProvider } from '../../src/llm/presets';
import { OpenAiCompatibleProvider, type ProviderConfig } from '../../src/llm/openai-compatible';
import type { GenerateOptions } from '../../src/llm/types';

const IMG = 'data:image/jpeg;base64,AAAA';

function cfg(extra?: Partial<ProviderConfig>): ProviderConfig {
  return {
    id: 'p1',
    kind: 'deepseek',
    baseUrl: 'https://example.invalid',
    getKey: async () => 'k',
    ...extra,
  };
}

function opts(extra?: Partial<GenerateOptions>): GenerateOptions {
  return {
    model: 'some-model',
    messages: [
      { role: 'system', content: 'S' },
      { role: 'user', content: '这是什么' },
    ],
    images: [IMG],
    ...extra,
  } as GenerateOptions;
}

type BodyBuilder = { buildBody(o: GenerateOptions): Record<string, unknown> };
const build = (p: object, o: GenerateOptions) => (p as unknown as BodyBuilder).buildBody(o);

function lastUserContent(body: Record<string, unknown>): unknown {
  const msgs = body.messages as Array<{ role: string; content: unknown }>;
  return [...msgs].reverse().find((m) => m.role === 'user')?.content;
}

describe('vision request body (M-J0)', () => {
  it('DeepSeek subclass preserves image parts built by the base class', () => {
    const p = new DeepSeekProvider(cfg({ visionModels: ['some-model'] }));
    const content = lastUserContent(build(p, opts()));
    expect(Array.isArray(content)).toBe(true);
    const parts = content as Array<{ type: string }>;
    expect(parts.some((x) => x.type === 'image_url')).toBe(true);
    expect(parts[parts.length - 1]).toMatchObject({ type: 'text', text: '这是什么' });
  });

  it('DeepSeek subclass still stamps the prefix flag on the right message', () => {
    const p = new DeepSeekProvider(cfg({ visionModels: ['some-model'] }));
    const body = build(
      p,
      opts({
        messages: [
          { role: 'user', content: '嗯' },
          { role: 'assistant', content: '好的，', prefix: true },
        ],
        images: [],
      }),
    );
    const msgs = body.messages as Array<Record<string, unknown>>;
    expect(msgs[1].prefix).toBe(true);
    expect(msgs[0].prefix).toBeUndefined();
  });

  it('a declared vision list gates the base adapter in both directions', () => {
    const yes = new OpenAiCompatibleProvider(cfg({ visionModels: ['some-model'] }));
    expect(Array.isArray(lastUserContent(build(yes, opts())))).toBe(true);
    // Same model name, but NOT in the declared list → plain text body.
    const no = new OpenAiCompatibleProvider(cfg({ visionModels: ['other-model'] }));
    expect(lastUserContent(build(no, opts()))).toBe('这是什么');
  });
});
