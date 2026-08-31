import { describe, it, expect } from 'vitest';
import {
  applyEvent,
  applyDrift,
  decayDrift,
  explainDrift,
  DRIFT_CAP,
  type Drift,
} from '../../src/ai/drift';
import { makePersona } from '../../src/data/persona-defaults';

/**
 * Personality drift (M-H1).
 *
 * Her mood moves, her feelings move, the relationship edge moves — but who she
 * IS has been frozen since the card was written. Six months of talking to
 * someone changes them; six months of talking to this app changed nothing.
 *
 * The tests that matter are the ones about the LIMITS. Unbounded drift is not
 * character development, it is a random walk that eventually erases the
 * persona — and the user has no way to notice until she is gone.
 */

const T0 = new Date(2026, 4, 10, 12, 0).getTime();
const DAY = 86_400_000;
const EMPTY: Drift = { d: {}, at: 0, why: [] };

const times = (n: number, f: (i: number) => void) => {
  for (let i = 0; i < n; i++) f(i);
};

describe('events move her, slowly', () => {
  it('being answered makes her a little more proactive', () => {
    const after = applyEvent(EMPTY, 'user_reply', T0);
    expect(after.d.proactivity).toBeGreaterThan(0);
    // One reply must not be visible. It takes many for the movement to mean
    // anything — that is what makes it character rather than a mood.
    expect(explainDrift(after)).toHaveLength(0);
  });

  it('being ignored can make her quieter', () => {
    // The one negative the user generates by doing nothing. An agent who
    // cannot be discouraged is a toy.
    let d = EMPTY;
    times(12, (i) => (d = applyEvent(d, 'user_ignored', T0 + i * DAY)));
    expect(d.d.proactivity!).toBeLessThan(0);
    expect(explainDrift(d).some((e) => e.dim === 'proactivity')).toBe(true);
  });

  it('being given things makes her more open-handed', () => {
    let d = EMPTY;
    times(5, (i) => (d = applyEvent(d, 'gift_received', T0 + i * DAY)));
    expect(d.d.generosity!).toBeGreaterThan(0.05);
  });

  it('keeps the reason, in words', () => {
    const d = applyEvent(EMPTY, 'conflict', T0);
    expect(d.why[0].text).toContain('吵');
    // "她变了，不知道为什么" is a bug you cannot even file.
    expect(applyEvent(EMPTY, 'user_reply', T0).why).toHaveLength(0);
  });

  it('does not let one reason fill the whole list', () => {
    let d = EMPTY;
    times(20, (i) => (d = applyEvent(d, 'gift_received', T0 + i * DAY)));
    expect(d.why).toHaveLength(1);
  });
});

describe('the limits', () => {
  it('caps every dimension, however long it goes on', () => {
    let d = EMPTY;
    // A year of nothing but warmth.
    times(365, (i) => (d = applyEvent(d, 'user_warm', T0 + i * 60_000)));
    for (const v of Object.values(d.d)) {
      expect(Math.abs(v)).toBeLessThanOrEqual(DRIFT_CAP + 1e-9);
    }
  });

  it('decays back toward the card when nothing reinforces it', () => {
    let d = EMPTY;
    times(20, (i) => (d = applyEvent(d, 'gift_received', T0 + i * 60_000)));
    const hot = d.d.generosity!;
    const cold = decayDrift(d, T0 + 120 * DAY).d.generosity ?? 0;
    // A single bad week must not permanently redefine someone — the user's only
    // other recourse would be editing the card by hand.
    expect(Math.abs(cold)).toBeLessThan(Math.abs(hot) / 2);
  });

  it('forgets noise entirely rather than carrying it forever', () => {
    const d = applyEvent(EMPTY, 'user_reply', T0);
    expect(decayDrift(d, T0 + 3 * 365 * DAY).d.proactivity).toBeUndefined();
  });
});

describe('applying it to a persona', () => {
  const base = makePersona({ contactId: 'ai_lin', core: 'c', proactivity: 0.5, generosity: 0.5 });

  it('never mutates the card', () => {
    const out = applyDrift(base, { d: { proactivity: 0.1 }, at: T0, why: [] });
    expect(out.proactivity).toBeCloseTo(0.6);
    // The editor must keep showing what the user wrote, and a restored backup
    // must not come back with a silently rewritten character.
    expect(base.proactivity).toBe(0.5);
  });

  it('keeps every value inside its legal range', () => {
    const low = makePersona({ contactId: 'x', core: 'c', proactivity: 0.05 });
    expect(applyDrift(low, { d: { proactivity: -0.2 }, at: T0, why: [] }).proactivity).toBe(0);
  });

  it('is a no-op — same object — when nothing has drifted', () => {
    expect(applyDrift(base, EMPTY)).toBe(base);
    expect(applyDrift(base, undefined)).toBe(base);
  });
});

describe('what the user is told', () => {
  it('stays quiet about changes nobody could perceive', () => {
    expect(explainDrift({ d: { proactivity: 0.02 }, at: T0, why: [] })).toHaveLength(0);
  });

  it('names the direction in plain words', () => {
    const up = explainDrift({ d: { proactivity: 0.12 }, at: T0, why: [] });
    expect(up[0].label).toContain('更主动');
    const down = explainDrift({ d: { proactivity: -0.12 }, at: T0, why: [] });
    expect(down[0].label).toContain('安静');
  });
});
