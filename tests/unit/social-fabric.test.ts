import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  maybeJointPlan,
  jointStaggerMs,
  jointMomentsSystem,
  parseJointMoments,
  JOINT_PLAN_CHANCE,
  JOINT_PLAN_LLM_CALLS,
} from '../../src/ai/social-plans';
import { canForwardFrom, maybeForward, forwardLine, FORWARD_CHANCE } from '../../src/ai/agent-forward';
import { handleJointPlan, handleAgentForward, type HandlerDeps } from '../../src/ai/handlers';
import { makePersona } from '../../src/data/persona-defaults';
import type { ContactVM, ConversationVM, MessageVM, MomentVM } from '../../src/data/types';

/**
 * Social fabric (M-I3).
 *
 * Two invariants carry this stage: hidden AI↔AI DM content NEVER reaches a
 * user surface verbatim (irreversible fourth-wall break), and materialization
 * cost is bounded by constants a refactor cannot silently raise.
 */

const T0 = new Date(2026, 6, 10, 15, 0).getTime();

describe('purity (constitution rule #4)', () => {
  it('the planning modules never read the clock or roll real dice', () => {
    // group-events.ts and agent-invite.ts are pure TODAY; they are on this list
    // so they stay that way — both are seeded planners whose whole value is
    // that a replayed timeline produces the same 聚会 and the same proposal.
    for (const f of [
      'src/ai/social-plans.ts',
      'src/ai/agent-forward.ts',
      'src/ai/group-events.ts',
      'src/ai/agent-invite.ts',
    ]) {
      const src = readFileSync(resolve(__dirname, '../..', f), 'utf8');
      expect(src.includes('Date.now'), `${f} reads the wall clock`).toBe(false);
      expect(src.includes('Math.random'), `${f} rolls real dice`).toBe(false);
    }
  });

  it('plans are deterministic for the same seed and bounded in time', () => {
    const a = maybeJointPlan('dm_x_y', T0);
    expect(maybeJointPlan('dm_x_y', T0)).toEqual(a);
    // Sweep seeds: every hatched plan lands inside the stated window.
    let hatched = 0;
    for (let i = 0; i < 200; i++) {
      const p = maybeJointPlan(`dm_${i}`, T0);
      if (!p) continue;
      hatched++;
      expect(p.fireAt).toBeGreaterThan(T0 + 19 * 3_600_000);
      expect(p.fireAt).toBeLessThan(T0 + 45 * 3_600_000);
    }
    // Roughly the configured rate — a broken gate shows up as 0 or 200.
    expect(hatched).toBeGreaterThan(200 * JOINT_PLAN_CHANCE * 0.4);
    expect(hatched).toBeLessThan(200 * JOINT_PLAN_CHANCE * 2.2);
    expect(jointStaggerMs('dm_x_y', T0)).toBe(jointStaggerMs('dm_x_y', T0));
  });
});

describe('the hidden-conversation leak wall', () => {
  const hidden: ConversationVM = {
    id: 'dm_a_b', type: 'single', title: 'x', avatarColor: 'var(--wx-a)', avatarText: 'x',
    isPinned: false, isMuted: true, isHidden: true, unreadCount: 0, mentionMe: false,
    lastMsgPreview: '', lastMsgAt: T0, memberIds: ['ai_a', 'ai_b'],
  };
  const visible: ConversationVM = { ...hidden, id: 'conv_a', isHidden: false, peerId: 'ai_a' };

  it('a hidden source is unquotable at plan time', () => {
    expect(canForwardFrom(hidden)).toBe(false);
    expect(canForwardFrom(undefined)).toBe(false);
    expect(canForwardFrom(visible)).toBe(true);
    expect(maybeForward(hidden, '密谈内容', 'dm', T0)).toBeNull();
  });

  it('a hidden source is unquotable at FIRE time too (defense in depth)', async () => {
    // The row was somehow planned anyway (old build, tampered payload) — the
    // handler must still refuse: the screen cannot be un-shown.
    const appended: Array<Omit<MessageVM, 'id'>> = [];
    const deps = fakeDeps({ convs: [hidden, groupConv()], appended });
    await handleAgentForward(deps, {
      speakerId: 'ai_a', sourceConvId: 'dm_a_b', groupId: 'conv_g', quote: '密谈内容', at: T0,
    });
    expect(appended).toEqual([]);
  });

  it('a visible source forwards, quoting verbatim', async () => {
    const appended: Array<Omit<MessageVM, 'id'>> = [];
    const deps = fakeDeps({ convs: [visible, groupConv()], appended });
    await handleAgentForward(deps, {
      speakerId: 'ai_a', sourceConvId: 'conv_a', groupId: 'conv_g', quote: '周五要去爬山', at: T0,
    });
    expect(appended).toHaveLength(1);
    expect(appended[0].content).toContain('周五要去爬山');
    expect(appended[0].convId).toBe('conv_g');
  });

  it('a speaker who left the group since planning stays silent', async () => {
    const appended: Array<Omit<MessageVM, 'id'>> = [];
    const g = groupConv();
    g.memberIds = ['ai_b']; // ai_a was removed (I1 member management)
    const deps = fakeDeps({ convs: [visible, g], appended });
    await handleAgentForward(deps, {
      speakerId: 'ai_a', sourceConvId: 'conv_a', groupId: 'conv_g', quote: 'x', at: T0,
    });
    expect(appended).toEqual([]);
  });
});

