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
  applyGoalDrift,
  explainDrift,
  DRIFT_CAP,
  GOAL_DRIFT_CAP,
  GOAL_DRIFT_WINDOW_MS,
  type Drift,
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

/**
 * 目标 ↔ 漂移联动 (M-I14, restored in M-I18).
 *
 * The plan's contract in one line: 目标达成 → proactivity 短期上扬，之后衰减
 * 回落. It was delivered on the I14 branch and then LOST — the merge that
 * landed I14 resolved `src/ai/drift.ts` to the other side, and the test that
 * should have caught it instead described the absence as intentional. These
 * assertions are the replacement: they fail if the linkage ever goes away
 * again, and they fail if it stops being bounded or stops decaying.
 */
describe('目标 ↔ 漂移联动', () => {
  const EMPTY_DRIFT: Drift = { d: {}, at: 0, why: [] };
  const pro = (id: string, t: number, epoch: number) =>
    applyGoalDrift(EMPTY_DRIFT, id, t, epoch).d.proactivity ?? 0;

  /**
   * A terminal event with nothing else happening for a full drift window after
   * it — so "the window has passed" can be asserted against zero rather than
   * against whatever the next cycle's first milestone happens to contribute.
   */
  function isolatedTerminal(kind: 'completed' | 'abandoned'): { e: GoalEvent; id: string; epoch: number } {
    for (const id of ['ai_goal_test', 'g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8']) {
      const epoch = agentEpoch(id);
      const all = goalEventsBetween(id, epoch, epoch + 900 * DAY, epoch);
      for (const e of all) {
        if (e.kind !== kind) continue;
        const after = all.some(
          (o) => o.id !== e.id && o.at > e.at && o.at <= e.at + GOAL_DRIFT_WINDOW_MS + 2 * DAY,
        );
        if (!after) return { e, id, epoch };
      }
    }
    throw new Error(`no isolated ${kind} event in the fixture space`);
  }

  it('a completed goal lifts proactivity, then decays back to nothing', () => {
    const { e, id, epoch } = isolatedTerminal('completed');
    const before = pro(id, e.at - HOUR, epoch);
    const just = pro(id, e.at + HOUR, epoch);
    const days = [1, 3, 7].map((d) => pro(id, e.at + d * DAY, epoch));
    const past = pro(id, e.at + GOAL_DRIFT_WINDOW_MS + DAY, epoch);

    // 上扬: the completion itself is worth an order more than the ambient.
    expect(just - before).toBeGreaterThan(0.1);
    // 衰减回落: strictly monotonic down, never flipping sign on the way.
    expect(days[0]).toBeLessThan(just);
    expect(days[1]).toBeLessThan(days[0]);
    expect(days[2]).toBeLessThan(days[1]);
    expect(days[2]).toBeGreaterThan(0);
    // …and out the far side of the window there is nothing left at all.
    expect(past).toBe(0);
  });

  it('an abandoned goal makes her quieter, and that fades too', () => {
    const { e, id, epoch } = isolatedTerminal('abandoned');
    const before = pro(id, e.at - HOUR, epoch);
    const just = pro(id, e.at + HOUR, epoch);
    expect(just).toBeLessThan(before);
    expect(just).toBeLessThan(0);
    expect(Math.abs(pro(id, e.at + 8 * DAY, epoch))).toBeLessThan(Math.abs(just));
    expect(pro(id, e.at + GOAL_DRIFT_WINDOW_MS + DAY, epoch)).toBe(0);
  });

  it('bounded and replayable: same inputs, same delta, never past the cap', () => {
    const { e, id, epoch } = isolatedTerminal('completed');
    for (const dt of [0, HOUR, DAY, 5 * DAY, 13 * DAY]) {
      const a = applyGoalDrift(EMPTY_DRIFT, id, e.at + dt, epoch);
      const b = applyGoalDrift(EMPTY_DRIFT, id, e.at + dt, epoch);
      expect(b.d).toEqual(a.d);
      for (const v of Object.values(a.d)) {
        expect(Math.abs(v)).toBeLessThanOrEqual(DRIFT_CAP + GOAL_DRIFT_CAP);
      }
    }
  });

  it('adds to the stored layer instead of replacing it, and never writes it back', () => {
    const { e, id, epoch } = isolatedTerminal('completed');
    const stored: Drift = { d: { proactivity: 0.1 }, at: e.at, why: [{ text: '你常跟她说软话', at: e.at }] };
    const merged = applyGoalDrift(stored, id, e.at + HOUR, epoch);
    expect(merged.d.proactivity!).toBeGreaterThan(0.1); // stacked, not overwritten
    expect(stored.d.proactivity).toBe(0.1); // the input is untouched…
    expect(stored.why).toHaveLength(1); // …reasons included
    expect(merged.why.some((w) => w.text === '你常跟她说软话')).toBe(true);
  });

  it('explainDrift says WHY in words, naming the goal', () => {
    const { e, id, epoch } = isolatedTerminal('completed');
    const rows = explainDrift(applyGoalDrift(EMPTY_DRIFT, id, e.at + HOUR, epoch));
    const row = rows.find((r) => r.dim === 'proactivity');
    expect(row).toBeDefined();
    expect(row!.reason).toContain(e.title);
    expect(row!.reason).toContain('主动');
  });
});

describe('constitution rule #4 + wiring (deliberately red if violated)', () => {
  const src = (rel: string) =>
    readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8');

  it('goals.ts never touches Date.now, Math.random, or storage', () => {
    const code = src('ai/goals.ts');
    expect(code).not.toMatch(/Date\.now/);
    expect(code).not.toMatch(/Math\.random/);
    expect(code).not.toMatch(/from '\.\.\/db\/repo'/);
  });

  it('drift actually consumes goals — the linkage the I14 merge dropped', () => {
    // The I14 branch shipped a drift.ts with this linkage; resolving the merge
    // took the other side and it vanished, leaving `grep goal src/ai/drift.ts`
    // empty while every test stayed green. The behavioural assertions above
    // are the real gate; this one names the file so a future resolution that
    // drops it again fails on the spot.
    const code = src('ai/drift.ts');
    expect(code).toMatch(/goalEventsBetween/);
    expect(code).toMatch(/GOAL_IMPULSES/);
  });

  it('written AND wired: engine, moments-engine and the scheduler runtime consume goals/drift', () => {
    expect(src('ai/engine.ts')).toMatch(/from '\.\/goals'/);
    expect(src('ai/engine.ts')).toMatch(/goalShareDirective/);
    expect(src('ai/moments-engine.ts')).toMatch(/goalMomentMaterial/);
    expect(src('app/useSchedulerRuntime.ts')).toMatch(/driftedPersona/);
    expect(src('features/contacts/StatusPage.tsx')).toMatch(/explainDrift/);
  });

  it('agentEpoch matches the engine lifeline anchor formula', () => {
    const seeded = seededRng(`epoch:${ID}:${ID}`)();
    expect(agentEpoch(ID)).toBe(1_735_689_600_000 + Math.floor(seeded * 60 * DAY));
  });
});
