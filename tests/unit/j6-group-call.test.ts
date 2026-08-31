/**
 * 群语音通话 (M-J6c) red-guards:
 *   1. 成本闸：每轮恰好 1 次 LLM 生成（导演是纯函数，点将零成本）；
 *   2. pickCallSpeaker：种子确定、点名必接、刚说过的降权；
 *   3. 铁律 6 分人：全开档成员的台词绝不进 TTS（字幕退），tier 落在 generate
 *      调用上且逐发言者推导（不是写死 'off'）；
 *   4. 台词带 speakerId/Name；host 快照 group 旗 + speakingId 高亮；
 *   5. 纪要：只有开过口的成员长记忆；conv-state / conv_summaries 落群会话；
 *   6. 接线扫描：路由注册、聊天页群入口、胶囊群路径、台账登记。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import 'fake-indexeddb/auto';
import { makePersona } from '../../src/data/persona-defaults';
import { type CallTtsBackend } from '../../src/ai/call-script';
import {
  GroupCallSession,
  pickCallSpeaker,
  strictestTier,
  GROUP_CALL_GEN_PER_ROUND,
  type GroupCallMember,
} from '../../src/ai/group-call';
import { adoptCall, getActiveCall, hangupActiveCall, resetCallHostForTests } from '../../src/features/call/call-host';
import { useAppStore } from '../../src/store/appStore';
import type { LlmRouter, RouteRequest } from '../../src/llm/router';
import type { GenerateOptions } from '../../src/llm/types';
import type { ContactVM, NsfwTierVM } from '../../src/data/types';
import { parseBubbles } from '../../src/llm/bubbles';
import { repo } from '../../src/db/repo';

const T0 = 1_754_600_000_000;

const contact = (id: string, name: string): ContactVM => ({
  id,
  type: 'ai',
  name,
  avatarColor: '#000000',
  avatarText: name[0],
});

const member = (id: string, name: string, over: Partial<Parameters<typeof makePersona>[0]> = {}): GroupCallMember => ({
  contact: contact(id, name),
  persona: makePersona({ contactId: id, core: '测试', nsfwPermit: false, ...over }),
});

/** Router double that counts generate calls and records the tier of each. */
function countingRouter(reply: string) {
  const calls: Array<{ tier: RouteRequest['nsfwTier'] }> = [];
  const router = {
    async complete(_req: RouteRequest, _opts: Omit<GenerateOptions, 'model'>) {
      return { text: reply, finishReason: 'stop' as const, raw: null };
    },
    async *generate(req: RouteRequest, _opts: Omit<GenerateOptions, 'model'>) {
      calls.push({ tier: req.nsfwTier });
      for (const b of parseBubbles(reply)) yield b;
    },
  } as unknown as LlmRouter;
  return { router, calls };
}

function loggingTts() {
  const log: string[] = [];
  const tts: CallTtsBackend = {
    available: async () => true,
    ensure: async (line: string) => {
      log.push(`ensure:${line}`);
      return { key: `k:${line}`, durationMs: 10 };
    },
    play: async (key: string, onEnded?: () => void) => {
      log.push(`play:${key}`);
      onEnded?.();
      return true;
    },
    stop: () => {
      log.push('stop');
    },
  };
  return { tts, log };
}

const sessionOpts = (
  members: GroupCallMember[],
  router: LlmRouter,
  tts: CallTtsBackend,
  globalTier: NsfwTierVM = 'off',
) => ({
  convId: 'conv_group',
  title: '露营小分队',
  members,
  globalTier,
  recent: [],
  now: () => T0,
  onLine: () => {},
  router,
  tts,
  pace: () => 0,
});

afterEach(() => {
  resetCallHostForTests();
});

