import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * M-J3 模型面收口 — the four cleanups, each with its red-flip guard:
 *
 *   a. custom OpenAI-compatible slots are creatable AND the badge reads the
 *      router's own permissive set (no second hand-written list);
 *   b. TTS is unchained from「enabled 的 minimax 聊天槽位」— a disabled slot's
 *      key still speaks, an explicit binding wins, `ttsModel` has a writer;
 *   c. the three Moments router calls derive their tier instead of hardcoding
 *      'off' (the M-D2 breach's fourth surface, closed);
 *   d. usage counts tokens best-effort, TTS/ASR are counted, and a stream that
 *      dies pre-first-bubble no longer bills the turn twice.
 */

const settings = new Map<string, unknown>();
const secrets = new Map<string, string>();
const providers: Array<Record<string, unknown>> = [];

vi.mock('../../src/db/repo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/db/repo')>()),
  repo: {
    getSetting: async (k: string) => settings.get(k),
    putSetting: async (k: string, v: unknown) => {
      settings.set(k, v);
    },
    getProviders: async () => providers,
  },
}));

vi.mock('../../src/lib/keystore', () => ({
  getSecret: async (alias: string) => secrets.get(alias) ?? null,
  hasSecret: (alias: string) => secrets.has(alias),
  setSecret: async (alias: string, v: string) => {
    secrets.set(alias, v);
  },
  deleteSecret: (alias: string) => {
    secrets.delete(alias);
  },
}));

import {
  TTS_SETTING,
  TTS_STANDALONE_ALIAS,
  DEFAULT_TTS_BASE,
  saveTtsConfig,
  clearTtsConfig,
  resolveTtsSource,
  isTtsAvailable,
  synthesize,
} from '../../src/llm/tts';
import { transcribeWith, type AsrConfigVM } from '../../src/llm/asr';
import { recordUsage, getUsage, dayTokens, KIND_LABELS } from '../../src/lib/usage';
import { LlmRouter, tokensOf, type RoutingPolicy } from '../../src/llm/router';
import { isPermissiveKind } from '../../src/llm/service';
import type { ChatProvider, CompletionResult, Bubble, GenerateOptions } from '../../src/llm/types';

const realFetch = globalThis.fetch;
const T0 = 1_754_600_000_000;

/** Minimal MiniMax t2a_v2 happy answer (hex audio = 4 bytes). */
const T2A_OK = {
  data: { audio: 'deadbeef' },
  extra_info: { audio_length: 1200, audio_format: 'mp3' },
  base_resp: { status_code: 0 },
};

const mmSlot = (id: string, enabled: boolean, alias = `key_${id}`) => ({
  id,
  kind: 'minimax',
  label: id,
  baseUrl: 'https://api.minimaxi.com/v1',
  keyAlias: alias,
  models: ['MiniMax-M2.5'],
  enabled,
});

