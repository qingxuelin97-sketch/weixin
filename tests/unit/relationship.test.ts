import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';
import {
  applyRelEvent,
  decayEdge,
  makeEdge,
  pairKey,
  relationTier,
  tierDirective,
  heartbeatAffinityMul,
  effectiveAffinity,
  recordRelEvent,
  getEdge,
} from '../../src/ai/relationship';
import { moodParams } from '../../src/lib/mood';
import { nextHeartbeatAt } from '../../src/ai/heartbeat';
import { makePersona } from '../../src/data/persona-defaults';

const DAY = 86_400_000;
const T0 = 1_754_600_000_000; // fixed epoch, deterministic

describe('relationship scoring (pure)', () => {
  it('events move fam/aff per the score table and clamp at bounds', () => {
    let e = makeEdge(20, T0);
    e = applyRelEvent(e, 'rp_received', T0);
    expect(e.aff).toBe(23);
    expect(e.fam).toBe(1);
    e = applyRelEvent(e, 'teased', T0);
    expect(e.aff).toBe(21);
    for (let i = 0; i < 200; i++) e = applyRelEvent(e, 'rp_received', T0);
    expect(e.aff).toBe(100); // clamped
    expect(e.fam).toBeLessThanOrEqual(100);
  });

  it('affinity decays 10%/day toward baseline; familiarity never decays', () => {
    let e = makeEdge(20, T0);
    e = { ...e, aff: 60, fam: 40 };
    const after1 = decayEdge(e, T0 + DAY);
    expect(after1.aff).toBeCloseTo(20 + 40 * 0.9, 5);
    expect(after1.fam).toBe(40);
    const after10 = decayEdge(e, T0 + 10 * DAY);
    expect(after10.aff).toBeCloseTo(20 + 40 * Math.pow(0.9, 10), 5);
    // Deterministic: decaying twice for the same instant changes nothing.
    expect(decayEdge(after10, T0 + 10 * DAY)).toEqual(after10);
  });

  it('pairKey is order-independent', () => {
    expect(pairKey('self', 'ai_ada')).toBe(pairKey('ai_ada', 'self'));
  });

  it('tiers and their prompt registers', () => {
    expect(relationTier(10)).toBe('stranger');
    expect(relationTier(45)).toBe('familiar');
    expect(relationTier(80)).toBe('close');
    expect(tierDirective('close')).toContain('很熟');
  });

  it('heartbeat multiplier is 1.0 at default affinity (activation is behavior-neutral)', () => {
    expect(heartbeatAffinityMul(20)).toBeCloseTo(1.0, 5);
    expect(heartbeatAffinityMul(100)).toBeLessThan(1);
    expect(heartbeatAffinityMul(0)).toBeGreaterThan(1);
  });

  it('effectiveAffinity falls back to the persona constant without an edge', () => {
    expect(effectiveAffinity(undefined, 35)).toBe(35);
    expect(effectiveAffinity({ ...makeEdge(20, T0), aff: 70 }, 35)).toBe(70);
  });
});

describe('recordRelEvent persistence (single entry point)', () => {
  it('creates, accumulates, and survives concurrent writes', async () => {
    await Promise.all([
      recordRelEvent('self', 'ai_x', 'user_reply', T0, 20),
      recordRelEvent('self', 'ai_x', 'moment_liked', T0, 20),
      recordRelEvent('ai_x', 'self', 'rp_received', T0, 20),
    ]);
    const e = await getEdge('self', 'ai_x', T0);
    expect(e).toBeDefined();
    // All three landed despite racing on one settings row.
    expect(e!.fam).toBeCloseTo(1 + 0.5 + 1, 5);
    expect(e!.aff).toBeCloseTo(20 + 0.5 + 1 + 3, 5);
  });

  it('self-edges are refused', async () => {
    await recordRelEvent('self', 'self', 'user_reply', T0);
    expect(await getEdge('self', 'self', T0)).toBeUndefined();
  });
});

describe('mood-behavior coupling', () => {
  it('parameter table snapshot (calibration changes must be deliberate)', () => {
    expect(moodParams('calm')).toEqual({ cpmMul: 1.0, proactMul: 1.0 });
    expect(moodParams('tired').cpmMul).toBeLessThan(1);
    expect(moodParams('excited').proactMul).toBeGreaterThan(1);
    expect(moodParams('down').proactMul).toBeLessThan(1);
  });
});

describe('heartbeat mods', () => {
  const persona = makePersona({ contactId: 'ai_hb', core: 'x', activeHours: [[0, 24]] });

  it('higher affinity → sooner; lower mood drive → later', () => {
    const base = nextHeartbeatAt(persona, T0);
    const close = nextHeartbeatAt(persona, T0, { affinityMul: heartbeatAffinityMul(100) });
    const down = nextHeartbeatAt(persona, T0, { proactMul: 0.6 });
    expect(close).toBeLessThan(base);
    expect(down).toBeGreaterThan(base);
  });

  it('cooldown floor: never fires before notBefore', () => {
    const floor = T0 + 24 * 3_600_000;
    const t = nextHeartbeatAt(persona, T0, { notBefore: floor });
    expect(t).toBeGreaterThanOrEqual(floor);
  });

  it('no mods == legacy behavior (replay parity)', () => {
    expect(nextHeartbeatAt(persona, T0, {})).toBe(nextHeartbeatAt(persona, T0));
  });
});