describe('the bounded three-way DM (M-I3)', () => {
  const NAMES: Record<string, string> = { ai_a: '小雨', ai_b: 'Ada', ai_c: '陈叔' };
  const trioContact = (id: string): ContactVM => ({
    id, type: 'ai', name: NAMES[id] ?? id, avatarColor: 'var(--wx-a)', avatarText: 'x',
    pinyinInitial: 'X', wxid: id,
  });

  function dmDeps(script: string, onCall: () => void) {
    const appended: Array<Omit<MessageVM, 'id'>> = [];
    const convs: ConversationVM[] = [];
    const memories: Array<{ subjectId: string; fact: string }> = [];
    const deps = {
      getPersona: (id: string) => makePersona({ contactId: id, core: 'c' }),
      getContact: trioContact,
      getConversation: async (id: string) => convs.find((c) => c.id === id),
      addConversation: async (c: ConversationVM) => void convs.push(c),
      appendMessage: async (m: Omit<MessageVM, 'id'>) => {
        appended.push(m);
        return { ...m, id: appended.length } as MessageVM;
      },
      putMemory: async (f: { subjectId: string; fact: string }) => void memories.push(f),
      getMemoryFacts: async () => [],
      getGroupMessages: async () => [],
      getMoments: async () => [],
      complete: async () => {
        onCall();
        return script;
      },
      enqueueGroupSpill: async () => {},
      now: () => T0,
      getGlobalTier: async () => 'off' as const,
    };
    return { deps, appended, convs, memories };
  }

  it('THE cost gate: three voices still cost ONE dispatch call', async () => {
    const { runAgentDm, DM_LLM_CALLS_PER_SESSION, MAX_DM_PARTICIPANTS } = await import(
      '../../src/ai/agent-dm'
    );
    expect(DM_LLM_CALLS_PER_SESSION).toBe(1);
    expect(MAX_DM_PARTICIPANTS).toBe(3);
    let calls = 0;
    const { deps, appended, convs, memories } = dmDeps(
      [
        '{"speaker":"A","text":"你俩下周有空吗"}',
        '{"speaker":"B","text":"周六可以"}',
        '{"speaker":"C","text":"我看看排班"}',
        '{"gossip":{"about":"user","fact":"他周末要加班"}}',
      ].join('\n'),
      () => calls++,
    );
    const ok = await runAgentDm(
      { a: 'ai_a', b: 'ai_b', c: 'ai_c', groupId: 'conv_g', fireAt: T0 },
      deps,
    );
    expect(ok).toBe(true);
    // One call — never one per speaker. This constant IS the contract.
    expect(calls).toBe(DM_LLM_CALLS_PER_SESSION);
    // All three actually spoke, each line attributed to a real id.
    expect(appended.map((m) => m.senderId)).toEqual(['ai_a', 'ai_b', 'ai_c']);
    expect(convs[0].memberIds).toEqual(['ai_a', 'ai_b', 'ai_c']);
    // Gossip reaches every participant: teller framing once, listener twice.
    expect(memories.map((m) => m.subjectId).sort()).toEqual(['ai_a', 'ai_b', 'ai_c']);
    expect(memories.find((m) => m.subjectId === 'ai_a')!.fact).toBe('和Ada、陈叔聊到：他周末要加班');
    expect(memories.find((m) => m.subjectId === 'ai_c')!.fact).toBe('听小雨说：他周末要加班');
  });

  it('is bounded at three — a fourth participant cannot enter through any door', async () => {
    const { participantsOf, MAX_DM_PARTICIPANTS, planNextDm, parseDmScript } = await import(
      '../../src/ai/agent-dm'
    );
    const { dmPlanFrom } = await import('../../src/ai/handlers');
    // The payload reader is the door a tampered/legacy row would come through.
    const plan = dmPlanFrom(
      { a: 'ai_a', b: 'ai_b', c: 'ai_c', d: 'ai_d', groupId: 'g', fireAt: T0 },
      T0,
    )!;
    expect(participantsOf(plan)).toEqual(['ai_a', 'ai_b', 'ai_c']);
    expect(participantsOf(plan).length).toBeLessThanOrEqual(MAX_DM_PARTICIPANTS);
    // A duplicate name collapses instead of inflating the cast.
    expect(participantsOf(dmPlanFrom({ a: 'x', b: 'y', c: 'y', groupId: 'g' }, T0)!)).toEqual([
      'x', 'y',
    ]);
    // A "D" line has no slot and is dropped, not guessed onto someone.
    const s = parseDmScript(
      '{"speaker":"A","text":"1"}\n{"speaker":"D","text":"我是谁"}\n{"speaker":"C","text":"3"}',
      3,
    )!;
    expect(s.lines.map((l) => l.who)).toEqual(['a', 'c']);

    // …and the planner itself never exceeds the bound over a wide seed sweep.
    const roster = ['ai_a', 'ai_b', 'ai_c', 'ai_d', 'ai_e'].map((id) => ({
      contactId: id,
      persona: makePersona({ contactId: id, core: 'c', activeHours: [[0, 24]] }),
    }));
    const groups = [{ convId: 'g1', memberIds: ['ai_a', 'ai_b', 'ai_c', 'ai_d', 'ai_e'] }];
    let trios = 0;
    for (let i = 0; i < 200; i++) {
      const p = planNextDm(roster, groups, T0 + i * 3_600_000, `s${i}`)!;
      const ids = participantsOf(p);
      expect(ids.length).toBeGreaterThanOrEqual(2);
      expect(ids.length).toBeLessThanOrEqual(MAX_DM_PARTICIPANTS);
      expect(new Set(ids).size).toBe(ids.length);
      // Everyone must come from the shared room.
      expect(ids.every((id) => groups[0].memberIds.includes(id))).toBe(true);
      if (ids.length === 3) trios++;
    }
    // A minority, but a real one — 0 or 200 both mean the gate is broken.
    expect(trios).toBeGreaterThan(0);
    expect(trios).toBeLessThan(100);
  });

  it('stays invisible on EVERY user-visible surface (转红)', async () => {
    const { makeDmConversation } = await import('../../src/ai/agent-dm');
    const { search } = await import('../../src/lib/search');
    const { computeReport } = await import('../../src/lib/report');
    const { buildWidgetSummary } = await import('../../src/native/widget-sync');
    const { classifyIncoming } = await import('../../src/native/background-notify');

    const trio = makeDmConversation(
      [trioContact('ai_a'), trioContact('ai_b'), trioContact('ai_c')],
      T0,
    );
    expect(trio.id).toBe('dm_ai_a_ai_b_ai_c');
    expect(trio.isHidden).toBe(true);
    const secret: MessageVM = {
      id: 1, convId: trio.id, senderId: 'ai_a', type: 'text',
      content: '这句三人私聊绝不能被看到', status: 'sent', createdAt: T0,
    };
    const visibleConv: ConversationVM = {
      id: 'conv_v', type: 'single', peerId: 'ai_a', title: '小雨', avatarColor: 'var(--wx-a)',
      avatarText: 'x', isPinned: false, isMuted: false, unreadCount: 3, mentionMe: false,
      lastMsgPreview: '在吗', lastMsgAt: T0 - 1000,
    };

    // 1) 搜索：neither the content nor the (three-name) title matches.
    const input = {
      contacts: [], conversations: [trio, visibleConv],
      messages: { [trio.id]: [secret] }, moments: [],
    };
    expect(search(input, '三人私聊')).toEqual([]);
    expect(search(input, '陈叔')).toEqual([]);

    // 2) 转发：a hidden source is unquotable (plan time and fire time).
    expect(canForwardFrom(trio)).toBe(false);
    expect(maybeForward(trio, '八卦原文', 'dm', T0)).toBeNull();

    // 3) 年度报告：contributes zero, even when handed over directly.
    const report = computeReport({
      conversations: [trio, visibleConv],
      messagesByConv: { [trio.id]: [secret] },
      contacts: [], walletTxs: [], now: T0,
    });
    expect(JSON.stringify(report)).not.toContain('三人私聊');
    expect(report.totalMessages).toBe(0);

    // 4) 桌面小组件：never the headline, never in the unread count.
    const widget = buildWidgetSummary([trio, visibleConv], (c) => c.title);
    expect(widget.convId).toBe('conv_v');
    expect(widget.unread).toBe(visibleConv.unreadCount);

    // 5) 通知：a hidden thread raises nothing at all.
    expect(
      classifyIncoming({
        msg: secret, convId: trio.id, convType: 'single', isHidden: true,
        appVisible: false, settings: { bubble: true, incomingCall: true },
      }),
    ).toBe('none');
  });
});

