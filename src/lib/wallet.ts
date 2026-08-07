/**
 * Wallet + red-packet domain rules. Pure functions only — no storage, no clock —
 * so the money invariants (conservation, ordering, balance progression) are
 * unit-testable and replayable.
 */
import type { RedPacketVM, RpClaimVM, WalletTxVM, PersonaVM } from '../data/types';
import { seededRng, bestLuckIndex } from './money';

/** Grab-delay window per persona speed, in ms. */
const GRAB_WINDOWS: Record<NonNullable<PersonaVM['grabSpeed']>, [number, number]> = {
  fast: [1_000, 8_000],
  mid: [5_000, 20_000],
  slow: [10_000, 45_000],
};

/**
 * Deterministic delay before a given persona grabs a given red packet. Seeded by
 * (rpId, contactId) so a replay produces the same grab order.
 */
export function grabDelayMs(
  speed: PersonaVM['grabSpeed'] | undefined,
  rpId: string,
  contactId: string,
): number {
  const [lo, hi] = GRAB_WINDOWS[speed ?? 'mid'];
  const rng = seededRng(`${rpId}:${contactId}`);
  return Math.round(lo + rng() * (hi - lo));
}

/**
 * Assign the next unclaimed share of a red packet.
 * @returns the claim, or null if the packet is already fully claimed / re-claimed.
 */
export function claimShare(
  rp: RedPacketVM,
  existing: RpClaimVM[],
  claimerId: string,
  now: number,
): RpClaimVM | null {
  if (existing.some((c) => c.claimerId === claimerId)) return null; // no double-dipping
  const idx = existing.length;
  if (idx >= rp.sharesFen.length) return null; // fully claimed
  return {
    id: `${rp.id}:${claimerId}`,
    rpId: rp.id,
    claimerId,
    amountFen: rp.sharesFen[idx],
    isBest: false, // decided once the packet is fully claimed
    claimedAt: now,
  };
}

/** Whether every share of the packet has been taken. */
export function isFullyClaimed(rp: RedPacketVM, claims: RpClaimVM[]): boolean {
  return claims.length >= rp.count;
}

/**
 * Mark the luckiest claim once a packet is complete. Returns a new array; ties
 * resolve to the earliest share (matching `bestLuckIndex`).
 */
export function markBestLuck(rp: RedPacketVM, claims: RpClaimVM[]): RpClaimVM[] {
  if (!isFullyClaimed(rp, claims)) return claims.map((c) => ({ ...c, isBest: false }));
  const ordered = [...claims].sort((a, b) => a.claimedAt - b.claimedAt);
  const best = bestLuckIndex(ordered.map((c) => c.amountFen));
  const bestId = ordered[best]?.id;
  return claims.map((c) => ({ ...c, isBest: c.id === bestId }));
}

/** Current balance = the most recent ledger entry's running total (0 if empty). */
export function currentBalance(txs: WalletTxVM[]): number {
  if (txs.length === 0) return 0;
  return [...txs].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).slice(-1)[0]
    .balanceAfterFen;
}

/**
 * Append a ledger entry, computing the running balance. Pure: returns the new
 * entry; the caller persists it.
 */
export function appendTx(
  txs: WalletTxVM[],
  entry: Omit<WalletTxVM, 'balanceAfterFen'>,
): WalletTxVM {
  return { ...entry, balanceAfterFen: currentBalance(txs) + entry.amountFen };
}
