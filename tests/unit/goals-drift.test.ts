import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  agentEpoch,
  goalStateAt,
  goalEventsBetween,
  latestTerminalEvent,
  goalDirective,
  goalShareDirective,
  goalMomentMaterial,
  GOAL_TEMPLATES,
  type GoalEvent,
} from '../../src/ai/goals';
import {
  driftAt,
  driftParams,
  explainDrift,
  DRIFT_CAP,
  DRIFT_DIM_LABELS,
} from '../../src/ai/drift';
import { seededRng } from '../../src/lib/money';

/**
 * M-I14: cross-week goals + bounded explainable drift.
 *
 * The contract under test is the constitution's rule #4: every function here is
 * a pure function of (contactId, t, epoch) — replayable forever — and the goal
 * linkage into drift is bounded and decays back to baseline.
 */

const DAY = 86_400_000;
const HOUR = 3_600_000;
const WEEK = 7 * DAY;
const ID = 'ai_goal_test';
const EPOCH = agentEpoch(ID);

/** All events across the first ~2 years — the shared fixture for many tests. */
const TWO_YEARS = goalEventsBetween(ID, EPOCH, EPOCH + 730 * DAY, EPOCH);

function firstOfKind(kind: GoalEvent['kind'], events = TWO_YEARS): GoalEvent {
  const e = events.find((x) => x.kind === kind);
  if (!e) throw new Error(`fixture has no ${kind} event — widen the window`);
  return e;
}

/** A terminal event where ±1h stays inside one drift week (base walk frozen). */
function terminalInsideWeek(kind: 'completed' | 'abandoned'): GoalEvent {
  for (const id of ['ai_goal_test', 'g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8']) {
    const epoch = agentEpoch(id);
    const events = goalEventsBetween(id, epoch, epoch + 900 * DAY, epoch);
    for (const e of events) {
      if (e.kind !== kind) continue;
      const wBefore = Math.floor((e.at - HOUR - epoch) / WEEK);
      const wAfter = Math.floor((e.at + HOUR - epoch) / WEEK);
      if (wBefore === wAfter) return e;
    }
  }
  throw new Error(`no ${kind} event clear of a week boundary in the fixture space`);
}

describe('goalStateAt — pure, seeded, bounded', () => {
  it('replays exactly: same inputs, same output, deep-equal', () => {
    for (const dt of [0, 3 * DAY, 47 * DAY, 200 * DAY, 555 * DAY]) {
      const a = goalStateAt(ID, EPOCH + dt, EPOCH);
      const b = goalStateAt(ID, EPOCH + dt, EPOCH);
      expect(b).toEqual(a);
    }
  });

  it('progress stays in [0,1] and milestoneIndex within template bounds', () => {
    for (let d = 0; d < 400; d += 7) {
      const g = goalStateAt(ID, EPOCH + d * DAY, EPOCH);
      expect(g.progress).toBeGreaterThanOrEqual(0);
      expect(g.progress).toBeLessThanOrEqual(1);
      const template = GOAL_TEMPLATES.find((t) => t.title === g.title);
      expect(template).toBeDefined();
      expect(g.milestoneIndex).toBeGreaterThanOrEqual(-1);
      expect(g.milestoneIndex).toBeLessThan(template!.milestones.length);
      // Reached milestones agree with the index.
      expect(g.milestones.filter((m) => m.reached).length).toBe(g.milestoneIndex + 1);
    }
  });

  it('different agents live different goals (not one shared script)', () => {
    const titles = new Set(
      ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map((id) =>
        goalStateAt(id, agentEpoch(id) + 30 * DAY, agentEpoch(id)).title,
      ),
    );
    expect(titles.size).toBeGreaterThan(1);
  });

  it('unreached milestones never leak their text (spoiler guard)', () => {
    for (let d = 0; d < 200; d += 5) {
      const g = goalStateAt(ID, EPOCH + d * DAY, EPOCH);
      for (const m of g.milestones) {
        if (!m.reached) expect(m.text).toBe('');
      }
    }
  });

  it('a completed cycle shows completed status during the rest window, then a new active goal starts', () => {
    const done = terminalInsideWeek('completed');
    const epoch = agentEpoch(done.id.split(':')[0]);
    const id = done.id.split(':')[0];
    const during = goalStateAt(id, done.at + DAY, epoch);
    expect(during.status).toBe('completed');
    expect(during.title).toBe(done.title);
    expect(during.progress).toBe(1);
    // Rest is at most 21 days; 40 days later a fresh cycle is underway.
    const later = goalStateAt(id, done.at + 40 * DAY, epoch);
    expect(later.status).toBe('active');
    expect(later.cycle).toBeGreaterThan(during.cycle);
  });

  it('an abandoned cycle freezes progress below 1', () => {
    const dropped = firstOfKind(
      'abandoned',
      // Scan a few agents — this one agent's first years may complete everything.
      ['ai_goal_test', 'g1', 'g2', 'g3', 'g4'].flatMap((id) =>
        goalEventsBetween(id, agentEpoch(id), agentEpoch(id) + 900 * DAY, agentEpoch(id)).map(
          (e) => ({ ...e, id: `${id}|${e.id}` }),
        ),
      ),
    );
    const id = dropped.id.split('|')[0];
    const epoch = agentEpoch(id);
    const g = goalStateAt(id, dropped.at + DAY, epoch);
    expect(g.status).toBe('abandoned');
    expect(g.progress).toBeLessThan(1);
  });
});