describe('the joint-plan cost gate', () => {
  it('one call writes both moments — the constant is the contract', async () => {
    expect(JOINT_PLAN_LLM_CALLS).toBe(1);
    let llmCalls = 0;
    const moments: MomentVM[] = [];
    const deps = fakeDeps({
      moments,
      complete: () => {
        llmCalls++;
        return JSON.stringify({ a: '和老王看了那部片，他睡着了', b: '不是我的错，片是真的闷' });
      },
    });
    await handleJointPlan(deps, { a: 'ai_a', b: 'ai_b', kind: 'movie', dmId: 'dm_a_b', at: T0 });
    expect(llmCalls).toBe(JOINT_PLAN_LLM_CALLS);
    expect(moments).toHaveLength(2);
    expect(moments[0].authorId).toBe('ai_a');
    expect(moments[1].authorId).toBe('ai_b');
    // B trails A by a believable, seeded gap — never the same second.
    expect(moments[1].createdAt).toBeGreaterThan(moments[0].createdAt);
  });

  it('a deleted participant drops the plan silently', async () => {
    const moments: MomentVM[] = [];
    const deps = fakeDeps({ moments, missing: ['ai_b'], complete: () => '{}' });
    await handleJointPlan(deps, { a: 'ai_a', b: 'ai_b', kind: 'meal', dmId: 'dm', at: T0 });
    expect(moments).toEqual([]);
  });

  it('the system prompt demands two DIFFERENT voices for the same event', () => {
    const sys = jointMomentsSystem('meal', { name: '小雨', style: '短句' }, { name: '老王' });
    expect(sys).toContain('小雨');
    expect(sys).toContain('老王');
    expect(sys).toContain('互相咬合');
    expect(sys).toContain('短句');
    expect(parseJointMoments({ a: ' x ', b: 'y' })).toEqual({ a: 'x', b: 'y' });
    expect(parseJointMoments({ a: '', b: 'y' })).toBeNull();
    expect(parseJointMoments('nope')).toBeNull();
  });
});

