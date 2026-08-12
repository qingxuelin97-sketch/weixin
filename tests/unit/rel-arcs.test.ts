import { describe, it, expect } from 'vitest';
import {
  deriveArc,
  arcFresh,
  arcLine,
  arcOpener,
  arcMomentDirective,
  ARC_FRESH_MS,
  type ArcMarker,
} from '../../src/ai/rel-arcs';

/**
 * Emergent events between the agents (M-H1).
 *
 * M-E4 gave the cast a social graph and then never showed it to anyone: the
 * numbers moved, the group's phrasing shifted by a degree, and nothing ever
 * crossed the line into "something happened between them". A social simulation
 * you cannot perceive is indistinguishable from no social simulation at all.
 *
 * The subtle half is `makeup`: making up is not a state you can read off a
 * stance value, it is the SHAPE OF A CHANGE — which is the entire reason a
 * marker is persisted at all.
 */

const T0 = new Date(2026, 4, 10, 12, 0).getTime();
const DAY = 86_400_000;

const sig = (over: Partial<Parameters<typeof deriveArc>[1]> = {}) => ({
  aff: 40,
  stanceAB: 0,
  userAffB: 20,
  ...over,
});

describe('what the numbers alone can say', () => {
  it('names a feud when the stance turns hostile', () => {
    const a = deriveArc(undefined, sig({ stanceAB: -60 }), T0);
    expect(a?.kind).toBe('feud');
    expect(a?.since).toBe(T0);
  });

  it('keeps a feud’s original date as it drags on', () => {
    // A feud's AGE is what makes it a feud rather than a bad afternoon.
    const day1 = deriveArc(undefined, sig({ stanceAB: -60 }), T0)!;
    const day3 = deriveArc(day1, sig({ stanceAB: -50 }), T0 + 2 * DAY);
    expect(day3?.since).toBe(T0);
  });

  it('names an alliance only when they are BOTH close and warm', () => {
    expect(deriveArc(undefined, sig({ aff: 80, stanceAB: 40 }), T0)?.kind).toBe('alliance');
    // Close but indifferent is just… knowing someone.
    expect(deriveArc(undefined, sig({ aff: 80, stanceAB: 0 }), T0)).toBeNull();
  });

  it('names jealousy only when someone else has your attention', () => {
    // Being cool toward a peer means nothing on its own; it means something
    // when that peer is the one you have grown close to.
    expect(deriveArc(undefined, sig({ stanceAB: -20, userAffB: 85 }), T0)?.kind).toBe('jealousy');
    expect(deriveArc(undefined, sig({ stanceAB: -20, userAffB: 10 }), T0)).toBeNull();
    // …and not when the two of them are close anyway.
    expect(deriveArc(undefined, sig({ stanceAB: -20, userAffB: 85, aff: 70 }), T0)).toBeNull();
  });

  it('says nothing about an ordinary pair', () => {
    expect(deriveArc(undefined, sig(), T0)).toBeNull();
  });
});

describe('making up is a transition, not a state', () => {
  const feud: ArcMarker = { kind: 'feud', since: T0 };

  it('fires when a feud that lasted cools off', () => {
    const out = deriveArc(feud, sig({ stanceAB: -5 }), T0 + 2 * DAY);
    expect(out?.kind).toBe('makeup');
    expect(out?.since).toBe(T0 + 2 * DAY); // dated by the reconciliation
  });

  it('does not fire for a feud that lasted an afternoon', () => {
    // Calling that a reconciliation would cheapen the ones that are.
    expect(deriveArc(feud, sig({ stanceAB: -5 }), T0 + 3_600_000)).toBeNull();
  });

  it('is news, not a label: it expires instead of persisting', () => {
    const made: ArcMarker = { kind: 'makeup', since: T0 };
    expect(deriveArc(made, sig(), T0 + DAY)?.kind).toBe('makeup');
    expect(deriveArc(made, sig(), T0 + ARC_FRESH_MS + DAY)).toBeNull();
  });

  it('outranks everything, so a stale feud cannot keep colouring the group', () => {
    const out = deriveArc(feud, sig({ aff: 80, stanceAB: 40 }), T0 + 2 * DAY);
    expect(out?.kind).toBe('makeup');
  });
});

describe('freshness decides whether anyone brings it up', () => {
  it('is news for a few days and history after', () => {
    // "他们俩前天吵架了" is conversation; "他们俩上个月吵过架" is a database.
    expect(arcFresh({ kind: 'feud', since: T0 }, T0 + DAY)).toBe(true);
    expect(arcFresh({ kind: 'feud', since: T0 }, T0 + ARC_FRESH_MS + 1)).toBe(false);
    expect(arcFresh(undefined, T0)).toBe(false);
  });
});

describe('the wording', () => {
  it('describes a state instead of ordering an announcement', () => {
    const line = arcLine('feud', '阿哲', T0 + DAY, T0);
    expect(line).toContain('阿哲');
    expect(line).toContain('昨天');
    // "Tell the user you had a fight" produces a character who opens every
    // conversation with a bulletin.
    expect(line).toContain('不会主动到处说');
  });

  it('counts the days the way a person would', () => {
    expect(arcLine('feud', 'X', T0, T0)).toContain('今天');
    expect(arcLine('feud', 'X', T0 + 3 * DAY, T0)).toContain('3天前');
  });

  it('gives an opener a reason, not a script', () => {
    const line = arcOpener('feud', '阿哲');
    expect(line).toContain('别一上来就控诉');
  });

  it('never names anyone in a Moments post', () => {
    for (const kind of ['feud', 'makeup', 'alliance', 'jealousy'] as const) {
      const line = arcMomentDirective(kind);
      expect(line.length).toBeGreaterThan(0);
      // People subtweet; they do not file reports. The ambiguity is what makes
      // the user go and ask about it.
      if (kind === 'feud' || kind === 'jealousy') {
        expect(/别点名|不点名/.test(line)).toBe(true);
        expect(/别解释|不解释/.test(line)).toBe(true);
      }
    }
  });
});