describe('goalEventsBetween — half-open, additive, ordered', () => {
  it('adjacent windows compose without loss or double-counting', () => {
    const t0 = EPOCH;
    const t1 = EPOCH + 180 * DAY;
    const t2 = EPOCH + 365 * DAY;
    const whole = goalEventsBetween(ID, t0, t2, EPOCH);
    const parts = [...goalEventsBetween(ID, t0, t1, EPOCH), ...goalEventsBetween(ID, t1, t2, EPOCH)];
    expect(parts).toEqual(whole);
  });

  it('events are time-ordered with stable unique ids', () => {
    for (let i = 1; i < TWO_YEARS.length; i++) {
      expect(TWO_YEARS[i].at).toBeGreaterThanOrEqual(TWO_YEARS[i - 1].at);
    }
    expect(new Set(TWO_YEARS.map((e) => e.id)).size).toBe(TWO_YEARS.length);
  });

  it('every cycle ends in exactly one terminal event', () => {
    const terminals = TWO_YEARS.filter((e) => e.kind === 'completed' || e.kind === 'abandoned');
    const cycles = new Set(terminals.map((e) => e.cycle));
    expect(cycles.size).toBe(terminals.length); // one terminal per cycle
  });

  it('latestTerminalEvent finds a terminal within the window and nothing outside it', () => {
    const done = TWO_YEARS.find((e) => e.kind === 'completed' || e.kind === 'abandoned')!;
    expect(latestTerminalEvent(ID, done.at + HOUR, EPOCH)?.id).toBe(done.id);
    expect(latestTerminalEvent(ID, done.at - HOUR, EPOCH, 24 * HOUR)?.id).not.toBe(done.id);
  });
});

describe('goal → drift linkage (the plan contract: 达成 → proactivity 短期上扬)', () => {
  it('completion lifts proactivity, bounded, then decays back', () => {
    const done = terminalInsideWeek('completed');
    const id = done.id.split(':')[0];
    const epoch = agentEpoch(id);
    const before = driftAt(id, done.at - HOUR, epoch).proactivity;
    const after = driftAt(id, done.at + HOUR, epoch).proactivity;
    // ±1h in the same drift week → base walk identical → the delta IS the goal.
    expect(after - before).toBeGreaterThan(0.15);
    expect(Math.abs(after)).toBeLessThanOrEqual(DRIFT_CAP);
    // Two weeks on, the surge is gone from the explanation entirely.
    const faded = explainDrift(id, done.at + 13.5 * DAY, epoch);
    expect(faded.events.map((e) => e.id)).not.toContain(done.id);
  });

  it('abandonment pulls proactivity down', () => {
    const dropped = terminalInsideWeek('abandoned');
    const id = dropped.id.split(':')[0];
    const epoch = agentEpoch(id);
    const before = driftAt(id, dropped.at - HOUR, epoch).proactivity;
    const after = driftAt(id, dropped.at + HOUR, epoch).proactivity;
    expect(after - before).toBeLessThan(-0.08);
  });

  it('driftAt is bounded to ±DRIFT_CAP on every dimension, always', () => {
    for (const id of ['a1', 'a2', 'a3']) {
      const epoch = agentEpoch(id);
      for (let d = 0; d < 400; d += 11) {
        const s = driftAt(id, epoch + d * DAY, epoch);
        for (const v of [s.warmth, s.liveliness, s.openness, s.proactivity]) {
          expect(Math.abs(v)).toBeLessThanOrEqual(DRIFT_CAP);
        }
      }
    }
  });

  it('driftParams stays within the safe multiplier band and replays', () => {
    for (let d = 0; d < 300; d += 13) {
      const s = driftAt(ID, EPOCH + d * DAY, EPOCH);
      const p = driftParams(s);
      expect(p.proactMul).toBeGreaterThanOrEqual(0.65);
      expect(p.proactMul).toBeLessThanOrEqual(1.5);
      expect(driftParams(driftAt(ID, EPOCH + d * DAY, EPOCH))).toEqual(p);
    }
  });
});

