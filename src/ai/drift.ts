/**
 * Personality drift (M-H1).
 *
 * Everything about a persona has been frozen since the day the card was
 * written. Her mood moves, her feelings move, the relationship edge moves —
 * but how proactive she is, how open-handed, how much she engages with your
 * Moments are constants read straight off a form. Six months of talking to
 * someone every day changes them; six months of talking to this app changed
 * nothing about who she is.
 *
 * Drift is a small, BOUNDED delta layer on top of the card:
 *
 *   - the card is never mutated. What is stored is a separate delta row, so
 *     the persona editor keeps showing what the user wrote, "reset" is a
 *     delete, and a `.aiwx` restore cannot come back with a character silently
 *     rewritten.
 *   - every dimension has a hard cap (±0.2). Unbounded drift is not character
 *     development, it is a random walk that eventually erases the persona —
 *     and the user has no way to notice it happening until she is gone.
 *   - every nudge keeps its reason. "她比刚认识时更主动了" is a feature;
 *     "她变了，不知道为什么" is a bug you cannot even file.
 *
 * On top of that stored layer sits a SECOND, unstored one: the goal linkage
 * (M-I14, restored in M-I18 — the merge that landed I14 resolved this file to
 * the pre-I14 side and dropped it, and nothing was red because the test that
 * should have caught it described the absence as intentional).
 *
 * 「她最近考过了，所以更爱找你」 is the whole point: a goal she has been
 * chasing for weeks finishes, and for a few days she is measurably more
 * forthcoming — then it decays back. That part is a PURE function of
 * (contactId, t, epoch) — the same seeded goal timeline `goals.ts` hands the
 * prompt and the share channel, so the three can never disagree about what
 * happened. Nothing about it is written, which is also what makes it
 * rollback-free: there is no row to reset, and it returns to zero on its own
 * inside GOAL_DRIFT_WINDOW_MS.
 *
 * Pure core, storage at the bottom. The clock is injected.
 */
import type { PersonaVM } from '../data/types';
import type { AffectEvent } from '../lib/affect';
import { repo } from '../db/repo';
import { logError } from '../lib/errlog';
import { agentEpoch, goalEventsBetween, type GoalEvent, type GoalEventKind } from './goals';

const DAY = 86_400_000;

/** The knobs that may drift. All are 0..1 rates read by real decisions. */
export type DriftDim = 'proactivity' | 'generosity' | 'likeRate' | 'commentRate';

export const DRIFT_DIMS: DriftDim[] = ['proactivity', 'generosity', 'likeRate', 'commentRate'];

/** How far any one dimension may ever move from the card. */
export const DRIFT_CAP = 0.2;

/**
 * Half-life of an un-reinforced drift, in days.
 *
 * Drift decays back toward the card unless the behaviour that caused it keeps
 * happening. Without this a single bad week would permanently redefine
 * someone, which is neither how people work nor something the user could undo
 * except by editing the card by hand.
 */
const DECAY_DAYS = 30;

export interface Drift {
  d: Partial<Record<DriftDim, number>>;
  /** Last time the delta was written or decayed. */
  at: number;
  /**
   * Why, newest first. Bounded — this is shown to the user, not logged.
   *
   * `dim` is set only for goal-caused reasons, which are attributable to one
   * dimension; the event-driven reasons below are about the relationship as a
   * whole and deliberately carry none.
   */
  why: Array<{ text: string; at: number; dim?: DriftDim }>;
}

const EMPTY: Drift = { d: {}, at: 0, why: [] };
const WHY_KEEP = 6;

/**
 * What each event does, per dimension.
 *
 * Tiny on purpose: it takes many repetitions to move a dimension a visible
 * amount, which is exactly what makes the movement mean something. A single
 * red packet should not make anyone measurably more generous.
 */