describe('成本闸：每轮恰好 1 次生成', () => {
  it(`opener 1 次，userSaid 再 1 次——常量 GROUP_CALL_GEN_PER_ROUND=${GROUP_CALL_GEN_PER_ROUND}`, async () => {
    const { router, calls } = countingRouter('{"type":"text","content":"都在呢"}');
    const { tts } = loggingTts();
    const sess = new GroupCallSession(
      sessionOpts([member('ai_a', '阿甲'), member('ai_b', '阿乙'), member('ai_c', '阿丙')], router, tts),
    );
    await sess.start();
    expect(calls.length).toBe(1);
    await sess.userSaid('周六都有空吗');
    expect(calls.length).toBe(2); // 1 + 1, never a fan-out
    sess.end();
    expect(GROUP_CALL_GEN_PER_ROUND).toBe(1);
  });
});

describe('pickCallSpeaker（零成本导演）', () => {
  const roster = [
    { id: 'a', name: '阿甲', proactivity: 0.4 },
    { id: 'b', name: '阿乙', proactivity: 0.4 },
    { id: 'c', name: '阿丙', proactivity: 0.4 },
  ];

  it('同种子同结果（可回放）', () => {
    const x = pickCallSpeaker({ members: roster, seed: 's1' });
    const y = pickCallSpeaker({ members: roster, seed: 's1' });
    expect(x).toBe(y);
  });

  it('被点名的几乎必接：100 个种子里点名者拿走绝大多数', () => {
    let named = 0;
    for (let i = 0; i < 100; i++) {
      if (
        pickCallSpeaker({ members: roster, userText: '阿丙你觉得呢', seed: `n${i}` }) === 'c'
      )
        named++;
    }
    expect(named).toBeGreaterThan(80);
  });

  it('刚说过话的降权：连庄率明显低于均分', () => {
    let repeats = 0;
    for (let i = 0; i < 100; i++) {
      if (pickCallSpeaker({ members: roster, lastSpeakerId: 'a', seed: `r${i}` }) === 'a') repeats++;
    }
    expect(repeats).toBeLessThan(25); // 均分是 33%，降权后必须显著更低
  });
});

describe('铁律 6 分人', () => {
  it('strictestTier 取严不取宽', () => {
    expect(strictestTier(['off', 'ambiguous'])).toBe('ambiguous');
    expect(strictestTier(['off', 'full', 'ambiguous'])).toBe('full');
    expect(strictestTier([])).toBe('off');
  });

  it('全开档成员在场：会话 tier=full、voiceOn 熄灭、台词零 TTS（字幕退）', async () => {
    const { router, calls } = countingRouter('{"type":"text","content":"来了来了"}');
    const { tts, log } = loggingTts();
    const sess = new GroupCallSession(
      sessionOpts([member('ai_x', '小徐', { nsfwPermit: true })], router, tts, 'full'),
    );
    expect(sess.tier).toBe('full');
    await sess.start();
    // 生成照跑（宽松通道的事路由器管），但 tier 必须如实上报——不是写死 off。
    expect(calls[0]?.tier).toBe('full');
    expect(sess.voiceOn).toBe(false);
    expect(log.filter((l) => l.startsWith('play:')).length).toBe(0);
    sess.end();
  });

  it('tier 逐发言者推导：permit=false 的成员在 full 全局下仍以 off 发言', async () => {
    const { router, calls } = countingRouter('{"type":"text","content":"嗯嗯"}');
    const { tts } = loggingTts();
    const sess = new GroupCallSession(
      sessionOpts([member('ai_y', '小杨', { nsfwPermit: false })], router, tts, 'full'),
    );
    await sess.start();
    expect(calls[0]?.tier).toBe('off');
    sess.end();
  });
});

