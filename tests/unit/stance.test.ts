import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { repo } from '../../src/db/repo';
import {
  getStance,
  recordStance,
  recordTease,
  decayStance,
  stanceTier,
  describePeerEdges,
} from '../../src/ai/relationship';
import { aiStreak, prefilter } from '../../src/ai/director';
import { makePersona } from '../../src/data/persona-defaults';
import type { MessageVM } from '../../src/data/types';

/**
 * M-E4: the group develops dynamics instead of drifting apart uniformly.
 */

const T0 = new Date(2026, 0, 15, 14, 0, 0).getTime();
const DAY = 86_400_000;

function msg(id: number, senderId: string, content = 'x'): MessageVM {
  return {
    id,
    convId: 'g1',
    senderId,
    type: 'text',
    content,
    status: 'sent',
    createdAt: T0 - (100 - id) * 60_000,
  };
}

describe('directional stance', () => {
  beforeEach(async () => {
    for (const k of ['stance:a:b', 'stance:b:a']) await repo.putSetting(k, undefined);
  });

  it('is one-way: being needled cools the needled, not the needler', async () => {
    await recordTease('a', 'b', T0);
    // b was teased by a, so b cools toward a…
    expect(await getStance('b', 'a', T0)).toBeLessThan(0);
    // …and a is unaffected. Symmetric accounting made everyone drift apart
    // whenever anyone was teased, which is the opposite of group dynamics.
    expect(await getStance('a', 'b', T0)).toBe(0);
  });

  it('accumulates over repeated slights', async () => {
    await recordTease('a', 'b', T0);
    const once = await getStance('b', 'a', T0);
    await recordTease('a', 'b', T0);
    expect(await getStance('b', 'a', T0)).toBeLessThan(once);
  });

  it('decays toward neutral — nobody stays annoyed forever', () => {
    const hot = { value: -60, day: Math.floor(T0 / DAY) };
    const later = decayStance(hot, T0 + 30 * DAY);
    expect(Math.abs(later.value)).toBeLessThan(10);
    expect(decayStance(hot, T0).value).toBe(-60);
  });

  it('is bounded so no amount of teasing produces a monster', async () => {
    for (let i = 0; i < 200; i++) await recordStance('b', 'a', -30, T0);
    expect(await getStance('b', 'a', T0)).toBeGreaterThanOrEqual(-100);
  });

  it('never records a stance toward oneself', async () => {
    await recordStance('a', 'a', -50, T0);
    expect(await getStance('a', 'a', T0)).toBe(0);
  });

  it('reads an absent or corrupt row as neutral', async () => {
    expect(await getStance('nobody', 'nowhere', T0)).toBe(0);
    await repo.putSetting('stance:x:y', { junk: true });
    expect(await getStance('x', 'y', T0)).toBe(0);
  });

  it('tiers the value into something a prompt can say', () => {
    expect(stanceTier(-50)).toBe('hostile');
    expect(stanceTier(-20)).toBe('cool');
    expect(stanceTier(0)).toBe('neutral');
    expect(stanceTier(40)).toBe('warm');
  });
});

describe('stance in the actor prompt', () => {
  beforeEach(async () => {
    for (const k of ['stance:me:foe', 'stance:me:pal', 'stance:me:meh']) {
      await repo.putSetting(k, undefined);
    }
  });

  const peers = [
    { contactId: 'foe', name: '阿哲' },
    { contactId: 'pal', name: '小雨' },
    { contactId: 'meh', name: 'Ada' },
  ];

  it('says nothing at all when everyone is neutral', async () => {
    // "You feel normal about everyone" is pure token noise, and every extra
    // sentence in the tail dilutes the persona it is attached to.
    expect(await describePeerEdges('me', peers, T0)).toBe('');
  });

  it('names only the people there is something to say about', async () => {
    await recordStance('me', 'foe', -50, T0);
    await recordStance('me', 'pal', 40, T0);
    const line = await describePeerEdges('me', peers, T0);
    expect(line).toContain('阿哲');
    expect(line).toContain('小雨');
    expect(line).not.toContain('Ada');
  });

  it('is capped, so a big group cannot swamp the prompt', async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ contactId: `p${i}`, name: `P${i}` }));
    for (const p of many) await recordStance('me', p.contactId, -50, T0);
    const line = await describePeerEdges('me', many, T0, 3);
    expect(line.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(3);
  });

  it('never describes the actor’s stance toward themselves', async () => {
    await recordStance('me', 'me', -80, T0);
    expect(await describePeerEdges('me', [{ contactId: 'me', name: '我' }], T0)).toBe('');
  });
});

describe('the hogging check finally does something (M-E4)', () => {
  it('counts a run of AI messages across the user’s interjections', () => {
    // The old check read the raw tail, but prefilter runs right after the USER
    // sent a message — so the trailing sender was always 'self' and the streak
    // was always 0. The rule existed and never once fired.
    const tail = [
      msg(1, 'ai_a'),
      msg(2, 'ai_a'),
      msg(3, 'ai_a'),
      msg(4, 'self'),
    ];
    expect(aiStreak(tail, 'ai_a')).toBe(3);
    expect(aiStreak(tail, 'ai_b')).toBe(0);
  });

  it('stops at another AI speaking', () => {
    const tail = [msg(1, 'ai_a'), msg(2, 'ai_b'), msg(3, 'ai_a'), msg(4, 'self')];
    expect(aiStreak(tail, 'ai_a')).toBe(1);
  });

  it('actually benches the hogger in prefilter', () => {
    const members = [
      { contactId: 'ai_a', name: 'A', persona: makePersona({ contactId: 'ai_a', core: 'c', activeHours: [[0, 24]] }) },
      { contactId: 'ai_b', name: 'B', persona: makePersona({ contactId: 'ai_b', core: 'c', activeHours: [[0, 24]] }) },
    ];
    // ai_a sent the last three AI lines; the user then said something.
    const recent = [
      msg(1, 'ai_a'),
      msg(2, 'ai_a'),
      msg(3, 'ai_a'),
      msg(4, 'self', '你们继续'),
    ];
    const out = prefilter(members, recent, T0, 'seed', { cooldownMs: 0, maxStreak: 3 });
    expect(out.candidates.map((c) => c.contactId)).toEqual(['ai_b']);
  });
});
