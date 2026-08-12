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
 * Pure core, storage at the bottom. The clock is injected.
 */
import type { PersonaVM } from '../data/types';
import type { AffectEvent } from '../lib/affect';
import { repo } from '../db/repo';
import { logError } from '../lib/errlog';

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
  /** Why, newest first. Bounded — this is shown to the user, not logged. */
  why: Array<{ text: string; at: number }>;
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
    return [{ dim, delta, label: DIM_LABEL[dim][delta > 0 ? 0 : 1] }];
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

export async function getDrift(contactId: string, now: number): Promise<Drift> {
  try {
    return decayDrift(readDrift(await repo.getSetting(driftKey(contactId))), now);
  } catch {
    return EMPTY;
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
