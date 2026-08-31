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

/**
 * Gap before the i-th 名片 that follows the proposal.
 *
 * She names two people and then sends their cards — a real person does that a
 * few seconds later, one card at a time, not in the same instant. Seeded off
 * the invite id (rule #4), so a replay reproduces the same rhythm.
 */
export function inviteCardGapMs(inviteId: string, index: number): number {
  return Math.round((2 + seededRng(`invcard:${inviteId}:${index}`)() * 6) * 1_000);
}

/* --------------------- the user's half of the loop --------------------- */

/**
 * A proposal is only a proposal until the USER acts on it. These helpers are
 * the whole contract between the handler (which writes `meta.suggestGroup`) and
 * the chat UI (which renders a tappable card): pure, so the closure that used
 * to be missing entirely is now unit-testable.
 *
 * Ignoring the card is a legal outcome and costs nothing — there is deliberately
 * no reminder, no badge and no second proposal for the same week.
 */

/** Roster size the card will accept. Three is what `maybeGroupInvite` proposes. */
export const SUGGEST_GROUP_MAX = 6;

/**
 * Read the suggested roster out of a message's meta. Returns null for anything
 * that is not a usable list of contact ids — a malformed row must render as an
 * ordinary text message, never as a broken card.
 */
export function parseSuggestGroup(meta: Record<string, unknown> | undefined): string[] | null {
  const raw = meta?.suggestGroup;
  if (!Array.isArray(raw)) return null;
  const ids = [
    ...new Set(raw.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)),
  ].slice(0, SUGGEST_GROUP_MAX);
  return ids.length >= 2 ? ids : null;
}

/**
 * The card's roster line, from names the caller resolved. Ids never appear on
 * screen (nor in the model's projection — see `render-msg`).
 */
export function inviteCardNames(names: string[]): string {
  return names.join('、');
}

/**
 * Hand the roster to the ordinary 发起群聊 screen with those people pre-ticked
 * (`/group-new?preset=…`). Creating the group stays the USER's action — the AI
 * only proposes, so this navigates to the picker instead of writing a room.
 */
export const SUGGEST_GROUP_PARAM = 'preset';

export function suggestGroupHref(ids: string[]): string {
  return `/group-new?${SUGGEST_GROUP_PARAM}=${ids.map(encodeURIComponent).join(',')}`;
}

/**
 * The picker's side: which of the preset ids are real, pickable contacts today.
 * A friend deleted between the proposal and the tap simply is not pre-ticked.
 */
export function presetMemberIds(
  param: string | null | undefined,
  isPickable: (id: string) => boolean,
): string[] {
  if (!param) return [];
  return [
    ...new Set(
      param
        .split(',')
        .map((s) => decodeURIComponent(s.trim()))
        .filter((id) => id && isPickable(id)),
    ),
  ].slice(0, SUGGEST_GROUP_MAX);
}
