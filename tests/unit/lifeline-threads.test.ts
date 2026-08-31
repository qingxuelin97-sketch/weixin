import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { repo } from '../../src/db/repo';
import {
  lifelineAt,
  lifelineDirective,
  agendaAt,
  CONCURRENT_ARCS,
} from '../../src/ai/lifeline';
import {
  detectThreads,
  threadsFromFacts,
  pickThread,
  threadDirective,
  threadAwareness,
  shouldSurfaceThread,
  isClosed,
  type Thread,
} from '../../src/ai/threads';
import {
  recordAffect,
  getAffect,
  decayAffect,
  affectedParams,
  affectLine,
  classifyUserMessage,
  AFFECT_FLOOR,
} from '../../src/lib/affect';
import { moodParams } from '../../src/lib/mood';
import { makePersona } from '../../src/data/persona-defaults';
import type { MessageVM, MemoryFactVM } from '../../src/data/types';

/**
 * M-E3: a life between messages, feelings that answer to what you do, and the
 * one thing a friend does that this app could not — bringing something back up.
 */

const T0 = 1_755_200_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const EPOCH = T0 - 365 * DAY;

const persona = makePersona({ contactId: 'ai_lin', core: '插画师' });

function msg(over: Partial<MessageVM> & Pick<MessageVM, 'id' | 'content'>): MessageVM {
  return {
    convId: 'c1',
    senderId: 'self',
    type: 'text',
    status: 'sent',
    createdAt: T0,
    ...over,
  } as MessageVM;
}

/* ==================== lifeline ==================== */

