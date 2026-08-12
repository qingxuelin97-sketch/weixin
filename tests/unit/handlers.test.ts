import { describe, it, expect, vi } from 'vitest';
import {
  handleRpGrab,
  handleTransferAccept,
  handleHeartbeat,
  chainHeartbeat,
  heartbeatTarget,
  handleRecall,
  handleGroupMsg,
  handleMemExtract,
  handleAgentDm,
  handleMomentPost,
  handleMomentComment,
  dmPlanFrom,
  type HandlerDeps,
} from '../../src/ai/handlers';
import { makePersona } from '../../src/data/persona-defaults';
import type { ContactVM, ConversationVM, MessageVM, MomentVM } from '../../src/data/types';
import type { ScheduledAction } from '../../src/ai/scheduler';

/**
 * The handlers, finally testable (M-E1).
 *
 * These eleven functions decide whether an AI speaks, stays silent, or keeps its
 * chain alive — and until this milestone every one of them lived inside a React
 * useEffect closure with no seam to call it through. Zero tests, on the branch
 * where "she went quiet forever" is a possible outcome.
 */

const T0 = 1_755_000_000_000;

const contact = (id: string, name = id): ContactVM => ({
  id,
  type: 'ai',
  name,
  avatarColor: '#000',
  avatarText: name[0],
});

const conv = (id: string, over: Partial<ConversationVM> = {}): ConversationVM => ({
  id,
  type: 'single',
  peerId: 'ai_lin',
  title: 't',
  avatarColor: '#000',
  avatarText: 't',
  isPinned: false,
  isMuted: false,
  unreadCount: 0,
  mentionMe: false,
  lastMsgPreview: '',
  lastMsgAt: T0,
  ...over,
});

interface Harness {
  deps: HandlerDeps;
  appended: Array<Omit<MessageVM, 'id'>>;
  updated: MessageVM[];
  calls: string[];
  sounds: number[];
}

function harness(over: Partial<HandlerDeps> = {}): Harness {
  const appended: Array<Omit<MessageVM, 'id'>> = [];
  const updated: MessageVM[] = [];
  const calls: string[] = [];
  const sounds: number[] = [];
  const conversations = new Map<string, ConversationVM>([
    ['conv_lin', conv('conv_lin')],
    ['g1', conv('g1', { type: 'group', memberIds: ['ai_lin', 'ai_ada'] })],
  ]);
  const messages = new Map<string, MessageVM[]>();

  const deps: HandlerDeps = {
    contactById: (id) => (id.startsWith('ai_') || id === 'self' ? contact(id) : undefined),
    personaFor: (id) => (id.startsWith('ai_') ? makePersona({ contactId: id, core: 'c' }) : undefined),
    conversationById: (id) => conversations.get(id),
    messagesFor: (id) => messages.get(id) ?? [],
    conversationExists: (id) => conversations.has(id),

    hooks: {
      appendMessage: async (m) => {
        appended.push(m);
        return { ...m, id: appended.length } as MessageVM;
      },
      updateMessage: async (m) => void updated.push(m),
      setTyping: () => {},
      now: () => T0,
    },
    updateMessage: async (m) => void updated.push(m),

    getMessages: async (id) => messages.get(id) ?? [],
    getMemory: async () => [],
    putConvSummary: async () => {},
    getGlobalTier: async () => 'off',
    getMoment: async (id) =>
      id === 'mo1'
        ? ({ id: 'mo1', authorId: 'ai_ada', text: 'x', imageRefs: [], isNsfw: false, createdAt: T0 } as MomentVM)
        : undefined,

    getRouter: async () => ({}) as never,
    now: () => T0,

    claimRedPacket: async (rpId, contactId) => void calls.push(`claim:${rpId}:${contactId}`),
    acceptTransfer: async (id) => void calls.push(`accept:${id}`),
    sendProactiveMessage: async (convId, peer, _p, _t, _h, at, opts) =>
      void calls.push(`proactive:${convId}:${peer.id}:${at ?? '-'}:${opts?.nudge ? 'nudge' : 'plain'}`),
    sendGroupProactiveMessage: async (c, speaker, members) =>
      void calls.push(`group:${c.id}:${speaker.contactId}:${members.length}`),
    runMemExtract: async (a) => void calls.push(`mem:${a.convId}:${a.uptoMsgId}`),
    runAgentDm: async (p) => {
      calls.push(`dm:${p.a}:${p.b}`);
      return true;
    },
    runMomentPost: async (_p, peer) => void calls.push(`post:${peer.id}`),
    runMomentLike: async (m, c) => void calls.push(`like:${m}:${c}`),
    runMomentComment: async (m, c, _p, authorName) =>
      void calls.push(`comment:${m}:${c.id}:${authorName}`),
    runGift: async (p) => void calls.push(`gift:${p.kind}:${p.contactId}:${p.amountFen}`),

    chainHeartbeat: async (persona, convId) => void calls.push(`chainHb:${persona.contactId}:${convId}`),
    chainAgentDm: async () => void calls.push('chainDm'),
    chainMomentPost: async (p) => void calls.push(`chainPost:${p.contactId}`),

    playMessageSound: (at) => void sounds.push(at),
    shouldFollowUpAfterRecall: () => false,
    recallFollowUpLine: () => '刚刚发错了',
    ...over,
  };
  return { deps, appended, updated, calls, sounds };
}

