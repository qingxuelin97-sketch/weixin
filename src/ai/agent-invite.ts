/**
 * AI-initiated group proposals (M-I3): a friend who knows two of your other
 * friends eventually says "要不拉个群？" — in her own 1:1 with you, naming the
 * people. Confirming is the user's move (the proposal message carries the
 * suggested roster in its meta; the group itself is built through the normal
 * create/generate flow) — an AI must never conjure a group into your list.
 *
 * Pure, seeded planning; the proposal line is a template (zero LLM calls).
 */
import { seededRng } from '../lib/money';

const WEEK = 7 * 24 * 3_600_000;

/** Per proposing contact per week. Rare on purpose — it is a big ask. */
export const INVITE_CHANCE_PER_WEEK = 0.12;

export function inviteWeek(now: number): number {
  return Math.floor(now / WEEK);
}

export function inviteIdFor(contactId: string, week: number): string {
  return `ainv_${contactId}_${week}`;
}

/**
 * Should this contact propose a group this week, with which two friends?
 *
 * @param relationAiIds AI contacts she has a relations edge to
 * @param groupRosters  member lists of existing (non-hidden) groups — a trio
 *                      already sharing a room must not be proposed again
 */
export function maybeGroupInvite(
  contactId: string,
  relationAiIds: string[],
  groupRosters: string[][],
  now: number,
): { id: string; friends: [string, string]; fireAt: number } | null {
  if (relationAiIds.length < 2) return null;
  const week = inviteWeek(now);
  const rng = seededRng(`invite:${contactId}:${week}`);
  if (rng() >= INVITE_CHANCE_PER_WEEK) return null;
  // Seeded pick of two distinct friends.
  const pool = [...relationAiIds];
  const first = pool.splice(Math.floor(rng() * pool.length), 1)[0];
  const second = pool.splice(Math.floor(rng() * pool.length), 1)[0];
  const trio = new Set([contactId, first, second]);
  // Already together somewhere? Then the proposal would read as amnesia.
  for (const roster of groupRosters) {
    const r = new Set(roster);
    if ([...trio].every((id) => r.has(id))) return null;
  }
  return {
    id: inviteIdFor(contactId, week),
    friends: [first, second],
    fireAt: now + Math.round((1 + rng() * 24) * 3_600_000),
  };
}

/** The proposal, in plain words. Template — the persona color comes free from context. */
export function inviteLine(a: string, b: string): string {
  return `突然想到，要不把${a}和${b}拉一个群？人凑齐了约什么都方便`;
}
