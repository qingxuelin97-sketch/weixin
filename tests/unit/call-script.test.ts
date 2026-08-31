/**
 * 通话 v2 (M-I16) — the red-first suite from the round brief:
 *   1. 通话台词 tier 推导有测试（full 档 + permit → 声明 full；无 permit → off）；
 *   2. 全开档下 TTS 被禁用有测试（callTtsAllowed + CallSession 永不触碰合成）；
 *   3. 纪要写入 conv-state 有测试（承诺可被后续聊天引用）；
 *   4. 纪要 LLM 失败 → 规则式摘要兜底；
 *   5. 通话轮次不落聊天消息——CallSession 根本没有 appendMessage 依赖，
 *      这里用源码断言钉死（写了没接线的反面：接了不该接的线）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import 'fake-indexeddb/auto';
import { repo } from '../../src/db/repo';
import { makePersona } from '../../src/data/persona-defaults';
import {
  CallSession,
  callTtsAllowed,
  buildCallSystem,
  openerDirective,
  ruleSummary,
  extractCallPromises,
  summarizeCall,
  recordCallOutcome,
  type CallTurn,
  type CallTtsBackend,
} from '../../src/ai/call-script';
import { getConvState, putConvState, EMPTY_STATE, convStateDirective } from '../../src/ai/conv-state';
import type { LlmRouter, RouteRequest } from '../../src/llm/router';
import type { GenerateOptions } from '../../src/llm/types';
import { parseBubbles } from '../../src/llm/bubbles';
import type { ContactVM } from '../../src/data/types';

const T0 = 1_754_600_000_000;

const peer: ContactVM = {
  id: 'ai_call',
  type: 'ai',
  name: '小雨',
  avatarColor: '#000000',
  avatarText: '雨',
};

interface Captured {
  req: RouteRequest;
  opts: Omit<GenerateOptions, 'model'>;
  convKey?: string;
}

/** A router double that records every request and replies with fixed NDJSON. */
function fakeRouter(reply: string) {
  const calls: Captured[] = [];
  const router = {
    async complete(req: RouteRequest, opts: Omit<GenerateOptions, 'model'>, _ctx: unknown, convKey?: string) {
      calls.push({ req, opts, convKey });
      return { text: reply, finishReason: 'stop' as const, raw: null };
    },
    async *generate(req: RouteRequest, opts: Omit<GenerateOptions, 'model'>, _ctx: unknown, convKey?: string) {
      calls.push({ req, opts, convKey });
      for (const b of parseBubbles(reply)) yield b;
    },
  } as unknown as LlmRouter;
  return { router, calls };
}

function ttsStub(available: boolean) {
  const counters = { ensure: 0, play: 0, stop: 0 };
  const tts: CallTtsBackend = {
    available: async () => available,
    ensure: async () => {
      counters.ensure++;
      return { key: 'k', durationMs: 500 };
    },
    play: async (_k, onEnded) => {
      counters.play++;
      onEnded?.();
      return true;
    },
    stop: () => {
      counters.stop++;
    },
  };
  return { tts, counters };
}

function session(over: Partial<ConstructorParameters<typeof CallSession>[0]> = {}) {
  const lines: CallTurn[] = [];
  const { router } = fakeRouter('{"type":"text","content":"喂，怎么啦"}');
  const sess = new CallSession({
    convId: 'c_call',
    peer,
    persona: makePersona({ contactId: peer.id, core: '测试人设', nsfwPermit: true }),
    globalTier: 'off',
    direction: 'out',
    recent: [],
    now: () => T0,
    onLine: (t) => lines.push(t),
    router,
    pace: () => 0,
    ...over,
  });
  return { sess, lines };
}

beforeEach(async () => {
  await repo.putSetting('nsfwGlobalTier', 'off');
});

/* ------------------------------------------------------------------ */

