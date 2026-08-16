import { describe, it, expect } from 'vitest';
import {
  planReactions,
  nextMomentAt,
  type ReactorInfo,
} from '../../src/ai/moments-engine';
import { pickImages, availableRefs, resolveImageRef } from '../../src/data/moments-images';
import { momentTimestamp } from '../../src/lib/time';
import { makePersona } from '../../src/data/persona-defaults';
import type { MomentVisibility } from '../../src/data/types';

const NOON = new Date(2025, 7, 6, 12, 0, 0).getTime();
const HOUR = 3_600_000;

/** A plannable post row. M-I19 made the planners take the ROW, not a triple. */
function post(id: string, authorId: string, createdAt: number, visibility?: MomentVisibility) {
  return { id, authorId, createdAt, ...(visibility ? { visibility } : {}) };
}

function reactor(id: string, over: Partial<ReactorInfo> = {}): ReactorInfo {
  return {
    contactId: id,
    likeRate: 0.5,
    commentRate: 0.25,
    affinity: 50,
    activeHours: [[9, 23]],
    ...over,
  };
}

describe('planReactions', () => {
  const crowd = ['a', 'b', 'c', 'd', 'e'].map((id) => reactor(id));

  it('is deterministic for the same moment and seed', () => {
    const one = planReactions(post('m1', 'self', NOON), crowd, 's');
    const two = planReactions(post('m1', 'self', NOON), crowd, 's');
    expect(one).toEqual(two);
  });

  it('gives different moments different crowds', () => {
    const a = planReactions(post('m1', 'self', NOON), crowd, 's');
    const b = planReactions(post('m2', 'self', NOON), crowd, 's');
    expect(a).not.toEqual(b);
  });

  it('never lets the author react to their own post', () => {
    const planned = planReactions(post('m1', 'a', NOON), crowd, 's');
    expect(planned.every((p) => p.contactId !== 'a')).toBe(true);
  });

  it('returns reactions sorted by time', () => {
    const planned = planReactions(post('m1', 'self', NOON), crowd, 's');
    const times = planned.map((p) => p.at);
    expect(times).toEqual([...times].sort((x, y) => x - y));
  });

  it('never schedules a reaction before the post exists', () => {
    const planned = planReactions(post('m1', 'self', NOON), crowd, 's');
    expect(planned.every((p) => p.at > NOON)).toBe(true);
  });

  it('puts a commenter’s comment after their own like', () => {
    // Everyone likes and comments, so every reactor produces both.
    const certain = crowd.map((r) => ({ ...r, likeRate: 1, commentRate: 1 }));
    const planned = planReactions(post('m1', 'self', NOON), certain, 's');
    for (const id of ['a', 'b', 'c', 'd', 'e']) {
      const like = planned.find((p) => p.contactId === id && p.kind === 'moment_like');
      const comment = planned.find((p) => p.contactId === id && p.kind === 'moment_comment');
      expect(like).toBeDefined();
      expect(comment).toBeDefined();
      expect(comment!.at).toBeGreaterThan(like!.at);
    }
  });

  it('rate 0 means nobody reacts; rate 1 means everybody does', () => {
    const none = crowd.map((r) => ({ ...r, likeRate: 0, commentRate: 0 }));
    expect(planReactions(post('m1', 'self', NOON), none, 's')).toEqual([]);

    const all = crowd.map((r) => ({ ...r, likeRate: 1, commentRate: 1 }));
    const planned = planReactions(post('m1', 'self', NOON), all, 's');
    expect(planned.filter((p) => p.kind === 'moment_like')).toHaveLength(5);
    expect(planned.filter((p) => p.kind === 'moment_comment')).toHaveLength(5);
  });

  it('higher affinity draws more reactions than lower affinity', () => {
    const big = Array.from({ length: 40 }, (_, i) => reactor(`c${i}`));
    const cold = planReactions(post('m1', 'self', NOON), big.map((r) => ({ ...r, affinity: 0 })), 's');
    const warm = planReactions(post('m1', 'self', NOON), big.map((r) => ({ ...r, affinity: 100 })), 's');
    expect(warm.length).toBeGreaterThan(cold.length);
  });

  it('lands every reaction inside the reactor’s active hours', () => {
    // Narrow window: 9-11am only. Reactions must not fall outside it.
    const narrow = crowd.map((r) => ({
      ...r,
      likeRate: 1,
      commentRate: 1,
      activeHours: [[9, 11]] as Array<[number, number]>,
    }));
    const planned = planReactions(post('m1', 'self', NOON), narrow, 's');
    expect(planned.length).toBeGreaterThan(0);
    for (const p of planned) {
      const h = new Date(p.at).getHours();
      expect(h).toBeGreaterThanOrEqual(9);
      expect(h).toBeLessThan(11);
    }
  });
});