const action = (over: Partial<ScheduledAction> = {}): ScheduledAction => ({
  id: 'a1',
  fireAt: T0,
  kind: 'heartbeat',
  payloadJson: '{}',
  status: 'pending',
  createdAt: T0,
  ...over,
});

/* ------------------------------------------------------------------ */

describe('malformed payloads are inert, never fatal', () => {
  it('every handler tolerates an empty payload', async () => {
    const { deps, calls, appended } = harness();
    await handleRpGrab(deps, {});
    await handleTransferAccept(deps, {});
    await handleHeartbeat(deps, {}, action());
    await handleRecall(deps, {});
    await handleGroupMsg(deps, {}, action());
    await handleMemExtract(deps, {});
    await handleAgentDm(deps, {});
    await handleMomentPost(deps, {});
    await handleMomentComment(deps, {});
    expect(calls).toEqual([]);
    expect(appended).toEqual([]);
  });

  it('a payload with wrong-typed fields does not throw', async () => {
    const { deps } = harness();
    await expect(
      handleHeartbeat(deps, { contactId: 42, convId: null, at: 'soon' }, action()),
    ).resolves.toBeUndefined();
  });
});

describe('heartbeat: a deleted conversation ends the chain, not the wallet', () => {
  it('does nothing when the conversation is gone', async () => {
    const { deps, calls } = harness({ conversationExists: () => false });
    await handleHeartbeat(deps, { contactId: 'ai_lin', convId: 'conv_lin' }, action());
    // The bug this replaces: generate a reply, find nowhere to put it, chain the
    // next one — forever, surviving restarts because the chain lives in the DB.
    expect(calls).toEqual([]);
  });

  it('does not chain a successor for a deleted conversation either', async () => {
    const { deps, calls } = harness({ conversationExists: () => false });
    await chainHeartbeat(deps, { contactId: 'ai_lin', convId: 'conv_lin' });
    expect(calls).toEqual([]);
  });

  it('chains for a live conversation', async () => {
    const { deps, calls } = harness();
    await chainHeartbeat(deps, { contactId: 'ai_lin', convId: 'conv_lin' });
    expect(calls).toEqual(['chainHb:ai_lin:conv_lin']);
  });

  it('heartbeatTarget refuses a contact with no persona', () => {
    const { deps } = harness({ personaFor: () => undefined });
    expect(heartbeatTarget(deps, { contactId: 'ai_lin', convId: 'conv_lin' })).toBeNull();
  });
});

describe('heartbeat: the pre-announced body', () => {
  it('persists the advertised text verbatim, stamped when it was advertised', async () => {
    const { deps, appended, sounds, calls } = harness();
    await handleHeartbeat(
      deps,
      { contactId: 'ai_lin', convId: 'conv_lin', body: '在干嘛呢', at: T0 - 5000 },
      action({ fireAt: T0 }),
    );
    // Regenerating here would contradict what the lock screen already showed.
    expect(appended[0].content).toBe('在干嘛呢');
    expect(appended[0].createdAt).toBe(T0 - 5000);
    expect(sounds).toEqual([T0 - 5000]);
    expect(calls).toEqual([]); // no generation happened
  });

  it('falls back to the action’s fireAt when no `at` was given', async () => {
    const { deps, appended } = harness();
    await handleHeartbeat(deps, { contactId: 'ai_lin', convId: 'conv_lin', body: '嗨' }, action({ fireAt: 999 }));
    expect(appended[0].createdAt).toBe(999);
  });

  it('generates when there is no pre-announced body, and passes the nudge flag', async () => {
    const { deps, calls } = harness();
    await handleHeartbeat(deps, { contactId: 'ai_lin', convId: 'conv_lin', nudge: true }, action());
    expect(calls).toEqual(['proactive:conv_lin:ai_lin:-:nudge']);
  });
});

