/**
 * M-J2 群聊生命 red-guards.
 *
 * The claim under test: with the app OPEN, a group finally speaks first. The
 * live producer is the self-chaining `group_chatter` kind; before this round
 * the only live producer of a group line was DM spill-over, so an open app
 * meant a silent room. Every guard here was broken on purpose once (skip the
 * quiet-guard, drop the payload seed, unregister the arming loop) and watched
 * turn red before the implementation was restored.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import 'fake-indexeddb/auto';
import {
  nextChatterDelayMs,
  pickChatterSpeaker,
  pickChatterTopic,
  rememberTopic,
  CHATTER_MIN_QUIET_MS,
  CHATTER_TOPIC_MEMORY,
} from '../../src/ai/group-chatter';
import { chainGroupChatter, handleGroupChatter, type HandlerDeps } from '../../src/ai/handlers';
import type { ConversationVM, MessageVM } from '../../src/data/types';
import { makePersona } from '../../src/data/persona-defaults';
import type { ScheduledAction } from '../../src/ai/scheduler';
import { ACTION_LLM_BOUND } from '../../src/ai/cost-gate';

const T0 = 1_754_600_000_000;

const groupConv = (over: Partial<ConversationVM> = {}): ConversationVM =>
  ({
    id: 'g1',
    type: 'group',
    title: '摸鱼小分队',
    memberIds: ['ai_lin', 'ai_ada', 'ai_mo'],
    unread: 0,
    mentionMe: false,
    lastMsgPreview: '',
    lastMsgAt: T0 - 60 * 60_000,
    ...over,
  }) as ConversationVM;

interface Enq {
  kind: string;
  fireAt: number;
  payload: Record<string, unknown>;
  id?: string;
}

function deps(over: Partial<HandlerDeps> = {}, conv = groupConv()) {
  const calls: string[] = [];
  const enqueued: Enq[] = [];
  const d = {
    contactById: (id: string) => ({ id, name: id, avatarColor: 'x', avatarText: 'x' }),
    personaFor: (id: string) =>
      id.startsWith('ai_') ? makePersona({ contactId: id, core: 'c' }) : undefined,
    conversationById: (id: string) => (id === conv.id ? conv : undefined),
    conversationExists: (id: string) => id === conv.id,
    messagesFor: () => [] as MessageVM[],
    now: () => T0,
    getGlobalTier: async () => 'off',
    sendGroupProactiveMessage: async (_c: unknown, speaker: { contactId: string }) =>
      void calls.push(`group:${speaker.contactId}`),
    enqueue: async (o: Enq) => void enqueued.push(o),
    ...over,
  } as unknown as HandlerDeps;
  return { d, calls, enqueued };
}

const act = (payload: Record<string, unknown>, fireAt = T0): ScheduledAction => ({
  id: `gchat_g1_${fireAt}`,
  fireAt,
  kind: 'group_chatter',
  payloadJson: JSON.stringify(payload),
  status: 'pending',
  createdAt: T0 - 1000,
});

describe('chatter planning is seeded and bounded (rule #4)', () => {
  it('same seed → same delay; activity levels order the ranges; 0 is quiet, not dead', () => {
    for (const a of [0, 1, 2, 3] as const) {
      expect(nextChatterDelayMs(a, 's')).toBe(nextChatterDelayMs(a, 's'));
    }
    // Bounds per level, in minutes.
    const bounds: Record<number, [number, number]> = {
      0: [180, 360],
      1: [90, 180],
      2: [40, 90],
      3: [15, 40],
    };
    for (const a of [0, 1, 2, 3] as const) {
      for (let i = 0; i < 20; i++) {
        const ms = nextChatterDelayMs(a, `seed${i}`);
        expect(ms).toBeGreaterThanOrEqual(bounds[a][0] * 60_000);
        expect(ms).toBeLessThanOrEqual(bounds[a][1] * 60_000);
      }
    }
  });

  it('speaker pick is deterministic, member-bound, and dodges the last speaker', () => {
    const members = ['ai_lin', 'ai_ada', 'ai_mo'].map((id) => ({
      contactId: id,
      persona: makePersona({ contactId: id, core: 'c' }),
    }));
    const a = pickChatterSpeaker(members, undefined, 'seed');
    expect(a).toBe(pickChatterSpeaker(members, undefined, 'seed'));
    expect(members.some((m) => m.contactId === a)).toBe(true);
    // Halving the last speaker's weight must show up statistically.
    let repeats = 0;
    for (let i = 0; i < 200; i++) {
      if (pickChatterSpeaker(members, 'ai_lin', `s${i}`) === 'ai_lin') repeats++;
    }
    let base = 0;
    for (let i = 0; i < 200; i++) {
      if (pickChatterSpeaker(members, undefined, `s${i}`) === 'ai_lin') base++;
    }
    expect(repeats).toBeLessThan(base);
    expect(pickChatterSpeaker([{ contactId: 'x' }], undefined, 's')).toBeUndefined();
  });

  it('topic rotation skips the recent ones and survives an all-used pool', () => {
    const topics = ['考研', '猫', '副本'];
    expect(pickChatterTopic(topics, ['考研', '猫'], 's')).toBe('副本');
    // Everything used recently → the pool resets rather than going silent.
    expect(topics).toContain(pickChatterTopic(topics, topics, 's'));
    expect(pickChatterTopic([], [], 's')).toBeUndefined();
    expect(rememberTopic(['a', 'b', 'c'], 'd')).toEqual(['b', 'c', 'd']);
    expect(rememberTopic(['a', 'b', 'c'], 'd').length).toBe(CHATTER_TOPIC_MEMORY);
  });
});

describe('the chain and the work agree (the whole point of the payload seed)', () => {
  it('chain queues the successor carrying THIS round的 speaker and topic', async () => {
    const { d, enqueued } = deps();
    await chainGroupChatter(d, { convId: 'g1', at: T0 });
    expect(enqueued).toHaveLength(1);
    const next = enqueued[0];
    expect(next.kind).toBe('group_chatter');
    expect(next.fireAt).toBeGreaterThan(T0);
    // The successor knows who just spoke — computed, not observed.
    expect(typeof next.payload.lastSpeaker).toBe('string');
    // And the work step, run later with the SAME payload, picks that speaker.
    const { d: d2, calls } = deps();
    await handleGroupChatter(d2, { convId: 'g1', at: T0 }, act({ convId: 'g1', at: T0 }));
    expect(calls).toEqual([`group:${next.payload.lastSpeaker}`]);
  });

  it('a deleted conversation ends the chain instead of resurrecting it', async () => {
    const { d, enqueued } = deps({ conversationExists: () => false });
    await chainGroupChatter(d, { convId: 'g1', at: T0 });
    expect(enqueued).toEqual([]);
  });
});

describe('the work step knows when NOT to speak', () => {
  it('holds the line while the room is still warm (someone spoke minutes ago)', async () => {
    const conv = groupConv({ lastMsgAt: T0 - CHATTER_MIN_QUIET_MS + 1000 });
    const { d, calls } = deps({}, conv);
    await handleGroupChatter(d, { convId: 'g1', at: T0 }, act({ convId: 'g1', at: T0 }));
    expect(calls).toEqual([]);
  });

  it('never speaks into a hidden conversation (AI↔AI DM must stay silent surface)', async () => {
    const conv = groupConv({ isHidden: true });
    const { d, calls } = deps({}, conv);
    await handleGroupChatter(d, { convId: 'g1', at: T0 }, act({ convId: 'g1', at: T0 }));
    expect(calls).toEqual([]);
  });

  it('speaks exactly once into a quiet room', async () => {
    const { d, calls } = deps();
    await handleGroupChatter(d, { convId: 'g1', at: T0 }, act({ convId: 'g1', at: T0 }));
    expect(calls).toHaveLength(1);
    expect(calls[0].startsWith('group:ai_')).toBe(true);
  });
});

describe('wiring (写了没接线 = 没做)', () => {
  const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

  it('the foreground pass arms one chatter chain per visible group', () => {
    const src = read('src/app/useSchedulerRuntime.ts');
    expect(src).toContain('scheduleGroupChatter(');
    expect(src).toContain("a.kind === 'group_chatter'");
  });

  it('group_chatter is LLM-bound for the cost gate', () => {
    expect(ACTION_LLM_BOUND.group_chatter).toBe(true);
  });

  it('the group sticker battle exists in the GROUP branch, not just the single one', () => {
    const src = read('src/features/chat/ChatPage.tsx');
    const groupBranch = src.slice(src.indexOf("conv.type === 'group'"));
    expect(groupBranch).toContain('battleReply(');
    expect(groupBranch).toContain("kind: 'sticker_reply'");
  });

  it('group extraction demands more material than a 1:1 (per-room calibration)', async () => {
    const { MEM_EXTRACT_MIN_NEW, MEM_EXTRACT_MIN_NEW_GROUP } = await import(
      '../../src/ai/memory-service'
    );
    expect(MEM_EXTRACT_MIN_NEW_GROUP).toBeGreaterThan(MEM_EXTRACT_MIN_NEW);
    // ChatPage's group unmount passes the group flag — the calibration is wired.
    expect(read('src/features/chat/ChatPage.tsx')).toContain('{ group: true }');
  });

  it('cliqueLineFor batches its stance reads (no await inside the pair loops)', () => {
    const src = read('src/ai/group-engine.ts');
    const fn = src.slice(src.indexOf('async function cliqueLineFor'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    expect(body).toContain('Promise.all');
    expect(body).not.toMatch(/for[^\n]*\n[^}]*await getStance/);
  });
});
