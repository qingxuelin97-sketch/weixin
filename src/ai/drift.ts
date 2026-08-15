/**
 * Bounded, explainable personality drift (M-I14; specs/goals-status.md).
 *
 * A persona card is static; a person is not. But naive drift is worse than no
 * drift: an unbounded random walk turns 温柔学姐 into someone else within a
 * month, and an opaque one turns "she's been distant lately" into a bug report
 * instead of a story. So this module has exactly two rules:
 *
 *  1. **Bounded.** Four dimensions (亲和/活泼/倾诉欲/主动性), each a small
 *     seeded weekly walk with exponential forgetting — mathematically capped,
 *     always pulled back toward the card. The card remains the truth; drift is
 *     weather on top of it.
 *  2. **Explainable.** `explainDrift` decomposes every dimension into its
 *     causes in human words. The dominant cause is the goal linkage: a goal
 *     completed → proactivity surges for a few days and decays back; abandoned
 *     → she goes a little quiet. The status page shows exactly this.
 *
 * Pure functions of (contactId, t, epoch) throughout — constitution rule #4:
 * no wall clock, no system randomness, no storage. Behaviour-wise, drift
 * reaches the app through ONE existing channel: the heartbeat `proactMul`
 * modifier (same slot mood and affect already ride). No second pacing
 * mechanism.
 */
import { seededRng } from '../lib/money';
import { goalEventsBetween, type GoalEvent } from './goals';

const DAY = 86_400_000;
const WEEK = 7 * DAY;

/* ==================================================================== */
/* Dimensions                                                            */
/* ==================================================================== */

export type DriftDimKey = 'warmth' | 'liveliness' | 'openness' | 'proactivity';

export const DRIFT_DIM_LABELS: Record<DriftDimKey, string> = {
  warmth: '亲和',
  liveliness: '活泼',
  openness: '倾诉欲',
  proactivity: '主动性',
};

const DIM_KEYS: DriftDimKey[] = ['warmth', 'liveliness', 'openness', 'proactivity'];

/** Each dimension stays within ±DRIFT_CAP of the persona card. */
export const DRIFT_CAP = 0.6;

export interface DriftState {
  warmth: number;
  liveliness: number;
  openness: number;
  proactivity: number;
}

/* ==================================================================== */
/* Base walk                                                             */
/* ==================================================================== */

/** Per-week seeded impulse amplitude. */
const WALK_AMP = 0.1;
/** Weekly forgetting factor: older impulses fade, the walk cannot run away. */
const WALK_DECAY = 0.72;
/** How many weeks back still contribute (0.72^8 ≈ 0.07 — below noise). */
const WALK_WINDOW = 8;

/**
 * The slow ambient part: a seeded weekly impulse per dimension, summed with
 * exponential forgetting. Bounded by construction: |Σ| ≤ AMP·Σdecay^k ≈ 0.34.
 * Deterministic per (contactId, dim, week), so a replayed timeline drifts
 * identically.
 */
function baseWalk(contactId: string, dim: DriftDimKey, t: number, epoch: number): number {
  const week = Math.floor(Math.max(0, t - epoch) / WEEK);
  let v = 0;
  for (let k = 0; k < WALK_WINDOW; k++) {
    const w = week - k;
    if (w < 0) break;
    const impulse = seededRng(`drift:${contactId}:${dim}:${w}`)() * 2 - 1;
    v += WALK_AMP * impulse * Math.pow(WALK_DECAY, k);
  }
  return v;
}

/* ==================================================================== */
/* Goal linkage                                                          */
/* ==================================================================== */

/** How far back goal events still move the needle. */
export const GOAL_DRIFT_WINDOW_MS = 14 * DAY;

interface GoalImpulse {
  dim: DriftDimKey;
  amount: number;
  halfLifeDays: number;
}

/**
 * What each goal event does to the person. Completion is the headline effect —
 * the plan's contract: 目标达成 → proactivity 短期上扬 — and it decays back to
 * baseline within days rather than becoming a new personality.
 */
const GOAL_IMPULSES: Record<GoalEvent['kind'], GoalImpulse[]> = {
  completed: [
    { dim: 'proactivity', amount: 0.35, halfLifeDays: 3 },
    { dim: 'warmth', amount: 0.15, halfLifeDays: 3 },
    { dim: 'liveliness', amount: 0.15, halfLifeDays: 2.5 },
  ],
  abandoned: [
    { dim: 'proactivity', amount: -0.2, halfLifeDays: 4 },
    { dim: 'openness', amount: -0.12, halfLifeDays: 4 },
  ],
  milestone: [{ dim: 'proactivity', amount: 0.08, halfLifeDays: 1.5 }],
  setback: [
    { dim: 'liveliness', amount: -0.08, halfLifeDays: 2 },
    { dim: 'openness', amount: -0.05, halfLifeDays: 2 },
  ],
};

function decay(ageMs: number, halfLifeDays: number): number {
  return Math.pow(0.5, ageMs / (halfLifeDays * DAY));
}