describe('nextMomentAt', () => {
  it('returns null for a persona that never posts', () => {
    expect(nextMomentAt(makePersona({ contactId: 'x', core: 'c', momentsPerDay: 0 }), NOON)).toBeNull();
  });

  it('is deterministic within a day bucket', () => {
    const p = makePersona({ contactId: 'x', core: 'c', momentsPerDay: 1 });
    expect(nextMomentAt(p, NOON)).toBe(nextMomentAt(p, NOON));
  });

  it('always schedules into the future', () => {
    const p = makePersona({ contactId: 'x', core: 'c', momentsPerDay: 2 });
    expect(nextMomentAt(p, NOON)!).toBeGreaterThan(NOON);
  });

  it('posts more often at a higher rate', () => {
    const rare = makePersona({ contactId: 'x', core: 'c', momentsPerDay: 0.2 });
    const often = makePersona({ contactId: 'x', core: 'c', momentsPerDay: 5 });
    expect(nextMomentAt(often, NOON)! - NOON).toBeLessThan(nextMomentAt(rare, NOON)! - NOON);
  });

  it('lands inside the persona’s active hours', () => {
    const p = makePersona({
      contactId: 'x',
      core: 'c',
      momentsPerDay: 1,
      activeHours: [[20, 22]],
    });
    const h = new Date(nextMomentAt(p, NOON)!).getHours();
    expect(h).toBeGreaterThanOrEqual(20);
    expect(h).toBeLessThan(22);
  });
});

describe('moments image pool', () => {
  it('picks deterministically for a seed', () => {
    expect(pickImages('s', 4)).toEqual(pickImages('s', 4));
  });

  it('picks distinct images', () => {
    const picked = pickImages('s', 4);
    expect(new Set(picked).size).toBe(picked.length);
  });

  it('returns nothing for a zero count', () => {
    expect(pickImages('s', 0)).toEqual([]);
  });

  it('never returns more than the pool holds', () => {
    expect(pickImages('s', 999).length).toBe(availableRefs().length);
  });

  it('resolves a placeholder ref to a background, not a URL', () => {
    const r = resolveImageRef('ph:0');
    expect(r.background).toContain('linear-gradient');
    expect(r.url).toBeUndefined();
  });

  it('falls back to a stable placeholder for a missing asset', () => {
    const a = resolveImageRef('img:gone.png');
    const b = resolveImageRef('img:gone.png');
    expect(a.background).toBeDefined();
    expect(a.background).toBe(b.background);
  });
});

describe('momentTimestamp', () => {
  const now = new Date(2025, 7, 6, 12, 0, 0).getTime();

  it('shows 刚刚 under a minute', () => {
    expect(momentTimestamp(now - 30_000, now)).toBe('刚刚');
  });

  it('shows minutes under an hour', () => {
    expect(momentTimestamp(now - 5 * 60_000, now)).toBe('5分钟前');
  });

  it('shows hours later the same day', () => {
    expect(momentTimestamp(now - 3 * HOUR, now)).toBe('3小时前');
  });

  it('shows 昨天 for the previous calendar day', () => {
    const yesterday = new Date(2025, 7, 5, 20, 0, 0).getTime();
    expect(momentTimestamp(yesterday, now)).toBe('昨天');
  });

  it('counts calendar days, not elapsed 24h blocks', () => {
    // 23:00 on the 3rd, viewed at noon on the 6th, is 3 calendar days back —
    // elapsed/86400 would round this down to 2 and read as "2天前".
    const late = new Date(2025, 7, 3, 23, 0, 0).getTime();
    expect(momentTimestamp(late, now)).toBe('3天前');
  });

  it('falls back to a date past a week', () => {
    const old = new Date(2025, 6, 20, 12, 0, 0).getTime();
    expect(momentTimestamp(old, now)).toBe('7月20日');
  });
});