describe('forwarding is free and legible', () => {
  it('the line is a template around the quote — zero generation cost', () => {
    expect(forwardLine('明天休假')).toContain('「明天休假」');
    expect(FORWARD_CHANCE).toBeLessThan(0.5); // occasional, not a firehose
  });

  it('the DM handler hatches with STABLE ids so replays upsert, not multiply', () => {
    const src = readFileSync(resolve(__dirname, '../../src/ai/handlers.ts'), 'utf8');
    expect(src).toContain('`joint_${dmId}_');
    expect(src).toContain('`fwd_${dmId}_');
  });
});

describe('the 聚会 arc', () => {
  it('planning is pure, seeded, and needs an actual group', async () => {
    const { maybeGroupEvent, GROUP_EVENT_CHANCE_PER_WEEK, GROUP_EVENT_LLM_CALLS_PER_PHASE } =
      await import('../../src/ai/group-events');
    expect(GROUP_EVENT_LLM_CALLS_PER_PHASE).toBe(1);
    expect(maybeGroupEvent('g', ['a', 'b'], T0)).toBeNull(); // two people is a chat, not an event
    const one = maybeGroupEvent('g1', ['a', 'b', 'c', 'd'], T0);
    expect(maybeGroupEvent('g1', ['a', 'b', 'c', 'd'], T0)).toEqual(one);
    let hatched = 0;
    for (let i = 0; i < 200; i++) if (maybeGroupEvent(`g${i}`, ['a', 'b', 'c'], T0)) hatched++;
    expect(hatched).toBeGreaterThan(200 * GROUP_EVENT_CHANCE_PER_WEEK * 0.5);
    expect(hatched).toBeLessThan(200 * GROUP_EVENT_CHANCE_PER_WEEK * 1.8);
    // (Purity of this module is guarded by the source-level list above.)
  });

  it('the RSVP round is ONE call that writes every line, names validated', async () => {
    const { handleGroupEvent } = await import('../../src/ai/handlers');
    const { RSVP_MAX } = await import('../../src/ai/group-events');
    let llmCalls = 0;
    const appended: Array<Omit<MessageVM, 'id'>> = [];
    const deps = fakeDeps({
      convs: [groupConv()],
      appended,
      complete: () => {
        llmCalls++;
        return JSON.stringify([
          { name: 'ai_b', text: '我有空！几点？' },
          { name: '不存在的人', text: '我也去' },
          { name: 'ai_b', text: '重复的第二条' },
        ]);
      },
    });
    await handleGroupEvent(deps, {
      convId: 'conv_g', eventId: 'gevt_conv_g_1', initiator: 'ai_a',
      activity: 'hotpot', phase: 'rsvp', at: T0,
    });
    expect(llmCalls).toBe(1); // the cost gate, in vivo
    // Invented names dropped, one line per person, sender resolved to a real id.
    expect(appended).toHaveLength(1);
    expect(appended[0].senderId).toBe('ai_b');
    expect(appended[0].createdAt).toBeGreaterThan(T0);
    expect(appended.length).toBeLessThanOrEqual(RSVP_MAX);
  });

  it('the chain advances propose→rsvp→aftermath and stops at the end or on a dead room', async () => {
    const { chainGroupEvent } = await import('../../src/ai/handlers');
    const { nextPhase } = await import('../../src/ai/group-events');
    expect(nextPhase('propose')).toBe('rsvp');
    expect(nextPhase('rsvp')).toBe('aftermath');
    expect(nextPhase('aftermath')).toBeNull();
    const enqueued: string[] = [];
    const deps = fakeDeps({ convs: [groupConv()] });
    deps.enqueue = async (o) => void enqueued.push(`${o.kind}:${o.id}`);
    await chainGroupEvent(deps, {
      convId: 'conv_g', eventId: 'e1', phase: 'propose', at: T0,
    });
    expect(enqueued).toEqual(['group_event:e1_rsvp']);
    enqueued.length = 0;
    await chainGroupEvent(deps, { convId: 'conv_g', eventId: 'e1', phase: 'aftermath', at: T0 });
    expect(enqueued).toEqual([]); // terminal phase
    await chainGroupEvent(deps, { convId: 'gone', eventId: 'e1', phase: 'propose', at: T0 });
    expect(enqueued).toEqual([]); // deleted room stops the chain
  });

  it('an initiator who left the room cancels the phase', async () => {
    const { handleGroupEvent } = await import('../../src/ai/handlers');
    const g = groupConv();
    g.memberIds = ['ai_b']; // initiator ai_a was removed
    const appended: Array<Omit<MessageVM, 'id'>> = [];
    const deps = fakeDeps({ convs: [g], appended, complete: () => '[]' });
    await handleGroupEvent(deps, {
      convId: 'conv_g', eventId: 'e1', initiator: 'ai_a', activity: 'hike', phase: 'rsvp', at: T0,
    });
    expect(appended).toEqual([]);
  });
});