describe('台词身份与 host 快照', () => {
  beforeEach(() => {
    resetCallHostForTests();
  });

  it('peer 台词带 speakerId/speakerName；host 群旗立起、speakingId 曾指向发言者', async () => {
    const { router } = countingRouter('{"type":"text","content":"喂喂"}');
    const { tts } = loggingTts();
    const seenIds: Array<string | null> = [];
    const snap = adoptCall({
      convId: 'conv_group',
      peerId: '',
      peerName: '露营小分队',
      direction: 'out',
      group: true,
      now: () => T0,
      makeSession: (ui) =>
        new GroupCallSession({
          ...sessionOpts([member('ai_a', '阿甲')], router, tts),
          onLine: ui.onLine,
          onSpeaking: ui.onSpeaking,
          onSpeakingId: (id) => {
            seenIds.push(id);
            ui.onSpeakingId(id);
          },
          onReady: ui.onReady,
        }),
    });
    expect(snap.group).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    const call = getActiveCall();
    const peerLine = call?.subs.find((t) => t.speaker === 'peer');
    expect(peerLine?.speakerId).toBe('ai_a');
    expect(peerLine?.speakerName).toBe('阿甲');
    expect(seenIds).toContain('ai_a');
    await hangupActiveCall();
  });

  it('挂断经同一个 hangupActiveCall 落一条群 call 记录', async () => {
    const { router } = countingRouter('{"type":"text","content":"到齐了"}');
    const { tts } = loggingTts();
    adoptCall({
      convId: 'conv_group',
      peerId: '',
      peerName: '露营小分队',
      direction: 'out',
      group: true,
      now: () => T0,
      makeSession: (ui) => new GroupCallSession({ ...sessionOpts([member('ai_a', '阿甲')], router, tts), ...ui }),
    });
    await new Promise((r) => setTimeout(r, 30));
    const before = useAppStore
      .getState()
      .messagesFor('conv_group')
      .filter((m) => m.type === 'call').length;
    await hangupActiveCall();
    const after = useAppStore
      .getState()
      .messagesFor('conv_group')
      .filter((m) => m.type === 'call').length;
    expect(after - before).toBe(1);
    expect(getActiveCall()).toBeNull();
  });
});

describe('纪要：谁开口谁长记忆', () => {
  it('finalize 后开过口的成员有 memory 行，没开口的没有', async () => {
    const { router } = countingRouter('{"type":"text","content":"那就周六见"}');
    const { tts } = loggingTts();
    // 只有一个成员会被点将（单人名单强制），另一个人根本不在场。
    const sess = new GroupCallSession(
      sessionOpts([member('ai_spoke', '说了话')], router, tts),
    );
    await sess.start();
    await sess.userSaid('周六出发行吗');
    const summary = await sess.finalize();
    expect(summary.length).toBeGreaterThan(0);
    const spoke = await repo.getMemory('ai_spoke');
    expect(spoke.some((f) => f.fact.includes('群语音'))).toBe(true);
    const silent = await repo.getMemory('ai_silent_never_there');
    expect(silent.length).toBe(0);
    const cs = await repo.getConvSummary('conv_group');
    expect(cs?.summary ?? '').toContain('群语音');
    sess.end();
  });
});

describe('接线扫描（写了没接线 = 没做）', () => {
  const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

  it('路由已注册且进了路由台账', () => {
    expect(read('src/App.tsx')).toContain('/group-call/:convId');
    expect(read('tests/lib/route-ledger.ts')).toContain('/group-call/:convId');
  });

  it('聊天页的通话格在群里不再是死的——直通群语音', () => {
    const src = read('src/features/chat/ChatPage.tsx');
    expect(src).toContain("key === 'call' && isGroup");
    expect(src).toContain('/group-call/${convId}');
  });

  it('胶囊懂群：群通话最小化后点回去走 /group-call', () => {
    expect(read('src/features/call/MiniCallPill.tsx')).toContain('/group-call/');
  });

  it('群页与单页共用同一套挂断/说话机器（hangupActiveCall + holdFloor 先行）', () => {
    const src = read('src/features/call/GroupCallPage.tsx');
    expect(src).toContain('hangupActiveCall');
    const down = src.slice(src.indexOf('const onTalkDown'));
    expect(down.slice(0, down.indexOf('startRecording'))).toContain('holdFloor()');
  });
});