/** The goal-driven part of one dimension, with the events that caused it. */
function goalPart(
  events: GoalEvent[],
  dim: DriftDimKey,
  t: number,
): { value: number; causes: Array<{ event: GoalEvent; contribution: number }> } {
  let value = 0;
  const causes: Array<{ event: GoalEvent; contribution: number }> = [];
  for (const e of events) {
    for (const imp of GOAL_IMPULSES[e.kind]) {
      if (imp.dim !== dim) continue;
      const c = imp.amount * decay(t - e.at, imp.halfLifeDays);
      value += c;
      if (Math.abs(c) >= 0.02) causes.push({ event: e, contribution: c });
    }
  }
  causes.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  return { value, causes };
}

/* ==================================================================== */
/* Public surface                                                        */
/* ==================================================================== */

/** The four-dimensional drift at `t`. Pure, bounded to ±DRIFT_CAP. */
export function driftAt(contactId: string, t: number, epoch: number): DriftState {
  const events = goalEventsBetween(contactId, t - GOAL_DRIFT_WINDOW_MS, t + 1, epoch).filter(
    (e) => e.at <= t,
  );
  const state = {} as DriftState;
  for (const dim of DIM_KEYS) {
    const v = baseWalk(contactId, dim, t, epoch) + goalPart(events, dim, t).value;
    state[dim] = clamp(v, -DRIFT_CAP, DRIFT_CAP);
  }
  return state;
}

export interface DriftParams {
  /** Multiplier for the heartbeat interval's existing proactMul slot. */
  proactMul: number;
}

/**
 * Drift → behaviour, through the ONE existing channel. Bounded so that even a
 * saturated drift cannot silence an agent or turn her into a spammer — the
 * anti-spam cooldown (agent-state) still outranks everything.
 */
export function driftParams(state: DriftState): DriftParams {
  return { proactMul: clamp(1 + 0.6 * state.proactivity, 0.65, 1.5) };
}

/* ==================================================================== */
/* Explanation                                                           */
/* ==================================================================== */

export interface DriftDimExplanation {
  key: DriftDimKey;
  label: string;
  /** −1..1 after clamping — what the status page draws. */
  value: number;
  /** Human-language reason for the dominant contribution. */
  reason: string;
}

export interface DriftExplanation {
  dims: DriftDimExplanation[];
  /** One-line overall read for the page header. */
  summary: string;
  /** The goal events currently moving the needle, strongest first. */
  events: GoalEvent[];
}

const DIM_UP: Record<DriftDimKey, string> = {
  warmth: '最近待人比平时更热络',
  liveliness: '最近整个人比平时活泼',
  openness: '最近更愿意聊自己的事',
  proactivity: '最近更愿意主动来找你',
};
const DIM_DOWN: Record<DriftDimKey, string> = {
  warmth: '最近待人比平时淡一些',
  liveliness: '最近安静了一些',
  openness: '最近不太聊自己的事',
  proactivity: '最近不太主动开口',
};

function eventPhrase(e: GoalEvent): string {
  switch (e.kind) {
    case 'completed':
      return `刚完成了「${e.title}」`;
    case 'abandoned':
      return `刚放弃了「${e.title}」`;
    case 'milestone':
      return `「${e.title}」刚有了进展`;
    case 'setback':
      return `「${e.title}」上受了点挫`;
  }
}

/**
 * Why she is the way she is right now — per dimension, in words a status page
 * can show verbatim. Honest decomposition: a goal-caused shift names the goal;
 * an ambient shift says so; a flat dimension admits it is flat.
 */
export function explainDrift(contactId: string, t: number, epoch: number): DriftExplanation {
  const events = goalEventsBetween(contactId, t - GOAL_DRIFT_WINDOW_MS, t + 1, epoch).filter(
    (e) => e.at <= t,
  );
  const activeEvents = new Map<string, { event: GoalEvent; weight: number }>();

  const dims: DriftDimExplanation[] = DIM_KEYS.map((dim) => {
    const base = baseWalk(contactId, dim, t, epoch);
    const goal = goalPart(events, dim, t);
    const value = clamp(base + goal.value, -DRIFT_CAP, DRIFT_CAP);
    for (const c of goal.causes) {
      const cur = activeEvents.get(c.event.id);
      const weight = Math.abs(c.contribution);
      if (!cur || weight > cur.weight) activeEvents.set(c.event.id, { event: c.event, weight });
    }

    let reason: string;
    const top = goal.causes[0];
    if (top && Math.abs(top.contribution) >= 0.05) {
      reason = `${eventPhrase(top.event)}，${top.contribution > 0 ? DIM_UP[dim] : DIM_DOWN[dim]}`;
    } else if (Math.abs(value) < 0.08) {
      reason = '和平时差不多';
    } else {
      reason = `${value > 0 ? DIM_UP[dim] : DIM_DOWN[dim]}（近来的自然起伏）`;
    }
    return { key: dim, label: DRIFT_DIM_LABELS[dim], value, reason };
  });

  const strongest = [...dims].sort((a, b) => Math.abs(b.value) - Math.abs(a.value))[0];
  const summary =
    Math.abs(strongest.value) < 0.08
      ? '状态平稳，和你认识的她差不多。'
      : `${strongest.reason}。`;

  return {
    dims,
    summary,
    events: [...activeEvents.values()]
      .sort((a, b) => b.weight - a.weight)
      .map((x) => x.event),
  };
}

/* ==================================================================== */

function clamp(n: number, lo: number, hi: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.min(Math.max(v, lo), hi);
}