describe('the 聚会 aftermath post carries photos', () => {
  it('draws from the SAME pickImages pool as an ordinary post, honouring imageTags', async () => {
    const { handleGroupEvent } = await import('../../src/ai/handlers');
    const { aftermathImageCount } = await import('../../src/ai/group-events');
    const { availableRefs } = await import('../../src/data/moments-images');
    // Sweep: the count is seeded, bounded, and sometimes (but not always) zero.
    const counts = Array.from({ length: 60 }, (_, i) => aftermathImageCount(`e${i}`));
    expect(counts.every((n) => n === 0 || n === 1 || n === 3)).toBe(true);
    expect(counts.some((n) => n > 0)).toBe(true);
    expect(aftermathImageCount('e1')).toBe(aftermathImageCount('e1')); // replayable

    // Find an event id whose seeded roll asks for pictures, then check it got them.
    const eventId = ['gevt_a', 'gevt_b', 'gevt_c', 'gevt_d', 'gevt_e', 'gevt_f'].find(
      (id) => aftermathImageCount(id) > 0,
    )!;
    const moments: MomentVM[] = [];
    const deps = fakeDeps({ convs: [groupConv()], moments, complete: () => '火锅吃到打烊' });
    await handleGroupEvent(deps, {
      convId: 'conv_g', eventId, initiator: 'ai_a', activity: 'hotpot',
      phase: 'aftermath', at: T0,
    });
    expect(moments).toHaveLength(1);
    expect(moments[0].imageRefs).toHaveLength(aftermathImageCount(eventId));
    // Every ref comes from the real pool — no fabricated handles.
    const pool = new Set(availableRefs());
    expect(moments[0].imageRefs.every((r) => pool.has(r))).toBe(true);
    // Same event, same grid.
    const again: MomentVM[] = [];
    await handleGroupEvent(fakeDeps({ convs: [groupConv()], moments: again, complete: () => 'x' }), {
      convId: 'conv_g', eventId, initiator: 'ai_a', activity: 'hotpot',
      phase: 'aftermath', at: T0,
    });
    expect(again[0].imageRefs).toEqual(moments[0].imageRefs);
  });

  it('degrades to a text-only post when the material pool is empty — never throws', async () => {
    // An install with no media library, no build-time assets AND no placeholders
    // is what `pickImages` returning [] means. The post must still publish.
    vi.resetModules();
    vi.doMock('../../src/data/moments-images', () => ({ pickImages: () => [] }));
    try {
      const { handleGroupEvent } = await import('../../src/ai/handlers');
      const moments: MomentVM[] = [];
      const deps = fakeDeps({ convs: [groupConv()], moments, complete: () => '爬到一半下雨了' });
      await handleGroupEvent(deps, {
        convId: 'conv_g', eventId: 'gevt_dry', initiator: 'ai_a', activity: 'hike',
        phase: 'aftermath', at: T0,
      });
      expect(moments).toHaveLength(1);
      expect(moments[0].imageRefs).toEqual([]);
      expect(moments[0].text).toBe('爬到一半下雨了');
    } finally {
      vi.doUnmock('../../src/data/moments-images');
      vi.resetModules();
    }
  });
});

