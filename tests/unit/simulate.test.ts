import { describe, it, expect } from 'vitest';
import {
  simulate,
  groupMessageBudget,
  LIMITS,
  MAX_BACKFILL,
  SETTLE_MARGIN,
  type SimContact,
  type SimInput,
} from '../../src/ai/simulate';
import { makePersona } from '../../src/data/persona-defaults';
import type { PersonaVM } from '../../src/data/types';

const HOUR = 3_600_000;
/** Noon on a fixed day, so "8 hours ago" stays inside daytime active hours. */
const NOON = new Date(2025, 7, 6, 12, 0, 0).getTime();

function single(id: string, over: Partial<PersonaVM> = {}): SimContact {
  return {
    contactId: id,
    convId: `conv_${id}`,
    persona: makePersona({ contactId: id, core: 'c', proactivity: 0.8, ...over }),
  };
}

const input = (singles: SimContact[]): SimInput => ({ singles, groups: [] });

const CROWD = ['a', 'b', 'c', 'd', 'e', 'f'].map((id) => single(id));

describe('simulate — determinism', () => {
  it('produces the same plan for the same window and seed', () => {
    const a = simulate(NOON - 8 * HOUR, NOON, input(CROWD), 's');
    const b = simulate(NOON - 8 * HOUR, NOON, input(CROWD), 's');
    expect(a).toEqual(b);
  });

  it('produces a different plan for a different seed', () => {
    const a = simulate(NOON - 8 * HOUR, NOON, input(CROWD), 's1');
    const b = simulate(NOON - 8 * HOUR, NOON, input(CROWD), 's2');
    expect(a.events).not.toEqual(b.events);
  });
});

describe('simulate — window and barrier', () => {
  it('never fabricates inside the settle margin before now', () => {
    const plan = simulate(NOON - 8 * HOUR, NOON, input(CROWD), 's');
    expect(plan.to).toBe(NOON - SETTLE_MARGIN);
    for (const e of plan.events) expect(e.at).toBeLessThanOrEqual(plan.to);
  });

  it('never fabricates before the barrier', () => {
    const from = NOON - 8 * HOUR;
    const plan = simulate(from, NOON, input(CROWD), 's');
    for (const e of plan.events) expect(e.at).toBeGreaterThanOrEqual(from);
  });

  it('returns nothing when the window is shorter than the settle margin', () => {
    const plan = simulate(NOON - 60_000, NOON, input(CROWD), 's');
    expect(plan.events).toEqual([]);
  });

  it('truncates a window longer than 24h and flags it', () => {
    const plan = simulate(NOON - 10 * 24 * HOUR, NOON, input(CROWD), 's');
    expect(plan.truncated).toBe(true);
    expect(plan.to - plan.from).toBe(MAX_BACKFILL);
  });

  it('does not flag a window inside the limit', () => {
    expect(simulate(NOON - 5 * HOUR, NOON, input(CROWD), 's').truncated).toBe(false);
  });
});

describe('simulate — limits', () => {
  it('caps how many people start a chat', () => {
    const many = Array.from({ length: 30 }, (_, i) => single(`p${i}`, { proactivity: 1 }));
    const plan = simulate(NOON - 20 * HOUR, NOON, input(many), 's');
    const speakers = new Set(
      plan.events.filter((e) => e.kind === 'heartbeat').map((e) => e.contactId),
    );
    expect(speakers.size).toBeLessThanOrEqual(LIMITS.singleChatPeople);
  });

  it('caps messages per person', () => {
    const many = Array.from({ length: 30 }, (_, i) => single(`p${i}`, { proactivity: 1 }));
    const plan = simulate(NOON - 20 * HOUR, NOON, input(many), 's');
    const counts = new Map<string, number>();
    for (const e of plan.events.filter((x) => x.kind === 'heartbeat')) {
      counts.set(e.contactId, (counts.get(e.contactId) ?? 0) + 1);
    }
    for (const n of counts.values()) expect(n).toBeLessThanOrEqual(LIMITS.messagesPerPerson);
  });

  it('never exceeds the total LLM-call ceiling', () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      single(`p${i}`, { proactivity: 1, momentsPerDay: 5 }),
    );
    const plan = simulate(NOON - 24 * HOUR, NOON, input(many), 's');
    expect(plan.events.length).toBeLessThanOrEqual(LIMITS.llmCalls);
  });

  it('caps fabricated posts', () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      single(`p${i}`, { proactivity: 0, momentsPerDay: 10 }),
    );
    const plan = simulate(NOON - 24 * HOUR, NOON, input(many), 's');
    expect(plan.events.filter((e) => e.kind === 'moment_post').length).toBeLessThanOrEqual(
      LIMITS.moments,
    );
  });
});

