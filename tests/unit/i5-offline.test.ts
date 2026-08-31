import { describe, it, expect } from 'vitest';
import { simulate, LIMITS, type SimInput } from '../../src/ai/simulate';
import { makePersona } from '../../src/data/persona-defaults';

/**
 * Offline social backfill (M-I5): coming back to a like stamped 3am on last
 * night's post, or to two friends whose private chat clearly kept running.
 * The invariants: bounded, seeded, never self-reacting, never time-traveling.
 */

const T0 = new Date(2026, 6, 20, 8, 0).getTime();
const HOUR = 3_600_000;

const input = (over: Partial<SimInput> = {}): SimInput => ({
  singles: [
    {
      contactId: 'ai_a',
      convId: 'conv_a',
      persona: makePersona({ contactId: 'ai_a', core: 'c', likeRate: 0.9, commentRate: 0.4 }),
      lastMsgAt: T0 - HOUR,
    },
    {
      contactId: 'ai_b',
      convId: 'conv_b',
      persona: makePersona({ contactId: 'ai_b', core: 'c', likeRate: 0.9, commentRate: 0.4 }),
      lastMsgAt: T0 - HOUR,
    },
  ],
  groups: [{ convId: 'conv_g', memberIds: ['ai_a', 'ai_b', 'ai_c'], lastMsgAt: T0 - HOUR }],
  recentMoments: [
    { id: 'm1', authorId: 'ai_a', createdAt: T0 - 2 * HOUR },
    { id: 'm2', authorId: 'self', createdAt: T0 - HOUR },
  ],
  ...over,
});

describe('offline 赞评', () => {
  it('plans bounded reactions on pre-absence posts, never by the author, never before the post', () => {
    const plan = simulate(T0, T0 + 10 * HOUR, input(), 'seed');
    const reactions = plan.events.filter(
      (e) => e.kind === 'moment_like' || e.kind === 'moment_comment',
    );
    expect(reactions.length).toBeLessThanOrEqual(LIMITS.socialReactions);
    for (const r of reactions) {
      expect(r.momentId).toBeTruthy();
      const post = input().recentMoments!.find((m) => m.id === r.momentId)!;
      expect(r.contactId).not.toBe(post.authorId);
      expect(r.at).toBeGreaterThan(post.createdAt);
      expect(r.at).toBeLessThanOrEqual(plan.to);
    }
  });

  it('stale posts stop drawing reactions', () => {
    const plan = simulate(
      T0,
      T0 + 10 * HOUR,
      input({ recentMoments: [{ id: 'old', authorId: 'ai_a', createdAt: T0 - 90 * HOUR }] }),
      'seed',
    );
    expect(plan.events.some((e) => e.momentId === 'old')).toBe(false);
  });

  it('is deterministic for the same seed', () => {
    const a = simulate(T0, T0 + 10 * HOUR, input(), 'seed');
    const b = simulate(T0, T0 + 10 * HOUR, input(), 'seed');
    expect(a.events).toEqual(b.events);
  });
});

describe('offline agent DM', () => {
  it('at most one session per absence, pair drawn from a shared group', () => {
    // Sweep seeds to find one that hatches, then check its shape.
    let found = false;
    for (let i = 0; i < 60; i++) {
      const plan = simulate(T0, T0 + 12 * HOUR, input(), `s${i}`);
      const dms = plan.events.filter((e) => e.kind === 'agent_dm');
      expect(dms.length).toBeLessThanOrEqual(LIMITS.offlineDms);
      for (const d of dms) {
        found = true;
        expect(d.dm!.a).not.toBe(d.dm!.b);
        expect(['ai_a', 'ai_b', 'ai_c']).toContain(d.dm!.a);
        expect(['ai_a', 'ai_b', 'ai_c']).toContain(d.dm!.b);
        expect(d.dm!.groupId).toBe('conv_g');
        expect(d.at).toBeGreaterThanOrEqual(plan.from);
        expect(d.at).toBeLessThanOrEqual(plan.to);
      }
    }
    expect(found).toBe(true);
  });

  it('a short absence stays DM-free — private chats need room to happen', () => {
    for (let i = 0; i < 30; i++) {
      const plan = simulate(T0, T0 + 2 * HOUR, input(), `s${i}`);
      expect(plan.events.some((e) => e.kind === 'agent_dm')).toBe(false);
    }
  });
});
