/**
 * Offline backfill planner.
 *
 * When the app has been closed for hours, the world should look like it kept
 * going: a couple of unread messages, a post or two, some likes. But the app was
 * NOT running, so all of that has to be invented at reopen — and invented
 * carefully, because the failure modes are ugly in both directions. Fabricate
 * too much and you come back to 40 unread messages that nobody could believe;
 * fabricate at the wrong times and your night-owl friend is texting at 6am.
 *
 * `simulate()` decides *what should have happened and when*. It calls no LLM,
 * touches no storage, and uses no wall clock — it is a pure function of its
 * inputs, so the same offline window always produces the same plan. The caller
 * materializes the result into `scheduled_actions` with past `fireAt` values and
 * lets the ordinary executor drain them, which is why live and backfilled events
 * run through identical code (constitution rule #5).
 */
import { seededRng } from '../lib/money';
import { isActiveAt } from './heartbeat';
import type { PersonaVM } from '../data/types';

const MINUTE = 60_000;
const HOUR = 3_600_000;

/** Nothing is fabricated inside this margin — it would collide with live play. */
export const SETTLE_MARGIN = 2 * MINUTE;

/** Windows longer than this are truncated to the most recent DAY. */
export const MAX_BACKFILL = 24 * HOUR;

/**
 * Caps. These are the difference between "she messaged me while I was out" and
 * "the app spat 40 fake messages at me". Tuned to feel like a normal absence.
 */
export const LIMITS = {
  /** At most this many distinct people start a single chat. */
  singleChatPeople: 3,
  /** Per person, per offline stretch. */
  messagesPerPerson: 2,
  /** Per group, per offline hour. */
  groupMessagesPerHour: 6,
  /** Total posts across everyone. */
  moments: 6,
  /** Hard ceiling on LLM calls the drain will make. */
  llmCalls: 8,
} as const;

export interface SimContact {
  contactId: string;
  convId: string;
  persona: PersonaVM;
  /** Timestamp of the last message in that conversation, if any. */
  lastMsgAt?: number;
}

export interface SimGroup {
  convId: string;
  /** Member contact ids that have personas. */
  memberIds: string[];
  lastMsgAt?: number;
}

export interface SimInput {
  singles: SimContact[];
  groups: SimGroup[];
}

export interface SimEvent {
  kind: 'heartbeat' | 'moment_post';
  contactId: string;
  convId?: string;
  at: number;
}

export interface SimPlan {
  events: SimEvent[];
  /** Window actually used after clamping — persisted as the new barrier. */
  from: number;
  to: number;
  /** True when the requested window was longer than MAX_BACKFILL. */
  truncated: boolean;
}

/**
 * Plan what happened between `t0` (the last time the app was foregrounded) and
 * `t1` (now).
 *
 * @param seed varies the plan per install without varying it per launch
 */
export function simulate(t0: number, t1: number, input: SimInput, seed: string): SimPlan {
  const to = t1 - SETTLE_MARGIN;
  const truncated = to - t0 > MAX_BACKFILL;
  const from = truncated ? to - MAX_BACKFILL : t0;

  if (to <= from) return { events: [], from: Math.min(from, to), to, truncated };

  const events: SimEvent[] = [];
  const rng = seededRng(`${seed}:${from}:${to}`);
  const hours = (to - from) / HOUR;

  // --- Single chats: pick who reaches out, in a stable but varied order. ---
  const candidates = [...input.singles]
    .map((c) => ({ c, roll: seededRng(`who:${seed}:${from}:${c.contactId}`)() }))
    .sort((a, b) => a.roll - b.roll)
    .map((x) => x.c);

  let speakers = 0;
  for (const cand of candidates) {
    if (speakers >= LIMITS.singleChatPeople) break;

    // A proactive person reaching out over a long absence is likely; a reserved
    // one over a short absence is not.
    const chance = Math.min(0.9, cand.persona.proactivity * Math.min(1, hours / 6));
    if (rng() >= chance) continue;

    // NEVER fabricate a time at or before this conversation's last message:
    // rows are inserted now, so an older timestamp would break the
    // rowid-order == time-order invariant that cursor pagination relies on.
    const floor = Math.max(from, (cand.lastMsgAt ?? 0) + MINUTE);
    if (floor >= to) continue;

    const slots = pickTimes(
      floor,
      to,
      1 + Math.floor(rng() * LIMITS.messagesPerPerson),
      cand.persona,
      `hb:${seed}:${cand.contactId}`,
    );
    if (slots.length === 0) continue; // asleep the whole window — stays silent

    speakers++;
    for (const at of slots) {
      events.push({ kind: 'heartbeat', contactId: cand.contactId, convId: cand.convId, at });
    }
  }

  // --- Moments: posts scale with the length of the absence. ---
  const momentBudget = Math.min(LIMITS.moments, Math.max(1, Math.round(hours / 4)));
  let posted = 0;
  for (const cand of candidates) {
    if (posted >= momentBudget) break;
    if (cand.persona.momentsPerDay <= 0) continue;
    const expected = cand.persona.momentsPerDay * (hours / 24);
    if (rng() >= Math.min(0.85, expected)) continue;
    const at = pickTimes(from, to, 1, cand.persona, `mp:${seed}:${cand.contactId}`)[0];
    if (at == null) continue;
    posted++;
    events.push({ kind: 'moment_post', contactId: cand.contactId, at });
  }

  // Chronological: the drain inserts in this order, keeping rowid == time order.
  events.sort((a, b) => a.at - b.at);

  // Cap total LLM work regardless of how the rolls went.
  return { events: events.slice(0, LIMITS.llmCalls), from, to, truncated };
}

/**
 * Choose up to `count` timestamps inside (lo, hi) that fall in the persona's
 * waking hours. Returns fewer — possibly none — when the window doesn't overlap
 * those hours at all. Silence is a valid, and often the most believable, result.
 */
function pickTimes(
  lo: number,
  hi: number,
  count: number,
  persona: PersonaVM,
  seed: string,
): number[] {
  if (hi <= lo) return [];
  const rng = seededRng(seed);
  const out: number[] = [];
  // Sample rather than scan: cheap, and biased toward nothing in particular.
  for (let attempt = 0; attempt < 40 && out.length < count; attempt++) {
    const t = Math.round(lo + rng() * (hi - lo));
    if (!isActiveAt(persona, t)) continue;
    // Keep a human gap between two messages from the same person.
    if (out.some((x) => Math.abs(x - t) < 3 * MINUTE)) continue;
    out.push(t);
  }
  return out.sort((a, b) => a - b);
}

/**
 * Group chatter budget for a window. Exposed separately because group backfill
 * is driven by the director rather than per-person heartbeats.
 */
export function groupMessageBudget(from: number, to: number): number {
  const hours = Math.max(0, (to - from) / HOUR);
  return Math.min(LIMITS.groupMessagesPerHour * Math.ceil(hours), LIMITS.groupMessagesPerHour * 4);
}