describe('recall', () => {
  it('is idempotent — a re-fired action on an already-recalled message stops', async () => {
    const m: MessageVM = {
      id: 7,
      convId: 'conv_lin',
      senderId: 'ai_lin',
      type: 'text',
      content: 'x',
      status: 'sent',
      createdAt: T0,
      isRecalled: true,
    };
    const { deps, updated } = harness({ messagesFor: () => [m] });
    await handleRecall(deps, { msgId: 7, convId: 'conv_lin' });
    expect(updated).toEqual([]);
  });

  it('flips the flag and optionally adds the cover line', async () => {
    const m: MessageVM = {
      id: 7,
      convId: 'conv_lin',
      senderId: 'ai_lin',
      type: 'text',
      content: '发错了',
      status: 'sent',
      createdAt: T0,
    };
    const { deps, updated, appended } = harness({
      messagesFor: () => [m],
      shouldFollowUpAfterRecall: () => true,
    });
    await handleRecall(deps, { msgId: 7, convId: 'conv_lin' });
    expect(updated[0].isRecalled).toBe(true);
    expect(appended[0].content).toBe('刚刚发错了');
  });

  it('never adds a cover line for the USER’s own recall', async () => {
    const m: MessageVM = {
      id: 8,
      convId: 'conv_lin',
      senderId: 'self',
      type: 'text',
      content: 'oops',
      status: 'sent',
      createdAt: T0,
    };
    const { deps, appended } = harness({
      messagesFor: () => [m],
      shouldFollowUpAfterRecall: () => true,
    });
    await handleRecall(deps, { msgId: 8, convId: 'conv_lin' });
    expect(appended).toEqual([]);
  });
});

describe('group_msg', () => {
  it('refuses to run against a single chat', async () => {
    const { deps, calls } = harness();
    await handleGroupMsg(deps, { convId: 'conv_lin', contactId: 'ai_lin' }, action());
    expect(calls).toEqual([]);
  });

  it('builds the full member roster for the speaker', async () => {
    const { deps, calls } = harness();
    await handleGroupMsg(deps, { convId: 'g1', contactId: 'ai_lin' }, action());
    expect(calls).toEqual(['group:g1:ai_lin:2']);
  });

  it('stays silent when the named speaker is not a persona-backed member', async () => {
    const { deps, calls } = harness();
    await handleGroupMsg(deps, { convId: 'g1', contactId: 'ai_ghost' }, action());
    expect(calls).toEqual([]);
  });
});

describe('mem_extract', () => {
  it('skips a deleted conversation — facts must not cite messages that are gone', async () => {
    const { deps, calls } = harness({ conversationExists: () => false });
    await handleMemExtract(deps, { convId: 'conv_lin', contactId: 'ai_lin', uptoMsgId: 12 });
    expect(calls).toEqual([]);
  });

  it('runs for a live conversation', async () => {
    const { deps, calls } = harness();
    await handleMemExtract(deps, { convId: 'conv_lin', contactId: 'ai_lin', uptoMsgId: 12 });
    expect(calls).toEqual(['mem:conv_lin:12']);
  });

  it('ignores a zero upto marker (nothing to cover)', async () => {
    const { deps, calls } = harness();
    await handleMemExtract(deps, { convId: 'conv_lin', contactId: 'ai_lin', uptoMsgId: 0 });
    expect(calls).toEqual([]);
  });
});

describe('agent_dm', () => {
  it('needs all three ids before it will run', () => {
    expect(dmPlanFrom({ a: 'x', b: 'y' }, T0)).toBeNull();
    expect(dmPlanFrom({ a: 'x', b: 'y', groupId: 'g1' }, T0)?.fireAt).toBe(T0);
  });

  it('runs the session when the plan is complete', async () => {
    const { deps, calls } = harness();
    await handleAgentDm(deps, { a: 'ai_lin', b: 'ai_ada', groupId: 'g1' });
    expect(calls).toEqual(['dm:ai_lin:ai_ada']);
  });
});

describe('moments', () => {
  it('names the author for a comment, and says 你 for the user’s own post', async () => {
    const { deps, calls } = harness({
      getMoment: async () =>
        ({ id: 'mo1', authorId: 'self', text: 'x', imageRefs: [], isNsfw: false, createdAt: T0 }) as MomentVM,
    });
    await handleMomentComment(deps, { momentId: 'mo1', contactId: 'ai_lin' });
    expect(calls).toEqual(['comment:mo1:ai_lin:你']);
  });

  it('drops a comment on a moment that no longer exists', async () => {
    const { deps, calls } = harness({ getMoment: async () => undefined });
    await handleMomentComment(deps, { momentId: 'gone', contactId: 'ai_lin' });
    expect(calls).toEqual([]);
  });
});

describe('money handlers use the display name the user actually sees', () => {
  it('prefers a remark over the contact name', async () => {
    const claim = vi.fn(async () => {});
    const { deps } = harness({
      contactById: () => ({ ...contact('ai_lin', '林'), remark: '小林同学' }),
      claimRedPacket: claim,
    });
    await handleRpGrab(deps, { rpId: 'rp1', contactId: 'ai_lin' });
    expect(claim).toHaveBeenCalledWith('rp1', 'ai_lin', '小林同学', deps.hooks);
  });

  it('falls back to the raw id rather than showing nothing', async () => {
    const claim = vi.fn(async () => {});
    const { deps } = harness({ contactById: () => undefined, claimRedPacket: claim });
    await handleRpGrab(deps, { rpId: 'rp1', contactId: 'ai_x' });
    expect(claim).toHaveBeenCalledWith('rp1', 'ai_x', 'ai_x', deps.hooks);
  });
});