const EVENT_NUDGE: Partial<Record<AffectEvent, Partial<Record<DriftDim, number>>>> = {
  // You answer her. Reaching out keeps working, so she keeps doing it.
  user_reply: { proactivity: 0.004, commentRate: 0.002 },
  user_warm: { proactivity: 0.008, generosity: 0.006, likeRate: 0.004 },
  // You give her things. Reciprocity is the single most human money instinct.
  gift_received: { generosity: 0.02, proactivity: 0.006 },
  // She reached out and nothing came back. This is the one that must be able
  // to make someone quieter — an agent who cannot be discouraged is a toy.
  user_ignored: { proactivity: -0.012, likeRate: -0.004, commentRate: -0.006 },
  user_cold: { proactivity: -0.008, commentRate: -0.004 },
  conflict: { proactivity: -0.02, generosity: -0.01 },
};

const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);

/** Decay an un-reinforced drift toward zero. Pure. */
export function decayDrift(drift: Drift, now: number): Drift {
  if (!drift.at || now <= drift.at) return drift;
  const days = (now - drift.at) / DAY;
  const k = Math.pow(0.5, days / DECAY_DAYS);
  const d: Partial<Record<DriftDim, number>> = {};
  for (const dim of DRIFT_DIMS) {
    const v = (drift.d[dim] ?? 0) * k;
    // Below a thousandth it is noise pretending to be character.
    if (Math.abs(v) >= 0.001) d[dim] = v;
  }
  return { ...drift, d, at: now };
}

/** Human-readable reason for one nudge, or '' when it is not worth recording. */
function reasonFor(event: AffectEvent): string {
  switch (event) {
    case 'user_warm':
      return '你常跟她说软话';
    case 'gift_received':
      return '你给她发过东西';
    case 'user_ignored':
      return '她找过你，你没回';
    case 'user_cold':
      return '你回得比较冷淡';
    case 'conflict':
      return '你们吵过';
    default:
      return ''; // an ordinary reply is not a story
  }
}

/** Fold one event into the delta. Pure — the storage wrapper is below. */
export function applyEvent(prev: Drift, event: AffectEvent, now: number): Drift {
  const nudge = EVENT_NUDGE[event];
  if (!nudge) return prev;
  const base = decayDrift(prev, now);
  const d = { ...base.d };
  for (const dim of DRIFT_DIMS) {
    const delta = nudge[dim];
    if (delta == null) continue;
    d[dim] = clamp((d[dim] ?? 0) + delta, -DRIFT_CAP, DRIFT_CAP);
  }
  const reason = reasonFor(event);
  const why = reason
    ? [{ text: reason, at: now }, ...base.why.filter((w) => w.text !== reason)].slice(0, WHY_KEEP)
    : base.why;
  return { d, at: now, why };
}

/* --------------------------- goal linkage --------------------------- */

/** How far back a goal event still moves the needle at all. */
export const GOAL_DRIFT_WINDOW_MS = 14 * DAY;

/**
 * How far the goal layer may move a dimension on its own.
 *
 * Deliberately smaller than DRIFT_CAP: months of how you treat her outrank one
 * good week of hers. The two layers add, so the merged delta is bounded by
 * DRIFT_CAP + GOAL_DRIFT_CAP and `applyDrift` still clamps the knob to 0..1.
 */
export const GOAL_DRIFT_CAP = 0.15;

interface GoalImpulse {
  dim: DriftDim;
  amount: number;
  halfLifeDays: number;
}

/**
 * What each goal event does to her, and for how long.
 *
 * Completion is the headline effect and the plan's actual contract — 目标达成
 * → proactivity 短期上扬，之后衰减回落 — so it is the largest impulse and the
 * one with a half-life measured in days, not weeks. Nothing here becomes a new
 * personality: past GOAL_DRIFT_WINDOW_MS every one of these is exactly zero.
 */
const GOAL_IMPULSES: Record<GoalEventKind, GoalImpulse[]> = {
  completed: [
    { dim: 'proactivity', amount: 0.12, halfLifeDays: 3 },
    { dim: 'generosity', amount: 0.06, halfLifeDays: 3 },
    { dim: 'likeRate', amount: 0.05, halfLifeDays: 2.5 },
    { dim: 'commentRate', amount: 0.04, halfLifeDays: 2.5 },
  ],
  abandoned: [
    { dim: 'proactivity', amount: -0.07, halfLifeDays: 4 },
    { dim: 'commentRate', amount: -0.04, halfLifeDays: 4 },
  ],
  milestone: [{ dim: 'proactivity', amount: 0.03, halfLifeDays: 1.5 }],
  setback: [
    { dim: 'proactivity', amount: -0.03, halfLifeDays: 2 },
    { dim: 'likeRate', amount: -0.02, halfLifeDays: 2 },
  ],
};