describe('lifeline', () => {
  it('is a pure function of (contactId, t) — replay must agree exactly', () => {
    expect(lifelineAt(persona, T0, EPOCH)).toEqual(lifelineAt(persona, T0, EPOCH));
  });

  it('runs the configured number of concurrent arcs', () => {
    expect(lifelineAt(persona, T0, EPOCH)).toHaveLength(CONCURRENT_ARCS);
  });

  it('advances over weeks rather than flickering day to day', () => {
    const today = lifelineAt(persona, T0, EPOCH);
    const tomorrow = lifelineAt(persona, T0 + DAY, EPOCH);
    const muchLater = lifelineAt(persona, T0 + 120 * DAY, EPOCH);
    expect(tomorrow.map((a) => a.stage)).toEqual(today.map((a) => a.stage));
    expect(muchLater.map((a) => a.stage)).not.toEqual(today.map((a) => a.stage));
  });

  it('gives different agents different lives', () => {
    const other = makePersona({ contactId: 'ai_ada', core: '程序员' });
    const a = lifelineAt(persona, T0, EPOCH).map((x) => x.stage).join();
    const b = lifelineAt(other, T0, EPOCH).map((x) => x.stage).join();
    expect(a).not.toBe(b);
  });

  it('starts at the beginning for an agent whose epoch is now', () => {
    // A contact added today must not open mid-arc as if it had a past.
    const fresh = lifelineAt(persona, T0, T0);
    expect(fresh.every((a) => a.stageIndex === 0)).toBe(true);
  });

  it('resolves for a decade-old epoch without hanging', () => {
    const start = Date.now();
    expect(lifelineAt(persona, T0, T0 - 3650 * DAY)).toHaveLength(CONCURRENT_ARCS);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('frames the directive as background, not as a topic list', () => {
    const line = lifelineDirective(lifelineAt(persona, T0, EPOCH));
    expect(line).toContain('别主动汇报');
    expect(lifelineDirective([])).toBe('');
  });
});

describe('agenda', () => {
  it('is deterministic and holds a block for hours, not minutes', () => {
    const a = agendaAt(persona, T0);
    expect(agendaAt(persona, T0)).toEqual(a);
    // Same 2h bucket → same answer, so a busy block reads as a real one.
    expect(agendaAt(persona, T0 + 60_000)).toEqual(a);
  });

  it('leaves her reachable most of the time', () => {
    let busy = 0;
    for (let i = 0; i < 200; i++) if (agendaAt(persona, T0 + i * 2 * HOUR).busy) busy++;
    expect(busy).toBeGreaterThan(0);
    expect(busy).toBeLessThan(80); // an unreachable friend is not a feature
  });

  it('makes her harder to reach during a work crunch', () => {
    const crunch = [
      { domain: 'work' as const, stage: 'x', stageIndex: 1, progress: 0.5, weight: 1, startedAt: T0 },
    ];
    let plain = 0;
    let busy = 0;
    for (let i = 0; i < 300; i++) {
      const t = T0 + i * 2 * HOUR;
      if (agendaAt(persona, t).busy) plain++;
      if (agendaAt(persona, t, crunch).busy) busy++;
    }
    expect(busy).toBeGreaterThan(plain);
  });

  it('always gives a reason when busy', () => {
    for (let i = 0; i < 300; i++) {
      const a = agendaAt(persona, T0 + i * 2 * HOUR);
      if (a.busy) expect(a.reason).not.toBe('');
    }
  });
});

/* ==================== threads ==================== */

describe('thread detection', () => {
  it('finds plans, troubles, waits and promises', () => {
    const found = detectThreads(
      [
        msg({ id: 1, content: '明天要去看牙' }),
        msg({ id: 2, content: '最近有点感冒' }),
        msg({ id: 3, content: '投了简历，还在等通知' }),
        msg({ id: 4, content: '说好了下次一起去吃火锅' }),
      ],
      'c1',
    );
    expect(found.map((t) => t.kind)).toEqual(['plan', 'trouble', 'wait', 'promise']);
  });

  it('ignores questions — a question is the follow-up, not the thread', () => {
    // Detecting it would make agents ask about their own asks.
    expect(detectThreads([msg({ id: 1, content: '你明天要去看牙吗？' })], 'c1')).toEqual([]);
  });

  it('ignores recalled and non-text messages', () => {
    expect(
      detectThreads(
        [
          msg({ id: 1, content: '明天要去看牙', isRecalled: true }),
          msg({ id: 2, content: '', type: 'rp' }),
        ],
        'c1',
      ),
    ).toEqual([]);
  });

  it('gives every thread a stable id so it is only ever asked once', () => {
    const a = detectThreads([msg({ id: 5, content: '明天要去面试' })], 'c1');
    const b = detectThreads([msg({ id: 5, content: '明天要去面试' })], 'c1');
    expect(a[0].id).toBe(b[0].id);
  });
});

describe('thread selection', () => {
  const thread = (over: Partial<Thread> = {}): Thread => ({
    id: 't1',
    kind: 'plan',
    text: '明天要去看牙',
    speakerId: 'self',
    saidAt: T0 - 2 * DAY,
    ripeAt: T0 - DAY,
    staleAt: T0 + DAY,
    ...over,
  });

  it('does not ask before the thread is ripe', () => {
    const t = thread({ ripeAt: T0 + DAY });
    expect(pickThread([t], [], T0, { seed: 's' })).toBeNull();
  });

  it('does not ask once it has gone stale', () => {
    expect(pickThread([thread({ staleAt: T0 - HOUR })], [], T0, { seed: 's' })).toBeNull();
  });

  it('never asks about the same thread twice', () => {
    const t = thread();
    expect(pickThread([t], [], T0, { seed: 's', used: new Set([t.id]) })).toBeNull();
  });

  it('drops a thread the conversation already closed', () => {
    // Asking about something you discussed yesterday is the most annoying
    // possible failure mode, so the check errs toward "closed".
    const t = thread({ text: '明天要去看牙' });
    const later = [msg({ id: 9, content: '牙看完了，没什么大事', createdAt: T0 - HOUR })];
    expect(isClosed(t, later)).toBe(true);
    expect(pickThread([t], later, T0, { seed: 's' })).toBeNull();
  });

  it('prefers what the USER said over the agent’s own words', () => {
    const mine = thread({ id: 'mine', speakerId: 'self', ripeAt: T0 - HOUR });
    const hers = thread({ id: 'hers', speakerId: 'ai_lin', ripeAt: T0 - 10 * DAY });
    const picked = pickThread([hers, mine], [], T0, { seed: 'stable' });
    // Reporting on her own plan is narration; asking about yours is warmth.
    if (picked) expect(picked.id).toBe('mine');
  });

  it('sometimes lets one go — a checklist is not a friend', () => {
    let skipped = 0;
    for (let i = 0; i < 40; i++) {
      if (pickThread([thread({ id: `t${i}` })], [], T0, { seed: `s${i}` }) === null) skipped++;
    }
    expect(skipped).toBeGreaterThan(0);
    expect(skipped).toBeLessThan(30);
  });

  it('is deterministic for the same seed', () => {
    const t = [thread()];
    expect(pickThread(t, [], T0, { seed: 'x' })).toEqual(pickThread(t, [], T0, { seed: 'x' }));
  });

  it('writes a directive, never the line itself', () => {
    const d = threadDirective(thread({ saidAt: T0 - 3 * DAY }), T0);
    expect(d).toContain('3天前');
    expect(d).toContain('看牙');
    expect(d).toContain('不要连环追问');
  });
});

describe('threads from long-term memory', () => {
  const fact = (over: Partial<MemoryFactVM>): MemoryFactVM => ({
    id: 'f1',
    subjectId: 'ai_lin',
    fact: '他下周要去面试',
    importance: 4,
    sensitivity: 'normal',
    evidenceMsgIds: [1],
    status: 'confirmed',
    isPinned: false,
    createdAt: T0 - 2 * DAY,
    source: 'chat',
    ...over,
  });

  it('recovers a thread that has scrolled out of the message window', () => {
    expect(threadsFromFacts([fact({})], 'ai_lin')).toHaveLength(1);
  });

  it('never builds a thread out of gossip', () => {
    // Asking about something you only overheard from a third party is a tell.
    expect(threadsFromFacts([fact({ source: 'hearsay' })], 'ai_lin')).toEqual([]);
  });

  it('ignores archived facts', () => {
    expect(threadsFromFacts([fact({ status: 'archived' })], 'ai_lin')).toEqual([]);
  });
});

/* ==================== affect ==================== */

describe('affect', () => {
  beforeEach(async () => {
    await repo.putSetting('affect:ai_test', undefined);
  });

  it('decays back toward the day’s mood over hours', () => {
    const hot = { valence: 0.8, arousal: 0.5, at: T0 };
    expect(decayAffect(hot, T0 + 24 * HOUR, 8).valence).toBeLessThan(0.1);
    expect(decayAffect(hot, T0, 8).valence).toBeCloseTo(0.8, 5);
  });

  it('accumulates but never saturates from one gesture', async () => {
    const first = await recordAffect('ai_acc', 'user_warm', T0);
    const second = await recordAffect('ai_acc', 'user_warm', T0);
    expect(second.valence).toBeGreaterThan(first.valence);
    expect(second.valence).toBeLessThanOrEqual(1);
  });

  it('persists and reads back decayed', async () => {
    await recordAffect('ai_persist', 'gift_received', T0);
    const later = await getAffect('ai_persist', T0 + 48 * HOUR);
    expect(later.valence).toBeLessThan(0.1);
    expect(later.valence).toBeGreaterThanOrEqual(0);
  });

  it('treats an absent row as neutral rather than throwing', async () => {
    const a = await getAffect('ai_never_seen', T0);
    expect(a).toEqual({ valence: 0, arousal: 0, at: T0 });
  });

  it('shifts pacing through the multipliers mood.ts already had', () => {
    const base = moodParams('calm');
    const happy = affectedParams(base, { valence: 0.8, arousal: 0.6, at: T0 });
    const hurt = affectedParams(base, { valence: -0.8, arousal: 0.1, at: T0 });
    expect(happy.proactMul).toBeGreaterThan(base.proactMul);
    expect(hurt.proactMul).toBeLessThan(base.proactMul);
    // Bounded: no pulse should make her unrecognisably fast or mute.
    expect(happy.cpmMul).toBeLessThanOrEqual(1.6);
    expect(hurt.proactMul).toBeGreaterThanOrEqual(0.3);
  });

  it('says nothing when the pulse is small — a described feeling she does not have is worse than silence', () => {
    const mood = '你今天心情平平常常。';
    expect(affectLine(mood, { valence: AFFECT_FLOOR / 2, arousal: 0, at: T0 })).toBe(mood);
    expect(affectLine(mood, { valence: 0.9, arousal: 0.4, at: T0 })).not.toBe(mood);
  });

  it('classifies only unmistakable signals', () => {
    expect(classifyUserMessage('对不起，是我不好')).toBe('user_warm');
    expect(classifyUserMessage('谢谢你啊')).toBe('user_warm');
    expect(classifyUserMessage('滚，烦死了')).toBe('conflict');
    expect(classifyUserMessage('哦')).toBe('user_cold');
    // …and stays out of the way otherwise. A false "she thinks I insulted her"
    // costs far more than a missed compliment.
    expect(classifyUserMessage('嗯，我也这么觉得')).toBeNull();
    expect(classifyUserMessage('今天天气不错')).toBeNull();
    expect(classifyUserMessage('')).toBeNull();
  });

  it('survives a corrupt stored row', async () => {
    await repo.putSetting('affect:ai_broken', { nonsense: true });
    await expect(getAffect('ai_broken', T0)).resolves.toEqual({
      valence: 0,
      arousal: 0,
      at: T0,
    });
  });
});

/* ==================== threads in ordinary conversation (M-G0) ==================== */

/**
 * Threads shipped in M-E3 wired to `sendProactiveMessage` and nowhere else, so
 * "上次你说要去看牙" could only ever arrive hours later as an unprompted
 * message — while you were actually talking to her the system was off.
 *
 * Turning it on for every reply would be the wrong fix: a friend who works
 * through your old topics on every turn is a checklist. So it opens only where
 * a person reaches for something to say.
 */
describe('when a loose thread may surface mid-conversation', () => {
  const T = 1_755_400_000_000;
  const msg = (over: Partial<MessageVM>): MessageVM =>
    ({
      id: 1,
      convId: 'c1',
      senderId: 'self',
      type: 'text',
      content: '今天上班好累啊，开了一整天的会',
      status: 'sent',
      createdAt: T,
      ...over,
    }) as MessageVM;

  it('opens on a filler turn that carries no topic of its own', () => {
    expect(shouldSurfaceThread([msg({ content: '嗯' })], T)).toBe(true);
    expect(shouldSurfaceThread([msg({ content: '在吗' })], T)).toBe(true);
  });

  it('stays shut when the user actually said something', () => {
    // Her reply belongs to what you just said, not to a topic from Tuesday.
    expect(shouldSurfaceThread([msg({})], T)).toBe(false);
  });

  it('opens when the conversation is resuming after a real gap', () => {
    const older = msg({ id: 1, createdAt: T - 20 * 3_600_000 });
    const now = msg({ id: 2, createdAt: T });
    expect(shouldSurfaceThread([older, now], T)).toBe(true);
  });

  it('never opens off the back of her own message', () => {
    // Otherwise she would be answering herself with an old topic.
    expect(shouldSurfaceThread([msg({ senderId: 'ai_lin', content: '嗯' })], T)).toBe(false);
    expect(shouldSurfaceThread([], T)).toBe(false);
  });

  it('phrases the reply-path version as background, not as an instruction', () => {
    const thread = {
      id: 't1',
      kind: 'plan' as const,
      text: '去看牙',
      speakerId: 'self',
      convId: 'c1',
      saidAt: T - 3 * 86_400_000,
      ripeAt: T - 86_400_000,
      staleAt: T + 86_400_000,
    };
    const awareness = threadAwareness(thread, T);
    expect(awareness).toContain('去看牙');
    // The user's actual message has to stay the subject of a reply.
    expect(awareness).toContain('背景不是任务');
    expect(awareness).not.toContain('自然地问一句');
    // The proactive form still instructs, because there she opens the thread.
    expect(threadDirective(thread, T)).toContain('自然地问一句');
  });
});
