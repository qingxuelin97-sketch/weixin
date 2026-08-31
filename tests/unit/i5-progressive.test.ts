import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MessageVM, ContactVM, ConversationVM } from '../../src/data/types';
import type { Bubble } from '../../src/llm/types';

/**
 * M-I5 的另一半：渐进上屏 + 流中断的人设化截断。
 *
 * I5 交付了传输层真流式（SSE 按气泡边界逐个 yield），但引擎仍是 drain-then-play，
 * 于是**用户感知与上流式之前完全一样**——第一条气泡还是要等整轮生成结束才出现。
 * 这个文件锁的就是那半步，以及它不许弄坏的三件事：
 *
 *   ① 第一条气泡上屏**早于**最后一条气泡产出（drain-then-play 直接转红）；
 *   ② 首气泡之后断流 → 追加人设化收尾，且**不碰降级链**（已说出的话收不回）；
 *   ③ 中断后不再有任何气泡上屏；
 *   ④ 非流式 Provider（一次性 yield 全部气泡）的节奏与行为不变。
 */

/* ------------------------- a repo that is just enough ------------------------- */

const settings = new Map<string, unknown>();
/** Message rows written this test, doubling as the transcript the engines read. */
const rows: Array<Omit<MessageVM, 'id'>> = [];
/** Anything not named below answers with an empty list — nothing here reads rows. */
// Passthrough mock: replacing this module WHOLESALE drops its non-repo
// exports (REL_PAIR_SEP, SETTINGS_KEY_CASCADE…), and a consumer importing
// one of those then breaks the whole module graph — which surfaces as an
// unrelated test returning nothing at all rather than as a missing export.
vi.mock('../../src/db/repo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/db/repo')>()),
  repo: new Proxy(
    {
      getSetting: async (k: string) => settings.get(k),
      putSetting: async (k: string, v: unknown) => void settings.set(k, v),
      // The transcript is whatever this turn has already written — the group
      // path needs to actually SEE the user's line to cast anybody.
      getMessages: async (convId: string) =>
        rows.filter((r) => r.convId === convId).map((r, i) => ({ ...r, id: i + 1 })),
      getConvSummary: async () => undefined,
      firstMessageAt: async () => undefined,
      getContact: async (id: string) => ({ id, name: id }),
    } as Record<string, unknown>,
    { get: (t, k: string) => t[k] ?? (async () => []) },
  ),
}));
vi.mock('../../src/lib/sound', () => ({ playMessageSound: () => {} }));
vi.mock('../../src/lib/voice', () => ({ ensureVoiceAudio: async () => null }));

/** The router the engine will get. Each test installs its own bubble source. */
let routerGenerate: (
  req: unknown,
  opts: unknown,
  ctx: { personaRefusal?: () => Bubble[]; personaTruncation?: () => Bubble[] },
) => AsyncIterable<Bubble>;
vi.mock('../../src/llm/service', () => ({
  getRouter: async () => ({ generate: (...a: unknown[]) => routerGenerate(a[0], a[1], a[2] as never) }),
}));

import { sendUserMessage, abortConversation } from '../../src/ai/engine';
import { sendGroupMessage } from '../../src/ai/group-engine';
import { playbackFeed } from '../../src/ai/bubble-feed';
import { LlmRouter, type RoutingPolicy } from '../../src/llm/router';
import { LlmError, type ChatProvider, type CompletionResult } from '../../src/llm/types';
import { makePersona } from '../../src/data/persona-defaults';

const T0 = new Date(2026, 4, 10, 15, 0).getTime();
const CONV = 'c_lin';
const PEER: ContactVM = {
  id: 'ai_lin',
  type: 'ai',
  name: '林晚',
  avatarColor: '#111111',
  avatarText: '林',
};
// A fast typist: the pacing model is not what these tests are about, and the
// engine's own 250ms floor still applies to the first bubble either way.
const PERSONA = makePersona({ contactId: PEER.id, core: '测试人设', typingCpm: 60_000 });

