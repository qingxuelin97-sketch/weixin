/**
 * 模拟访客感 (M-I15): the「XX 刚看过你的朋友圈」hint row.
 *
 * Real WeChat never tells you who viewed your feed — which is exactly why the
 * hint lands: it is the one small "someone was here" signal this app CAN give,
 * because the friends are simulated and their attention is ours to stage.
 *
 * Constitution rule #4 applies in full: the decision is a pure function of
 * (candidates, now) with all randomness seeded on the hour bucket. The same
 * hour always names the same visitor — reopening the page does not reroll the
 * dice, and a screenshot test never flickers. Deliberately LOW frequency: a
 * visitor every hour reads as surveillance theater, roughly one hour in four
 * reads as life.
 */
import { seededRng } from '../lib/money';

const HOUR = 3_600_000;

/** Fraction of hour buckets that produce a visitor at all. */
export const VISIT_RATE = 0.28;

/** How long after the "visit" the hint stays up. Short — it is a moment, not a banner. */
export const VISIT_TTL_MS = 45 * 60_000;

export interface FeedVisit {
  contactId: string;
  /** When they "looked" — always in the past relative to `now`. */
  at: number;
}

/**
 * Who (if anyone) recently looked at the user's feed.
 *
 * @param candidateIds AI contact ids that could plausibly visit (stable order
 *   matters for determinism — pass them sorted or in roster order).
 * @param now current time; only the hour bucket and the TTL window read it.
 */
export function recentVisitor(candidateIds: readonly string[], now: number): FeedVisit | null {
  if (candidateIds.length === 0) return null;
  // Check this hour first, then the previous one — a visit at :50 should still
  // show at :05 of the next hour rather than vanish on the bucket boundary.
  for (const bucket of [Math.floor(now / HOUR), Math.floor(now / HOUR) - 1]) {
    const rng = seededRng(`feedvisit:${bucket}`);
    if (rng() >= VISIT_RATE) continue;
    const who = candidateIds[Math.floor(rng() * candidateIds.length)];
    // The visit lands somewhere inside its bucket, never in the future.
    const at = bucket * HOUR + Math.floor(rng() * HOUR);
    if (at > now) continue; // this bucket's visit hasn't "happened" yet
    if (now - at > VISIT_TTL_MS) continue; // too old to still mention
    return { contactId: who, at };
  }
  return null;
}

/** The hint line itself. Kept here so the copy is testable and single-sourced. */
export function visitorLine(name: string): string {
  return `${name} 刚看过你的朋友圈`;
}