describe('通话台词的 tier 推导（调用点不得自造）', () => {
  it('全局 full + persona 有 permit → 声明 full', async () => {
    const { router, calls } = fakeRouter('{"type":"text","content":"喂"}');
    const { sess } = session({
      router,
      globalTier: 'full',
      persona: makePersona({ contactId: peer.id, core: 'c', nsfwPermit: true }),
    });
    expect(sess.tier).toBe('full');
    await sess.start();
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c.req.nsfwTier).toBe('full');
    expect(calls[0].convKey).toBe('call:c_call');
  });

  it('无 permit 时钉死 off，全局档位再高也没用', async () => {
    const { router, calls } = fakeRouter('{"type":"text","content":"喂"}');
    const { sess } = session({
      router,
      globalTier: 'full',
      persona: makePersona({ contactId: peer.id, core: 'c', nsfwPermit: false }),
    });
    expect(sess.tier).toBe('off');
    await sess.start();
    for (const c of calls) expect(c.req.nsfwTier).toBe('off');
  });

  it('台词经 parseBubbles 归一后逐句上字幕（含通话场景层）', async () => {
    const { router, calls } = fakeRouter(
      '{"type":"text","content":"喂"}\n{"type":"text","content":"我刚看到你消息"}',
    );
    const { sess, lines } = session({ router });
    await sess.start();
    expect(lines.map((l) => l.text)).toEqual(['喂', '我刚看到你消息']);
    expect(lines.every((l) => l.speaker === 'peer')).toBe(true);
    // 场景层注明「正在语音通话中」；开场由头随 direction 走。
    const sys = String(calls[0].opts.messages[0].content);
    expect(sys).toContain('语音通话');
    expect(sys).toContain(openerDirective('out').slice(0, 10));
  });

  it('你说话后她接话：轮次进上下文，角色映射 user/assistant', async () => {
    const { router, calls } = fakeRouter('{"type":"text","content":"好呀"}');
    const { sess, lines } = session({ router });
    await sess.start();
    await sess.userSaid('周五一起吃饭？');
    const last = calls.at(-1)!;
    const msgs = last.opts.messages;
    expect(msgs.at(-1)).toEqual({ role: 'user', content: '周五一起吃饭？' });
    // start() 用同一个 router 生成了开场白「好呀」，它应作为 assistant 轮次在上下文里。
    expect(msgs.some((m) => m.role === 'assistant' && m.content === '好呀')).toBe(true);
    expect(lines.some((l) => l.speaker === 'self' && l.text === '周五一起吃饭？')).toBe(true);
  });
});

/* ------------------------------------------------------------------ */

describe('全开档禁用 TTS（铁律 6 的通话面）', () => {
  it('callTtsAllowed: 只有 full 被禁', () => {
    expect(callTtsAllowed('off')).toBe(true);
    expect(callTtsAllowed('ambiguous')).toBe(true);
    expect(callTtsAllowed('full')).toBe(false);
  });

  it('full 档会话即使 TTS 可用也一次不合成——优雅降级为字幕', async () => {
    const { tts, counters } = ttsStub(true);
    const { sess } = session({
      globalTier: 'full',
      persona: makePersona({ contactId: peer.id, core: 'c', nsfwPermit: true }),
      tts,
    });
    await sess.start();
    expect(sess.voiceOn).toBe(false);
    expect(counters.ensure).toBe(0);
    expect(counters.play).toBe(0);
  });

  it('off 档 + TTS 可用 → 逐句合成并播放', async () => {
    const { tts, counters } = ttsStub(true);
    const { sess } = session({ tts });
    await sess.start();
    expect(sess.voiceOn).toBe(true);
    expect(counters.ensure).toBe(1);
    expect(counters.play).toBe(1);
  });

  it('无 TTS key → 字幕模式，台词照样上屏', async () => {
    const { tts, counters } = ttsStub(false);
    const { sess, lines } = session({ tts });
    await sess.start();
    expect(sess.voiceOn).toBe(false);
    expect(counters.ensure).toBe(0);
    expect(lines.length).toBeGreaterThan(0);
  });

  it('挂断即停：end() 调 tts.stop 并丢弃未播队列', async () => {
    const { tts, counters } = ttsStub(true);
    const { sess } = session({ tts });
    await sess.start();
    sess.end();
    expect(counters.stop).toBeGreaterThan(0);
    // ended 后 userSaid 是 no-op——不会再有新台词。
    const before = sess.turns.length;
    await sess.userSaid('还在吗');
    expect(sess.turns.length).toBe(before);
  });
});

/* ------------------------------------------------------------------ */