describe('simulate — active hours', () => {
  it('stays silent when the window misses the persona’s waking hours', () => {
    // Awake 9-11am only; the window is 1am-5am. Nobody should speak.
    const nightWindowStart = new Date(2025, 7, 6, 1, 0, 0).getTime();
    const nightWindowEnd = new Date(2025, 7, 6, 5, 0, 0).getTime();
    const sleepers = ['a', 'b', 'c'].map((id) =>
      single(id, { proactivity: 1, momentsPerDay: 5, activeHours: [[9, 11]] }),
    );
    const plan = simulate(nightWindowStart, nightWindowEnd, input(sleepers), 's');
    expect(plan.events).toEqual([]);
  });

  it('places every fabricated event inside waking hours', () => {
    const people = ['a', 'b', 'c'].map((id) =>
      single(id, { proactivity: 1, momentsPerDay: 3, activeHours: [[9, 18]] }),
    );
    // A full day window, so it spans both waking and sleeping hours.
    const plan = simulate(NOON - 24 * HOUR, NOON, input(people), 's');
    expect(plan.events.length).toBeGreaterThan(0);
    for (const e of plan.events) {
      const h = new Date(e.at).getHours();
      expect(h).toBeGreaterThanOrEqual(9);
      expect(h).toBeLessThan(18);
    }
  });
});

describe('simulate — ordering invariants', () => {
  it('returns events in chronological order', () => {
    const plan = simulate(NOON - 20 * HOUR, NOON, input(CROWD), 's');
    const times = plan.events.map((e) => e.at);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('never fabricates a message older than the conversation’s last one', () => {
    // The conversation already ends 1 hour ago; the window opened 8 hours ago.
    // Inserting anything older would break rowid-order == time-order.
    const lastMsgAt = NOON - HOUR;
    const people = ['a', 'b', 'c'].map((id) => ({
      ...single(id, { proactivity: 1 }),
      lastMsgAt,
    }));
    const plan = simulate(NOON - 8 * HOUR, NOON, input(people), 's');
    for (const e of plan.events.filter((x) => x.kind === 'heartbeat')) {
      expect(e.at).toBeGreaterThan(lastMsgAt);
    }
  });

  it('stays silent for a conversation whose last message is newer than the window', () => {
    // Last message is 30s ago — inside the settle margin, so there is no room.
    const people = [{ ...single('a', { proactivity: 1 }), lastMsgAt: NOON - 30_000 }];
    const plan = simulate(NOON - 8 * HOUR, NOON, input(people), 's');
    expect(plan.events.filter((e) => e.kind === 'heartbeat')).toEqual([]);
  });

  it('carries the conversation id on every heartbeat', () => {
    const plan = simulate(NOON - 20 * HOUR, NOON, input(CROWD), 's');
    for (const e of plan.events.filter((x) => x.kind === 'heartbeat')) {
      expect(e.convId).toBe(`conv_${e.contactId}`);
    }
  });
});

describe('simulate — absence length', () => {
  it('fabricates less over a short absence than a long one', () => {
    const many = Array.from({ length: 20 }, (_, i) => single(`p${i}`, { proactivity: 0.5 }));
    const short = simulate(NOON - 1 * HOUR, NOON, input(many), 's');
    const long = simulate(NOON - 20 * HOUR, NOON, input(many), 's');
    expect(short.events.length).toBeLessThanOrEqual(long.events.length);
  });

  it('handles an empty contact list without throwing', () => {
    expect(simulate(NOON - 8 * HOUR, NOON, input([]), 's').events).toEqual([]);
  });
});

describe('groupMessageBudget', () => {
  it('scales with hours but stays bounded', () => {
    expect(groupMessageBudget(NOON - HOUR, NOON)).toBe(LIMITS.groupMessagesPerHour);
    expect(groupMessageBudget(NOON - 100 * HOUR, NOON)).toBe(LIMITS.groupMessagesPerHour * 4);
  });

  it('is zero for an empty window', () => {
    expect(groupMessageBudget(NOON, NOON)).toBe(0);
  });
});