beforeEach(() => {
  settings.clear();
  secrets.clear();
  providers.length = 0;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* b. TTS source resolution                                            */
/* ------------------------------------------------------------------ */

describe('TTS 来源解绑（关掉 MiniMax 聊天不再失声）', () => {
  it('legacy zero-config: a DISABLED minimax slot with a stored key still resolves', async () => {
    providers.push(mmSlot('prov_minimax', false));
    secrets.set('key_prov_minimax', 'k');
    const src = await resolveTtsSource();
    expect(src?.keyAlias).toBe('key_prov_minimax');
    expect(await isTtsAvailable()).toBe(true);
  });

  it('legacy zero-config prefers an enabled slot over a disabled one', async () => {
    providers.push(mmSlot('prov_a', false), mmSlot('prov_b', true));
    secrets.set('key_prov_a', 'k');
    secrets.set('key_prov_b', 'k');
    expect((await resolveTtsSource())?.keyAlias).toBe('key_prov_b');
  });

  it('explicit binding wins over the scan, and a deleted binding degrades to it', async () => {
    providers.push(mmSlot('prov_a', true), mmSlot('prov_b', true));
    secrets.set('key_prov_a', 'k');
    secrets.set('key_prov_b', 'k');
    await saveTtsConfig({ source: 'provider', providerId: 'prov_b' });
    expect((await resolveTtsSource())?.keyAlias).toBe('key_prov_b');
    await saveTtsConfig({ source: 'provider', providerId: 'prov_gone' });
    expect((await resolveTtsSource())?.keyAlias).toBe('key_prov_a'); // fallback, not a ghost error
  });

  it('standalone mode uses its own alias and base, independent of chat slots entirely', async () => {
    await saveTtsConfig({ source: 'standalone', baseUrl: '' });
    const src = await resolveTtsSource();
    expect(src?.keyAlias).toBe(TTS_STANDALONE_ALIAS);
    expect(src?.baseUrl).toBe(DEFAULT_TTS_BASE);
    expect(await isTtsAvailable()).toBe(false); // no key yet
    secrets.set(TTS_STANDALONE_ALIAS, 'k');
    expect(await isTtsAvailable()).toBe(true);
    await clearTtsConfig();
    expect(await resolveTtsSource()).toBeNull(); // nothing else configured
  });

  it('malformed ttsConfig rows read as "not configured", never detonate', async () => {
    settings.set(TTS_SETTING, { source: 'garbage' });
    expect(await resolveTtsSource()).toBeNull();
  });

  it('synthesize hits the RESOLVED base with the stored ttsModel (the model finally has a writer)', async () => {
    await saveTtsConfig({ source: 'standalone', baseUrl: 'https://tts.example.test/v1' });
    secrets.set(TTS_STANDALONE_ALIAS, 'k');
    await settingsPut('ttsModel', 'speech-2.5-hd-preview');
    let url = '';
    let model = '';
    globalThis.fetch = vi.fn(async (u: string, init: { body: string }) => {
      url = String(u);
      model = (JSON.parse(init.body) as { model: string }).model;
      return { ok: true, status: 200, text: async () => JSON.stringify(T2A_OK) } as unknown as Response;
    }) as unknown as typeof fetch;
    const r = await synthesize({ text: '你好' });
    expect(url).toBe('https://tts.example.test/v1/t2a_v2');
    expect(model).toBe('speech-2.5-hd-preview');
    expect(r.durationMs).toBe(1200);
  });

  async function settingsPut(k: string, v: unknown) {
    settings.set(k, v);
  }
});

/* ------------------------------------------------------------------ */
/* d. usage: tokens, new kinds, single-count streams                   */
/* ------------------------------------------------------------------ */

describe('usage 升级：token 尽力而为、三类新调用、断流不重记', () => {
  it('recordUsage accumulates tokens per kind; n=0 records tokens without a call', async () => {
    await recordUsage('chat', T0, 1, 120);
    await recordUsage('chat', T0, 0, 80);
    await recordUsage('image', T0); // no tokens reported — none invented
    const { today } = await getUsage(T0);
    expect(today.counts.chat).toBe(1);
    expect(today.counts.image).toBe(1);
    expect(today.tokens?.chat).toBe(200);
    expect(today.tokens?.image).toBeUndefined();
    expect(dayTokens(today)).toBe(200);
  });

  it('rows written before the tokens field existed still read fine', async () => {
    settings.set('usage:daily', [{ day: Math.floor(T0 / 86_400_000), counts: { chat: 3 }, total: 3 }]);
    const { today } = await getUsage(T0);
    expect(today.total).toBe(3);
    expect(dayTokens(today)).toBe(0);
  });

  it('tts/asr/image are labeled kinds (the usage page draws them by this map)', () => {
    expect(KIND_LABELS.tts).toBeTruthy();
    expect(KIND_LABELS.asr).toBeTruthy();
    expect(KIND_LABELS.image).toBeTruthy();
  });

  it('synthesize counts one tts call', async () => {
    providers.push(mmSlot('prov_minimax', true));
    secrets.set('key_prov_minimax', 'k');
    globalThis.fetch = vi.fn(async () =>
      ({ ok: true, status: 200, text: async () => JSON.stringify(T2A_OK) }) as unknown as Response,
    ) as unknown as typeof fetch;
    await synthesize({ text: '你好' });
    await flush();
    const { today } = await getUsage(Date.now());
    expect(today.counts.tts).toBe(1);
  });

  it('transcribeWith counts one asr call per upload attempt', async () => {
    const cfg: AsrConfigVM = {
      kind: 'siliconflow',
      label: 's',
      baseUrl: 'https://asr.example.test/v1',
      model: 'm',
      keyAlias: 'key_asr',
    };
    globalThis.fetch = vi.fn(async () =>
      ({ ok: true, status: 200, text: async () => JSON.stringify({ text: '好' }) }) as unknown as Response,
    ) as unknown as typeof fetch;
    await transcribeWith(cfg, 'k', new Blob([new Uint8Array([1])], { type: 'audio/webm' }));
    await flush();
    const { today } = await getUsage(Date.now());
    expect(today.counts.asr).toBe(1);
  });

  it('tokensOf reads OpenAI usage defensively', () => {
    const r = (raw: unknown): CompletionResult => ({ text: 'x', finishReason: 'stop', raw });
    expect(tokensOf(r({ usage: { total_tokens: 321 } }))).toBe(321);
    expect(tokensOf(r({ usage: { total_tokens: 'many' } }))).toBe(0);
    expect(tokensOf(r({}))).toBe(0);
    expect(tokensOf(r(null))).toBe(0);
  });

  async function flush() {
    await new Promise((r) => setTimeout(r, 10));
  }
});

describe('router：计次与 token 记账', () => {
  function provider(over: Partial<ChatProvider> & { reply?: string; raw?: unknown } = {}): ChatProvider {
    return {
      id: 'p1',
      kind: 'test',
      async complete(): Promise<CompletionResult> {
        return { text: over.reply ?? '好', finishReason: 'stop', raw: over.raw };
      },
      async *generate() {},
      async listModels() {
        return ['m'];
      },
      ...over,
    } as ChatProvider;
  }

  const policyOf = (p: ChatProvider): RoutingPolicy => ({
    plan: () => ({ provider: p, model: 'm', fallbacks: [] }),
  });

  it('a successful completion records the call AND its reported tokens', async () => {
    const router = new LlmRouter(policyOf(provider({ raw: { usage: { total_tokens: 77 } } })));
    await router.complete({ role: 'chat', nsfwTier: 'off' }, { messages: [] }, {}, 'conv');
    await new Promise((r) => setTimeout(r, 10));
    const { today } = await getUsage(Date.now());
    expect(today.counts.chat).toBe(1);
    expect(today.tokens?.chat).toBe(77);
  });

  it('断流回退不重记：stream dies pre-first-bubble → ONE count for the turn', async () => {
    // The M-J3 red-flip: before the fix the streaming rung counted the turn,
    // then fell through to complete() which counted it AGAIN.
    const p = provider({
      reply: '{"type":"text","content":"重试出来的"}',
      canStream: () => true,
      generateStream: async function* (): AsyncIterable<Bubble> {
        throw new Error('dead before first bubble');
        yield undefined as never; // unreachable; satisfies require-yield
      } as unknown as (opts: GenerateOptions) => AsyncIterable<Bubble>,
    });
    const router = new LlmRouter(policyOf(p));
    const out: Bubble[] = [];
    for await (const b of router.generate({ role: 'chat', nsfwTier: 'off' }, { messages: [] }, {}, 'c1')) {
      out.push(b);
    }
    expect(out.map((b) => b.content)).toEqual(['重试出来的']);
    await new Promise((r) => setTimeout(r, 10));
    const { today } = await getUsage(Date.now());
    expect(today.counts.chat).toBe(1);
  });

  it('the non-streaming generate path still counts exactly once (no regression)', async () => {
    const router = new LlmRouter(policyOf(provider({ reply: '{"type":"text","content":"嗨"}' })));
    for await (const b of router.generate({ role: 'chat', nsfwTier: 'off' }, { messages: [] }, {}, 'c2')) {
      void b;
    }
    await new Promise((r) => setTimeout(r, 10));
    const { today } = await getUsage(Date.now());
    expect(today.counts.chat).toBe(1);
  });
});

/* ------------------------------------------------------------------ */
/* a. permissive badge reads the router's own set                      */
/* ------------------------------------------------------------------ */

describe('自定义槽位与宽松通道徽标', () => {
  it('isPermissiveKind agrees with the routing policy set (zen/custom in, domestic out)', () => {
    expect(isPermissiveKind('zen')).toBe(true);
    expect(isPermissiveKind('custom')).toBe(true);
    expect(isPermissiveKind('deepseek')).toBe(false);
    expect(isPermissiveKind('minimax')).toBe(false);
  });

  it('the config page creates kind:"custom" slots and badges via isPermissiveKind (source scan)', () => {
    const src = readFileSync(resolve(__dirname, '../../src/features/settings/ApiConfigPage.tsx'), 'utf8');
    expect(src).toContain("kind: 'custom'");
    expect(src).toContain('isPermissiveKind(p.kind)');
  });
});

/* ------------------------------------------------------------------ */
/* c. Moments router tier is derived, not declared                     */
/* ------------------------------------------------------------------ */

describe('朋友圈三处 router tier 改真推导（M-D2 的第四个破口，封上）', () => {
  const src = () => readFileSync(resolve(__dirname, '../../src/ai/moments-engine.ts'), 'utf8');

  it('no router call in moments-engine declares a literal tier anymore', () => {
    // The PROMPT layer legitimately pins 'off' (feed content is unconditionally
    // SFW); the ROUTER calls must not. Scan the request objects specifically.
    expect(src()).not.toMatch(/role:\s*'chat',\s*nsfwTier:\s*'/);
    const derived = src().match(/role:\s*'chat',\s*nsfwTier:\s*tier/g) ?? [];
    expect(derived.length).toBe(3); // post + comment + repost text
  });

  it('the derivation is maxTier over (global, persona) — the handlers.ts precedent', async () => {
    const { momentRouteTier } = await import('../../src/ai/moments-engine');
    const { makePersona } = await import('../../src/data/persona-defaults');
    settings.set('nsfwGlobalTier', 'full');
    expect(await momentRouteTier(makePersona({ contactId: 'a', core: 'c', nsfwPermit: true }))).toBe('full');
    expect(await momentRouteTier(makePersona({ contactId: 'a', core: 'c', nsfwPermit: false }))).toBe('off');
    settings.set('nsfwGlobalTier', 'off');
    expect(await momentRouteTier(makePersona({ contactId: 'a', core: 'c', nsfwPermit: true }))).toBe('off');
  });
});

/* ------------------------------------------------------------------ */
/* TTS page wiring                                                     */
/* ------------------------------------------------------------------ */

describe('TTS 设置页接线（写了没接线=没做）', () => {
  it('the page exists, writes ttsModel, and the app mounts /settings/tts', () => {
    const page = readFileSync(
      resolve(__dirname, '../../src/features/settings/TtsConfigPage.tsx'),
      'utf8',
    );
    expect(page).toContain("putSetting('ttsModel'");
    expect(page).toContain('saveTtsConfig');
    const app = readFileSync(resolve(__dirname, '../../src/App.tsx'), 'utf8');
    expect(app).toContain('path="/settings/tts"');
    const entry = readFileSync(
      resolve(__dirname, '../../src/features/settings/SettingsPage.tsx'),
      'utf8',
    );
    expect(entry).toContain("navigate('/settings/tts')");
  });
});