describe('the group proposal', () => {
  it('needs two friends, skips trios already sharing a room, is pure', async () => {
    const { maybeGroupInvite } = await import('../../src/ai/agent-invite');
    expect(maybeGroupInvite('ai_a', ['ai_b'], [], T0)).toBeNull();
    // Deterministic.
    const one = maybeGroupInvite('ai_a', ['ai_b', 'ai_c'], [], T0);
    expect(maybeGroupInvite('ai_a', ['ai_b', 'ai_c'], [], T0)).toEqual(one);
    // Find a hatching seed, then show an existing shared room suppresses it.
    for (let i = 0; i < 300; i++) {
      const id = `ai_p${i}`;
      const hit = maybeGroupInvite(id, ['ai_b', 'ai_c'], [], T0);
      if (!hit) continue;
      expect(
        maybeGroupInvite(id, ['ai_b', 'ai_c'], [[id, 'ai_b', 'ai_c', 'ai_z']], T0),
      ).toBeNull();
      return;
    }
    throw new Error('no seed hatched in 300 tries — chance gate broken');
  });

  it('the fired proposal lands in her visible 1:1 with the roster in meta, 名片 attached', async () => {
    const { handleAgentInvite } = await import('../../src/ai/handlers');
    const oneOnOne: ConversationVM = {
      id: 'conv_ai_a', type: 'single', peerId: 'ai_a', title: 'x', avatarColor: 'var(--wx-a)',
      avatarText: 'x', isPinned: false, isMuted: false, unreadCount: 0, mentionMe: false,
      lastMsgPreview: '', lastMsgAt: T0,
    };
    const appended: Array<Omit<MessageVM, 'id'>> = [];
    const deps = fakeDeps({ convs: [oneOnOne], appended });
    deps.visibleConvWithUser = (id) => (id === 'ai_a' ? oneOnOne : undefined);
    await handleAgentInvite(deps, {
      contactId: 'ai_a', friend1: 'ai_b', friend2: 'ai_c', at: T0,
    });
    // The proposal, then a 名片 per friend — "把 Ada 和陈叔拉个群" is empty if
    // you cannot see who they are. This is I13's card type finally having a
    // producer other than the model's own bubbles.
    expect(appended).toHaveLength(3);
    expect(appended.every((m) => m.convId === 'conv_ai_a' && m.senderId === 'ai_a')).toBe(true);
    expect(appended[0].type).toBe('text');
    expect(appended[0].meta?.suggestGroup).toEqual(['ai_a', 'ai_b', 'ai_c']);
    expect(appended.slice(1).map((m) => m.type)).toEqual(['contact_card', 'contact_card']);
    expect(appended.slice(1).map((m) => m.meta?.contactId)).toEqual(['ai_b', 'ai_c']);
    // Cards arrive a few seconds later, in order — rowid order == time order.
    expect(appended[1].createdAt).toBeGreaterThan(appended[0].createdAt);
    expect(appended[2].createdAt).toBeGreaterThan(appended[1].createdAt);
    expect(appended[2].createdAt - T0).toBeLessThan(20_000);
    // Replayable: the same fire produces byte-identical rows (rule #4).
    const again: Array<Omit<MessageVM, 'id'>> = [];
    const depsAgain = fakeDeps({ convs: [oneOnOne], appended: again });
    depsAgain.visibleConvWithUser = () => oneOnOne;
    await handleAgentInvite(depsAgain, {
      contactId: 'ai_a', friend1: 'ai_b', friend2: 'ai_c', at: T0,
    });
    expect(again.map((m) => m.createdAt)).toEqual(appended.map((m) => m.createdAt));
    // A deleted friend kills the proposal.
    appended.length = 0;
    const deps2 = fakeDeps({ convs: [oneOnOne], appended, missing: ['ai_c'] });
    deps2.visibleConvWithUser = () => oneOnOne;
    await handleAgentInvite(deps2, { contactId: 'ai_a', friend1: 'ai_b', friend2: 'ai_c', at: T0 });
    expect(appended).toEqual([]);
  });
});