function decayFactor(ageMs: number, halfLifeDays: number): number {
  return Math.pow(0.5, ageMs / (halfLifeDays * DAY));
}

/** One dimension's goal-driven delta at `t`, with the events that caused it. */
function goalPart(
  events: GoalEvent[],
  dim: DriftDim,
  t: number,
): { value: number; causes: Array<{ event: GoalEvent; contribution: number }> } {
  let value = 0;
  const causes: Array<{ event: GoalEvent; contribution: number }> = [];
  for (const e of events) {
    for (const imp of GOAL_IMPULSES[e.kind]) {
      if (imp.dim !== dim) continue;
      const c = imp.amount * decayFactor(t - e.at, imp.halfLifeDays);
      value += c;
      if (Math.abs(c) >= 0.01) causes.push({ event: e, contribution: c });
    }
  }
  causes.sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));
  return { value: clamp(value, -GOAL_DRIFT_CAP, GOAL_DRIFT_CAP), causes };
}

function eventPhrase(e: GoalEvent): string {
  switch (e.kind) {
    case 'completed':
      return `她刚做成了「${e.title}」`;
    case 'abandoned':
      return `她刚放弃了「${e.title}」`;
    case 'milestone':
      return `「${e.title}」刚有了进展`;
    case 'setback':
      return `「${e.title}」上刚受了点挫`;
  }
}

const GOAL_DIM_PHRASE: Record<DriftDim, [up: string, down: string]> = {
  proactivity: ['所以最近更爱主动来找你', '所以最近不太主动开口'],
  generosity: ['所以最近对你格外大方', '所以最近手紧了些'],
  likeRate: ['所以最近更爱给你点赞', '所以最近懒得点赞'],
  commentRate: ['所以最近更爱在你朋友圈说话', '所以最近不太评论'],
};

/**
 * The goal layer at `t`: pure, seeded, unstored.
 *
 * Exported so the transition can be tested without a database — the stored
 * layer needs a repo, this one needs nothing but arithmetic.
 */
export function applyGoalDrift(
  prev: Drift,
  contactId: string,
  now: number,
  epoch = agentEpoch(contactId),
): Drift {
  const events = goalEventsBetween(contactId, now - GOAL_DRIFT_WINDOW_MS, now + 1, epoch).filter(
    (e) => e.at <= now,
  );
  if (events.length === 0) return prev;

  const d = { ...prev.d };
  const why = [...prev.why];
  const cap = DRIFT_CAP + GOAL_DRIFT_CAP;
  for (const dim of DRIFT_DIMS) {
    const { value, causes } = goalPart(events, dim, now);
    if (Math.abs(value) < 0.001) continue;
    d[dim] = clamp((d[dim] ?? 0) + value, -cap, cap);
    const top = causes[0];
    if (top) {
      why.unshift({
        text: `${eventPhrase(top.event)}，${GOAL_DIM_PHRASE[dim][top.contribution > 0 ? 0 : 1]}`,
        at: top.event.at,
        dim,
      });
    }
  }
  // Goal reasons are the newest and the most specific, so they lead; the older
  // relationship reasons keep whatever room is left.
  return { ...prev, d, why: why.slice(0, WHY_KEEP + DRIFT_DIMS.length) };
}

/**
 * The persona as she is NOW: the card plus the delta, clamped to each field's
 * legal range.
 *
 * Returns the same object when there is no drift, so the common path costs
 * nothing and identity comparisons upstream keep working.
 */
export function applyDrift(persona: PersonaVM, drift: Drift | undefined): PersonaVM {
  if (!drift || Object.keys(drift.d).length === 0) return persona;
  const out = { ...persona };
  for (const dim of DRIFT_DIMS) {
    const delta = drift.d[dim];
    if (delta == null) continue;
    const base = typeof persona[dim] === 'number' ? (persona[dim] as number) : 0;
    out[dim] = clamp(base + delta, 0, 1);
  }
  return out;
}