describe('explainDrift — the status page can show it verbatim', () => {
  it('names the goal in the reason right after a completion', () => {
    const done = terminalInsideWeek('completed');
    const id = done.id.split(':')[0];
    const exp = explainDrift(id, done.at + 6 * HOUR, agentEpoch(id));
    expect(exp.events.map((e) => e.id)).toContain(done.id);
    const proact = exp.dims.find((d) => d.key === 'proactivity')!;
    expect(proact.reason).toContain(done.title);
    expect(proact.label).toBe(DRIFT_DIM_LABELS.proactivity);
  });

  it('produces all four dims with human-readable reasons and a summary', () => {
    const exp = explainDrift(ID, EPOCH + 100 * DAY, EPOCH);
    expect(exp.dims).toHaveLength(4);
    for (const d of exp.dims) {
      expect(d.label.length).toBeGreaterThan(0);
      expect(d.reason.length).toBeGreaterThan(0);
      expect(Math.abs(d.value)).toBeLessThanOrEqual(DRIFT_CAP);
    }
    expect(exp.summary.length).toBeGreaterThan(0);
  });
});

describe('prompt material', () => {
  it('active goal directive carries title + stage, background-not-script discipline', () => {
    // Find an active moment.
    let g = goalStateAt(ID, EPOCH + 20 * DAY, EPOCH);
    let t = EPOCH + 20 * DAY;
    for (let d = 20; g.status !== 'active' && d < 200; d += 5) {
      t = EPOCH + d * DAY;
      g = goalStateAt(ID, t, EPOCH);
    }
    expect(g.status).toBe('active');
    const line = goalDirective(g, t);
    expect(line).toContain(g.title);
    expect(line).toContain('别逢人就汇报');
  });

  it('directive fades out after the afterglow window', () => {
    const done = terminalInsideWeek('completed');
    const id = done.id.split(':')[0];
    const epoch = agentEpoch(id);
    const fresh = goalStateAt(id, done.at + DAY, epoch);
    expect(goalDirective(fresh, done.at + DAY)).toContain(done.title);
    // 8 days on (if still resting), the afterglow is over → empty line.
    const stale = goalStateAt(id, done.at + 8 * DAY, epoch);
    if (stale.status !== 'active') {
      expect(goalDirective(stale, done.at + 8 * DAY)).toBe('');
    }
  });

  it('goalShareDirective differs for completion vs abandonment', () => {
    const done = firstOfKind('completed');
    const share = goalShareDirective(done);
    expect(share).toContain(done.title);
    expect(share).toContain('好消息');
    const dropped = terminalInsideWeek('abandoned');
    expect(goalShareDirective(dropped)).toContain('放弃');
  });

  it('goalMomentMaterial is seeded (replayable) and empty for a stale ended goal', () => {
    const done = terminalInsideWeek('completed');
    const id = done.id.split(':')[0];
    const epoch = agentEpoch(id);
    const fresh = goalStateAt(id, done.at + DAY, epoch);
    const a = goalMomentMaterial(fresh, done.at + DAY, 'seed1');
    const b = goalMomentMaterial(fresh, done.at + DAY, 'seed1');
    expect(b).toBe(a);
    // Far past the ending, silence.
    const stale = goalStateAt(id, done.at + 5 * DAY, epoch);
    if (stale.status !== 'active') {
      expect(goalMomentMaterial(stale, done.at + 5 * DAY, 'seed1')).toBe('');
    }
  });
});

describe('constitution rule #4 + wiring (deliberately red if violated)', () => {
  const src = (rel: string) =>
    readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8');

  it('goals.ts and drift.ts never touch Date.now or Math.random', () => {
    for (const f of ['ai/goals.ts', 'ai/drift.ts']) {
      const code = src(f);
      expect(code).not.toMatch(/Date\.now/);
      expect(code).not.toMatch(/Math\.random/);
      // And they must not import storage — pure means pure.
      expect(code).not.toMatch(/from '\.\.\/db\/repo'/);
    }
  });

  it('written AND wired: engine, moments-engine and the scheduler runtime consume goals/drift', () => {
    expect(src('ai/engine.ts')).toMatch(/from '\.\/goals'/);
    expect(src('ai/engine.ts')).toMatch(/goalShareDirective/);
    expect(src('ai/moments-engine.ts')).toMatch(/goalMomentMaterial/);
    expect(src('app/useSchedulerRuntime.ts')).toMatch(/driftParams/);
    expect(src('features/contacts/StatusPage.tsx')).toMatch(/explainDrift/);
  });

  it('agentEpoch matches the engine lifeline anchor formula', () => {
    const seeded = seededRng(`epoch:${ID}:${ID}`)();
    expect(agentEpoch(ID)).toBe(1_735_689_600_000 + Math.floor(seeded * 60 * DAY));
  });
});