/** What actually reached the screen, in order, with the real time it landed. */
const appended: Array<{ msg: Omit<MessageVM, 'id'>; at: number }> = [];
const log: string[] = [];
const hooks = {
  appendMessage: async (m: Omit<MessageVM, 'id'>) => {
    appended.push({ msg: m, at: Date.now() });
    rows.push(m);
    if (m.senderId !== 'self') log.push(`append:${m.content}`);
    return { ...m, id: appended.length } as MessageVM;
  },
  updateMessage: async () => {},
  setTyping: () => {},
  // Injected clock (rule #4): the engine never reads the wall clock itself.
  now: () => T0,
};

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

beforeEach(() => {
  appended.length = 0;
  rows.length = 0;
  log.length = 0;
  settings.clear();
});

/** Replies from the AI only — the user's own row is appended first. */
const aiLines = (from = PEER.id) =>
  appended.filter((a) => a.msg.senderId === from).map((a) => a.msg.content);

/* ------------------------------- ① 渐进上屏 ------------------------------- */

describe('渐进上屏：边收边播，不是收完再播', () => {
  it('第一条气泡上屏早于最后一条气泡产出', async () => {
    // A stream that writes like a model does: one whole bubble, a pause, the
    // next. `delay: 0` keeps the typing pacing out of the measurement — the
    // engine still enforces its own 250ms floor on the first bubble.
    const GAP = 400;
    routerGenerate = async function* () {
      for (const n of [1, 2, 3]) {
        if (n > 1) await wait(GAP);
        log.push(`produce:${n}`);
        yield { type: 'text', content: `第${n}条`, delay: 0 } as Bubble;
      }
    };

    await sendUserMessage(CONV, '在吗', PEER, PERSONA, 'off', hooks);

    expect(aiLines()).toEqual(['第1条', '第2条', '第3条']);
    // THE assertion: drain-then-play puts every produce before every append,
    // so this comparison is exactly the difference between the two designs.
    expect(log.indexOf('append:第1条')).toBeLessThan(log.indexOf('produce:3'));
    expect(log.indexOf('append:第1条')).toBeGreaterThan(-1);
  });

  it('非流式 Provider（一次性 yield 全部气泡）行为不变', async () => {
    // The native transport hands over the whole set in one tick. Progressive
    // playback degrades to exactly the old loop: same order, same pacing floor,
    // and the queue is full before the first typing delay even elapses.
    routerGenerate = async function* () {
      log.push('produce:all');
      yield { type: 'text', content: 'a', delay: 0 } as Bubble;
      yield { type: 'text', content: 'bbbb', delay: 0 } as Bubble;
      yield { type: 'sticker', content: '[微笑]', delay: 0 } as Bubble;
    };

    const t0 = Date.now();
    await sendUserMessage(CONV, '在吗', PEER, PERSONA, 'off', hooks);
    expect(aiLines()).toEqual(['a', 'bbbb', '[微笑]']);
    expect(log[0]).toBe('produce:all');
    // The first bubble still pays the 250ms floor rather than landing instantly.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
  });

  it('anti-AI scrub 仍按完整气泡跑：重复的整条被丢，剩下的照播', async () => {
    routerGenerate = async function* () {
      yield { type: 'text', content: '今天天气真的很好啊', delay: 0 } as Bubble;
      yield { type: 'text', content: '今天天气真的很好啊', delay: 0 } as Bubble;
      yield { type: 'text', content: '你在干嘛呢', delay: 0 } as Bubble;
    };
    await sendUserMessage(CONV, '在吗', PEER, PERSONA, 'off', hooks);
    expect(aiLines()).toEqual(['今天天气真的很好啊', '你在干嘛呢']);
  });
});

