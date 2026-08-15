import { describe, it, expect } from 'vitest';
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
    for (const f of ['src/ai/social-plans.ts', 'src/ai/agent-forward.ts']) {
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
    sendProactiveMessage: async () => {},
    sendGroupProactiveMessage: async () => {},
    runMemExtract: async () => {},
    runAgentDm: async () => true,
    runMomentPost: async () => {},
    runMomentLike: async () => {},
    runMomentComment: async () => {},
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