/**
 * The other half of the proposal (转红): a roster written into meta with nobody
 * reading it is a dead letter — the user never sees the offer, so the feature
 * does not exist. These lock the loop shut: card → picker → the user's own tap.
 */
describe('the group proposal is ACTIONABLE, not a dead letter', () => {
  it('the roster parses into a card only when it is a usable list of ids', async () => {
    const { parseSuggestGroup, SUGGEST_GROUP_MAX } = await import('../../src/ai/agent-invite');
    expect(parseSuggestGroup({ suggestGroup: ['ai_a', 'ai_b', 'ai_c'] })).toEqual([
      'ai_a', 'ai_b', 'ai_c',
    ]);
    expect(parseSuggestGroup({ suggestGroup: ['ai_a', 'ai_a', 'ai_b'] })).toEqual(['ai_a', 'ai_b']);
    // Anything unusable renders as an ordinary text message, never a broken card.
    expect(parseSuggestGroup(undefined)).toBeNull();
    expect(parseSuggestGroup({})).toBeNull();
    expect(parseSuggestGroup({ suggestGroup: 'ai_a,ai_b' })).toBeNull();
    expect(parseSuggestGroup({ suggestGroup: ['ai_a'] })).toBeNull();
    expect(parseSuggestGroup({ suggestGroup: [1, 2, {}] })).toBeNull();
    expect(
      parseSuggestGroup({ suggestGroup: Array.from({ length: 20 }, (_, i) => `ai_${i}`) }),
    ).toHaveLength(SUGGEST_GROUP_MAX);
  });

  it('tapping it hands the roster to 发起群聊 — the AI never creates the room itself', async () => {
    const { suggestGroupHref, presetMemberIds, SUGGEST_GROUP_PARAM } = await import(
      '../../src/ai/agent-invite'
    );
    const href = suggestGroupHref(['ai_a', 'ai_b', 'ai_c']);
    expect(href).toBe('/group-new?preset=ai_a,ai_b,ai_c');
    const param = new URL(`http://x${href}`).searchParams.get(SUGGEST_GROUP_PARAM);
    // The picker pre-ticks the ones that still exist, and nothing else.
    expect(presetMemberIds(param, (id) => id !== 'ai_c')).toEqual(['ai_a', 'ai_b']);
    expect(presetMemberIds(param, () => false)).toEqual([]);
    expect(presetMemberIds(null, () => true)).toEqual([]);

    // Wiring (CLAUDE.md §3.5 "写了没接线 = 没做"): the card renders, the chat
    // page routes the tap, and the picker consumes the preset.
    const read = (f: string) => readFileSync(resolve(__dirname, '../..', f), 'utf8');
    expect(read('src/features/chat/MessageBubble.tsx')).toContain('parseSuggestGroup');
    expect(read('src/features/chat/MessageBubble.tsx')).toContain('邀请你加入群聊');
    expect(read('src/features/chat/ChatPage.tsx')).toContain('onSuggestGroupTap');
    expect(read('src/features/chat/ChatPage.tsx')).toContain('suggestGroupHref');
    const picker = read('src/features/contacts/GroupCreatePage.tsx');
    expect(picker).toContain('presetMemberIds');
    // …and the picker creates the room through THE build path, not a hand-rolled
    // conversation row of its own (group-build owns "a群聊 is born").
    expect(picker).toContain('presetState');
    expect(picker).toContain('buildGroup(');
    // The card path must NOT reach for a group constructor: 建群是用户的动作.
    expect(read('src/features/chat/ChatPage.tsx')).not.toContain('addConversation(');
  });

  it('the model sees a proposal, never the contact ids behind it', async () => {
    const { renderMessageBody } = await import('../../src/ai/render-msg');
    const msg: MessageVM = {
      id: 7, convId: 'conv_ai_a', senderId: 'ai_a', type: 'text',
      content: '突然想到，要不把Ada和陈叔拉一个群？', status: 'sent', createdAt: T0,
      meta: { suggestGroup: ['ai_a', 'ai_b', 'ai_c'] },
    };
    const body = renderMessageBody(msg);
    expect(body).toContain('突然想到');
    expect(body).toContain('拉群邀请');
    // The whole point: internal ids must never enter the model's context.
    expect(body).not.toContain('ai_a');
    expect(body).not.toContain('ai_b');
    expect(body).not.toContain('[object');
    // A quoted proposal keeps both markers, still id-free.
    const quoted = renderMessageBody({ ...msg, meta: { ...msg.meta, quote: '上次说的那事' } });
    expect(quoted).toContain('回复「上次说的那事」');
    expect(quoted).toContain('拉群邀请');
    expect(quoted).not.toContain('ai_c');
    // An ordinary text message is untouched.
    expect(renderMessageBody({ ...msg, meta: {} })).toBe('突然想到，要不把Ada和陈叔拉一个群？');
  });
});