describe('群聊也边收边播', () => {
  it('被 @ 的成员第一条就上屏，不等她把三条写完', async () => {
    const GAP = 400;
    routerGenerate = async function* () {
      for (const n of [1, 2, 3]) {
        if (n > 1) await wait(GAP);
        log.push(`produce:${n}`);
        yield { type: 'text', content: `群第${n}条`, delay: 0 } as Bubble;
      }
    };

    const conv: ConversationVM = {
      id: 'g_1',
      type: 'group',
      title: '测试群',
      avatarColor: '#222222',
      avatarText: '群',
      memberIds: [PEER.id],
      isPinned: false,
      isMuted: false,
      unreadCount: 0,
      mentionMe: false,
      lastMsgPreview: '',
      lastMsgAt: T0,
    };
    const members = [{ contactId: PEER.id, name: PEER.name, persona: PERSONA }];
    // An @mention casts her outright — no director call, so this test never
    // needs a second LLM fixture just to decide who talks.
    await sendGroupMessage(
      conv,
      `@${PEER.name} 在吗`,
      members,
      'off',
      hooks,
      (id) => (id === PEER.id ? PEER : undefined),
    );

    expect(aiLines()).toEqual(['群第1条', '群第2条', '群第3条']);
    expect(log.indexOf('append:群第1条')).toBeLessThan(log.indexOf('produce:3'));
    expect(log.indexOf('append:群第1条')).toBeGreaterThan(-1);
  });
});

/* ------------------------------- ③ 可打断 ------------------------------- */

describe('可打断：中断后不再上屏', () => {
  it('abort 之后剩下的气泡一条都不上屏', async () => {
    routerGenerate = async function* () {
      yield { type: 'text', content: '第一句', delay: 0 } as Bubble;
      await wait(50);
      yield { type: 'text', content: '第二句', delay: 0 } as Bubble;
      await wait(50);
      yield { type: 'text', content: '第三句', delay: 0 } as Bubble;
    };

    const turn = sendUserMessage(CONV, '在吗', PEER, PERSONA, 'off', hooks);
    // Abort while the stream is still writing — the queue must be dropped, not
    // flushed. (Same shape as the deleteContact cascade in M-I1.)
    await wait(200);
    abortConversation(CONV);
    const shownAtAbort = aiLines().length;
    await turn;
    await wait(300); // nothing may arrive late either
    expect(aiLines().length).toBe(shownAtAbort);
    expect(aiLines().length).toBeLessThan(3);
  });
});

/* --------------------------- ② 人设化截断（引擎侧） --------------------------- */

describe('流中断的人设化截断', () => {
  it('引擎给 router 的是 personaTruncation，不是 personaRefusal 的那句', async () => {
    let refusalLine = '';
    let replay = '';
    routerGenerate = async function* (_req, _opts, ctx) {
      yield { type: 'text', content: '我刚才去', delay: 0 } as Bubble;
      refusalLine = ctx.personaRefusal?.().map((b) => b.content).join('') ?? '';
      // Seeded (rule #4): asking twice inside one turn gives the same line.
      replay = ctx.personaTruncation?.().map((b) => b.content).join('') ?? '';
      // Exactly what the router does on a post-first-bubble break.
      for (const b of ctx.personaTruncation?.() ?? []) yield { ...b, delay: 0 };
    };

    await sendUserMessage(CONV, '在吗', PEER, PERSONA, 'off', hooks);
    const lines = aiLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('我刚才去');
    // A cut-off, not a refusal: the "信号不太好" copy would read as her
    // refusing halfway through a sentence she was happy to say.
    expect(refusalLine).toContain('信号');
    expect(lines[1]).not.toContain('信号');
    expect(String(lines[1]).length).toBeGreaterThan(2);
    expect(lines[1]).toBe(replay);
  });
});

/* --------------------------- ② 人设化截断（router 侧） --------------------------- */