export interface DriftExplanation {
  dim: DriftDim;
  delta: number;
  /** "更主动了" / "没那么主动了" */
  label: string;
  /**
   * The cause, in words, when there is an attributable one — today that means
   * a goal event ("她刚做成了「考出那张证」，所以最近更爱主动来找你"). Absent
   * when the movement is the slow residue of how the two of you have been
   * talking, which has no single moment to point at.
   */
  reason?: string;
}

const DIM_LABEL: Record<DriftDim, [up: string, down: string]> = {
  proactivity: ['比刚认识时更主动了', '比刚认识时安静了一些'],
  generosity: ['对你更大方了', '收敛了一些'],
  likeRate: ['更爱给你点赞了', '不太点赞了'],
  commentRate: ['更爱在你朋友圈说话了', '不太评论了'],
};

/**
 * What changed, in words, for the state page.
 *
 * Only reports what is actually visible: below a twentieth of a knob nothing
 * about her behaviour has measurably changed, and reporting it would be the
 * app claiming a personality change the user cannot possibly perceive.
 */
export function explainDrift(drift: Drift | undefined, floor = 0.05): DriftExplanation[] {
  if (!drift) return [];
  return DRIFT_DIMS.flatMap((dim) => {
    const delta = drift.d[dim] ?? 0;
    if (Math.abs(delta) < floor) return [];
    // Newest first, so the freshest attributable cause for this dimension wins.
    const reason = drift.why.find((w) => w.dim === dim)?.text;
    return [{ dim, delta, label: DIM_LABEL[dim][delta > 0 ? 0 : 1], ...(reason ? { reason } : {}) }];
  });
}

/* ----------------------------- storage ----------------------------- */

const driftKey = (contactId: string) => `drift:${contactId}`;

function readDrift(raw: unknown): Drift {
  if (!raw || typeof raw !== 'object') return EMPTY;
  const r = raw as Partial<Drift>;
  return {
    d: r.d && typeof r.d === 'object' ? r.d : {},
    at: typeof r.at === 'number' ? r.at : 0,
    why: Array.isArray(r.why) ? r.why.slice(0, WHY_KEEP) : [],
  };
}

/**
 * Drift as it is felt right now: the stored, decayed relationship layer plus
 * the unstored goal layer. Every behavioural read goes through here, so a goal
 * she just finished reaches the heartbeat interval through the SAME
 * `driftedPersona` → `proactMul` channel mood and affect already ride — no
 * second pacing mechanism (constitution rule #5).
 */
export async function getDrift(contactId: string, now: number): Promise<Drift> {
  let stored = EMPTY;
  try {
    stored = decayDrift(readDrift(await repo.getSetting(driftKey(contactId))), now);
  } catch {
    stored = EMPTY;
  }
  try {
    return applyGoalDrift(stored, contactId, now);
  } catch {
    return stored;
  }
}

/**
 * Record an event against a persona's drift.
 *
 * Fire-and-forget at every call site: character development is a garnish, and
 * a storage hiccup must never cost a reply.
 */
export async function noteDrift(
  contactId: string,
  event: AffectEvent,
  now: number,
): Promise<void> {
  try {
    const prev = readDrift(await repo.getSetting(driftKey(contactId)));
    const next = applyEvent(prev, event, now);
    if (next === prev) return;
    await repo.putSetting(driftKey(contactId), next);
  } catch (e) {
    logError('drift.note', e);
  }
}

/** Reset to the card. One row deleted — the card was never touched. */
export async function resetDrift(contactId: string): Promise<void> {
  try {
    await repo.putSetting(driftKey(contactId), EMPTY);
  } catch (e) {
    logError('drift.reset', e);
  }
}

/** The persona as she is now. The one call sites should use for BEHAVIOUR. */
export async function driftedPersona(persona: PersonaVM, now: number): Promise<PersonaVM> {
  return applyDrift(persona, await getDrift(persona.contactId, now));
}