/* ------------------------------ fakes ------------------------------ */

function groupConv(): ConversationVM {
  return {
    id: 'conv_g', type: 'group', title: '群', avatarColor: 'var(--wx-a)', avatarText: '群',
    memberIds: ['ai_a', 'ai_b'], isPinned: false, isMuted: false, unreadCount: 0,
    mentionMe: false, lastMsgPreview: '', lastMsgAt: T0,
  };
}

function fakeDeps(opts: {
  convs?: ConversationVM[];
  appended?: Array<Omit<MessageVM, 'id'>>;
  moments?: MomentVM[];
  missing?: string[];
  complete?: () => string;
}): HandlerDeps {
  const convs = new Map((opts.convs ?? []).map((c) => [c.id, c]));
  const contact = (id: string): ContactVM => ({
    id, type: 'ai', name: id, avatarColor: 'var(--wx-a)', avatarText: 'x', pinyinInitial: 'X', wxid: id,
  });
  return {
    contactById: (id) => (opts.missing?.includes(id) ? undefined : contact(id)),
    personaFor: (id) =>
      opts.missing?.includes(id) ? undefined : makePersona({ contactId: id, core: 'c' }),
    conversationById: (id) => convs.get(id),
    messagesFor: () => [],
    conversationExists: (id) => convs.has(id),
    hooks: {
      appendMessage: async (m) => {
        opts.appended?.push(m);
        return { ...m, id: (opts.appended?.length ?? 0) + 1 } as MessageVM;
      },
      updateMessage: async () => {},
      setTyping: () => {},
      now: () => T0,
    },
    updateMessage: async () => {},
    getMessages: async () => [],
    getMemory: async () => [],
    putConvSummary: async () => {},
    getGlobalTier: async () => 'off',
    getMoment: async () => undefined,
    getRouter: async () =>
      ({
        complete: async () => ({ text: opts.complete?.() ?? '{}' }),
      }) as never,
    now: () => T0,
    addMoment: async (m) => void opts.moments?.push(m),
    enqueue: async () => {},
    visibleConvWithUser: () => undefined,
    claimRedPacket: async () => {},
    acceptTransfer: async () => {},
    returnTransfer: async () => {},
    sendProactiveMessage: async () => {},
    sendGroupProactiveMessage: async () => {},
    runMemExtract: async () => {},
    runAgentDm: async () => true,
    runMomentPost: async () => {},
    runMomentLike: async () => {},
    runMomentComment: async () => {},
    runMomentRepost: async () => {},
    runGift: async () => {},
    ringUser: () => true,
    chainHeartbeat: async () => {},
    chainAgentDm: async () => {},
    chainMomentPost: async () => {},
    playMessageSound: () => {},
    shouldFollowUpAfterRecall: () => false,
    recallFollowUpLine: () => '',
  };
}