describe('router：首气泡之后断流', () => {
  /** A provider whose stream dies after the first bubble. */
  function brokenStreamProvider(): ChatProvider & { completeCalls: number } {
    const p = {
      id: 'p_stream',
      kind: 'test',
      completeCalls: 0,
      async complete(): Promise<CompletionResult> {
        p.completeCalls++;
        return { text: '{"type":"text","content":"重试出来的"}', finishReason: 'stop' };
      },
      async *generate() {},
      async listModels() {
        return ['m'];
      },
      canStream: () => true,
      async *generateStream() {
        yield { type: 'text', content: '我刚才去' } as Bubble;
        throw new LlmError('truncated', 'stream broke', undefined, 'p_stream');
      },
    } as unknown as ChatProvider & { completeCalls: number };
    return p;
  }

  const policy = (primary: ChatProvider, fallback: ChatProvider): RoutingPolicy => ({
    plan: () => ({ provider: primary, model: 'm', fallbacks: [{ provider: fallback, model: 'm' }] }),
  });

  it('追加人设化收尾，且不触发重试链', async () => {
    const primary = brokenStreamProvider();
    const fallback = brokenStreamProvider();
    const router = new LlmRouter(policy(primary, fallback));
    const out: Bubble[] = [];
    for await (const b of router.generate(
      { role: 'chat', nsfwTier: 'off' },
      { messages: [] },
      {
        personaRefusal: () => [{ type: 'text', content: '信号不太好，等下回你哈' }],
        personaTruncation: () => [{ type: 'text', content: '…先不说了，这边有点事' }],
      },
      'conv',
    )) {
      out.push(b);
    }

    expect(out.map((b) => b.content)).toEqual(['我刚才去', '…先不说了，这边有点事']);
    // The ladder is SHUT once a bubble is on screen: no softened retry, no
    // permissive fallback, no second answer to a turn already half-read.
    expect(primary.completeCalls).toBe(0);
    expect(fallback.completeCalls).toBe(0);
  });

  it('首气泡之前失败仍走完整降级链（这条没被改坏）', async () => {
    const primary = brokenStreamProvider();
    // Dies before yielding anything: the ladder must still take over.
    (primary as unknown as { generateStream: unknown }).generateStream = async function* () {
      throw new LlmError('network', 'dead', undefined, 'p_stream');
      yield undefined as never;
    };
    const router = new LlmRouter(policy(primary, brokenStreamProvider()));
    const out: Bubble[] = [];
    for await (const b of router.generate({ role: 'chat', nsfwTier: 'off' }, { messages: [] }, {}, 'c2')) {
      out.push(b);
    }
    expect(primary.completeCalls).toBeGreaterThan(0);
    expect(out.map((b) => b.content)).toEqual(['重试出来的']);
  });

  it('没有 personaTruncation 钩子时安静收场（群聊沿用旧行为）', async () => {
    const primary = brokenStreamProvider();
    const router = new LlmRouter(policy(primary, brokenStreamProvider()));
    const out: Bubble[] = [];
    for await (const b of router.generate({ role: 'chat', nsfwTier: 'off' }, { messages: [] }, {}, 'c3')) {
      out.push(b);
    }
    expect(out.map((b) => b.content)).toEqual(['我刚才去']);
    expect(primary.completeCalls).toBe(0);
  });
});

/* ------------------------------ the feed itself ------------------------------ */

describe('playbackFeed', () => {
  const src = async function* (items: Bubble[], gap = 0) {
    for (const b of items) {
      if (gap) await wait(gap);
      yield b;
    }
  };
  const b = (c: string): Bubble => ({ type: 'text', content: c });

  it('气泡一到就能取，不等源结束', async () => {
    const feed = playbackFeed(src([b('1'), b('2')], 30));
    const first = await feed.next();
    expect(first?.content).toBe('1');
    expect(feed.finished).toBe(false); // the source is still writing
    expect((await feed.next())?.content).toBe('2');
    expect(await feed.next()).toBeNull();
    expect(feed.finished).toBe(true);
  });

  it('accept 为假的气泡被丢弃；keepLast 保住「永不清空」', async () => {
    const dropAll = playbackFeed(src([b('x'), b('y')]), { accept: () => false, keepLast: true });
    expect((await dropAll.next())?.content).toBe('y'); // freshest survivor
    expect(await dropAll.next()).toBeNull();

    const noKeep = playbackFeed(src([b('x')]), { accept: () => false });
    expect(await noKeep.next()).toBeNull();
  });

  it('abort 丢弃未播队列，而不是补播', async () => {
    const ctrl = new AbortController();
    const feed = playbackFeed(src([b('1'), b('2'), b('3')]), { signal: ctrl.signal });
    await wait(5); // let the pump fill
    ctrl.abort();
    expect(await feed.next()).toBeNull();
  });

  it('缓冲里的气泡先交完，再把源的错误抛给调用方', async () => {
    const boom = async function* () {
      yield b('1');
      throw new Error('conn reset');
    };
    const feed = playbackFeed(boom());
    expect((await feed.next())?.content).toBe('1');
    await expect(feed.next()).rejects.toThrow('conn reset');
    expect(await feed.next()).toBeNull(); // 只抛一次
  });
});