describe('通话纪要', () => {
  const turns: CallTurn[] = [
    { speaker: 'peer', text: '喂，周五晚上有空吗', at: T0 },
    { speaker: 'self', text: '有啊怎么了', at: T0 + 1000 },
    { speaker: 'peer', text: '那说好周五见，我带蛋糕', at: T0 + 2000 },
  ];

  it('extractCallPromises 抓约定句', () => {
    const p = extractCallPromises(turns);
    expect(p.length).toBeGreaterThan(0);
    expect(p[0]).toContain('周五');
    expect(p.length).toBeLessThanOrEqual(2);
  });

  it('ruleSummary: 有约定记约定，没约定概括最后一句，空通话报时长', () => {
    expect(ruleSummary(turns, 60_000)).toContain('说好');
    expect(
      ruleSummary([{ speaker: 'peer', text: '就是想听听你的声音', at: T0 }], 60_000),
    ).toContain('聊到');
    expect(ruleSummary([], 61_000)).toContain('1分1秒');
  });

  it('summarizeCall: LLM 正常 → 用它的一句话', async () => {
    const { router } = fakeRouter('说好周五见，她带蛋糕');
    const out = await summarizeCall({
      convId: 'c_call',
      peerName: '小雨',
      tier: 'off',
      turns,
      durationMs: 60_000,
      router,
    });
    expect(out).toBe('说好周五见，她带蛋糕');
  });

  it('summarizeCall: 纪要调用声明通话推导的 tier（原文过路由，铁律 6 覆盖）', async () => {
    const { router, calls } = fakeRouter('纪要');
    await summarizeCall({
      convId: 'c_call',
      peerName: '小雨',
      tier: 'full',
      turns,
      durationMs: 60_000,
      router,
    });
    expect(calls[0].req.nsfwTier).toBe('full');
    expect(calls[0].req.role).toBe('memory');
  });

  it('summarizeCall: LLM 抛错 → 规则式摘要兜底，绝不空手而归', async () => {
    const router = {
      async complete() {
        throw new Error('无宽松通道');
      },
    } as unknown as LlmRouter;
    const out = await summarizeCall({
      convId: 'c_call',
      peerName: '小雨',
      tier: 'off',
      turns,
      durationMs: 60_000,
      router,
    });
    expect(out).toContain('说好');
  });

  it('没说过话的通话没有纪要', async () => {
    const out = await summarizeCall({
      convId: 'c_call',
      peerName: '小雨',
      tier: 'off',
      turns: [],
      durationMs: 5_000,
    });
    expect(out).toBe('');
  });
});

/* ------------------------------------------------------------------ */

describe('纪要落 conv-state 的承诺/待办通道', () => {
  it('承诺进 promises，后续聊天的 directive 能引用到', async () => {
    const convId = 'c_call_state1';
    await putConvState(convId, { ...EMPTY_STATE });
    await recordCallOutcome(convId, 'ai_call', '说好周五见', ['说好周五见，我带蛋糕'], T0);
    const state = await getConvState(convId);
    expect(state.promises[0]).toBe('说好周五见，我带蛋糕');
    // 「电话里说好了周五见」被后续聊天引用的形态：
    expect(convStateDirective(state, T0 + 1000)).toContain('说好周五见');
  });

  it('没抓到承诺时用纪要本身垫上，并与旧承诺合并、上限 2', async () => {
    const convId = 'c_call_state2';
    await putConvState(convId, { ...EMPTY_STATE, promises: ['旧承诺A', '旧承诺B'], updatedAt: T0 - 1 });
    await recordCallOutcome(convId, 'ai_call', '电话里聊到：搬家的事', [], T0);
    const state = await getConvState(convId);
    expect(state.promises).toEqual(['电话里聊到：搬家的事', '旧承诺A']);
    expect(state.updatedAt).toBe(T0);
  });

  it('空纪要 + 空承诺 = 不动 conv-state', async () => {
    const convId = 'c_call_state3';
    await putConvState(convId, { ...EMPTY_STATE, promises: ['旧承诺'], updatedAt: 7 });
    await recordCallOutcome(convId, 'ai_call', '', [], T0);
    const state = await getConvState(convId);
    expect(state.promises).toEqual(['旧承诺']);
    expect(state.updatedAt).toBe(7);
  });
});

/* ------------------------------------------------------------------ */

describe('结构性约束', () => {
  it('通话轮次不落聊天消息：call-script 不接 appendMessage/putMessage', () => {
    const src = readFileSync(resolve(__dirname, '../../src/ai/call-script.ts'), 'utf8');
    expect(src).not.toContain('appendMessage');
    expect(src).not.toContain('putMessage');
  });

  it('引擎逻辑无 Date.now / Math.random（铁律 4）', () => {
    const src = readFileSync(resolve(__dirname, '../../src/ai/call-script.ts'), 'utf8');
    expect(src).not.toMatch(/Date\.now\s*\(/);
    expect(src).not.toMatch(/Math\.random\s*\(/);
  });

  it('buildCallSystem 场景层注明通话中，层序仍以基底开头', async () => {
    const sys = await buildCallSystem({
      peer,
      persona: makePersona({ contactId: peer.id, core: '爱笑', nsfwPermit: false }),
      tier: 'off',
      recent: [],
      now: T0,
    });
    expect(sys.startsWith('你在一个微信聊天里')).toBe(true);
    expect(sys).toContain('正在语音通话中');
    // 场景补充殿后——不改六层顺序。
    expect(sys.indexOf('正在语音通话中')).toBeGreaterThan(sys.indexOf('# 当前场景'));
  });
});
