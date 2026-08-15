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
import { agendaAt } from './lifeline';
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
  /** 赞+评 on pre-absence posts, total per stretch (M-I5). Likes cost 0 LLM. */
  socialReactions: 4,
  /** Offline AI↔AI DM sessions per stretch (M-I5). One: DMs are expensive. */
  offlineDms: 1,
  /** Hard ceiling on LLM calls the drain will make. */
  llmCalls: 10,
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
  /**
   * Activity multiplier from the group's knobs (M-I1), default 1. Scales the
   * message BUDGET only — never the spacing, so the "≤2 events per 15 min"
   * bar holds at every level. Passed in by the caller because simulate() is a
   * pure function that must not read storage.
   */
  activity?: number;
}

export interface SimInput {
  singles: SimContact[];
  groups: SimGroup[];
  /**
   * User-visible moments that existed BEFORE the absence (M-I5) — the posts
   * offline friends may belatedly like or comment on. Newest few only; the
   * caller reads them, simulate stays pure.
   */
  recentMoments?: Array<{ id: string; authorId: string; createdAt: number }>;
}

export interface SimEvent {
  kind: 'heartbeat' | 'moment_post' | 'group_msg' | 'moment_like' | 'moment_comment' | 'agent_dm';
  contactId: string;
  convId?: string;
  at: number;
  /** For moment_like / moment_comment: which post drew the reaction. */
  momentId?: string;
  /** For agent_dm: the session's pair and shared room. */
  dm?: { a: string; b: string; groupId: string };
}

/**
 * The completion bar for offline group chat is "≤2 events per 15 minutes".
 * Enforced by construction — group slots are spaced at least this far apart —
 * rather than by a post-hoc filter, so the guarantee can't be lost to a later
 * refactor that reorders the pipeline.
 */
export const GROUP_WINDOW_MS = 15 * 60_000;
export const GROUP_MAX_PER_WINDOW = 2;

/**
 * Minimum spacing between two group messages.
 *
 * To hold "at most k events in ANY window of length W", k consecutive gaps must
 * span more than W — otherwise a window can straddle k+1 events. With k=2 and
 * W=15min the naive W/k = 7.5min is NOT enough: messages at 0, 7:30 and 15:00
 * put three inside a 15-minute window. Hence the extra minute.
 */
export const MIN_GROUP_GAP_MS = Math.floor(GROUP_WINDOW_MS / GROUP_MAX_PER_WINDOW) + 60_000;

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

  // --- Group chats: quiet chatter, rate-limited per group. ---
  for (const g of input.groups) {
    if (g.memberIds.length === 0) continue;
    events.push(...planGroupChatter(g, from, to, hours, seed));
  }

  // --- 赞评 on posts that predate the absence (M-I5). Coming back to a like
  // stamped 3am on last night's post is the cheapest possible proof the world
  // kept moving; likes cost zero LLM calls, comments cost one each. ---
  const reactBudget = Math.min(LIMITS.socialReactions, Math.round(hours / 3) + 1);
  let reacted = 0;
  for (const m of input.recentMoments ?? []) {
    if (reacted >= reactBudget) break;
    if (from - m.createdAt > 48 * HOUR) continue; // stale posts stop drawing
    for (const cand of candidates) {
      if (reacted >= reactBudget) break;
      if (cand.contactId === m.authorId) continue; // never self-react
      const r = seededRng(`react:${seed}:${from}:${m.id}:${cand.contactId}`);
      if (r() >= cand.persona.likeRate * 0.5) continue;
      const at = pickTimes(
        // A reaction can never predate its post; likes have no rowid concern,
        // but a like "before" the post reads as time travel all the same.
        Math.max(from, m.createdAt + MINUTE),
        to,
        1,
        cand.persona,
        `rt:${seed}:${m.id}:${cand.contactId}`,
      )[0];
      if (at == null) continue;
      reacted++;
      const isComment = r() < cand.persona.commentRate;
      events.push({
        kind: isComment ? 'moment_comment' : 'moment_like',
        contactId: cand.contactId,
        momentId: m.id,
        at,
      });
    }
  }

  // --- One AI↔AI DM session per absence (M-I5): the private social life the
  // agents already have live keeps running while the user is away — and its
  // spill/joint-plan/forward hatching all rides in through the same handler.
  if (hours >= 3) {
    let dms = 0;
    for (const g of input.groups) {
      if (dms >= LIMITS.offlineDms) break;
      if (g.memberIds.length < 2) continue;
      const r = seededRng(`odm:${seed}:${from}:${g.convId}`);
      if (r() >= 0.35) continue;
      const a = g.memberIds[Math.floor(r() * g.memberIds.length)];
      const rest = g.memberIds.filter((id) => id !== a);
      const b = rest[Math.floor(r() * rest.length)];
      if (!b) continue;
      dms++;
      // Deliberately NO convId: the session happens in the hidden DM thread,
      // not in the group — and a convId here would wrongly count against the
      // group's ≤2-per-15min message bar.
      events.push({
        kind: 'agent_dm',
        contactId: a,
        at: Math.round(from + r() * Math.max(1, to - from)),
        dm: { a, b, groupId: g.convId },
      });
    }
  }

  // Chronological: the drain inserts in this order, keeping rowid == time order.
  events.sort((a, b) => a.at - b.at);

  // Cap total LLM work regardless of how the rolls went.
  return { events: events.slice(0, LIMITS.llmCalls), from, to, truncated };
}

/**
 * Plan one group's offline chatter.
 *
 * A group that has been running all night should look like it ticked over, not
 * like it exploded — so the budget is per-hour, and slots are forced at least
 * GROUP_WINDOW_MS/GROUP_MAX_PER_WINDOW apart. That spacing is what makes the
 * "≤2 events per 15 min" bar hold for every window, not just on average.
 */
function planGroupChatter(
  g: SimGroup,
  from: number,
  to: number,
  hours: number,
  seed: string,
): SimEvent[] {
  // Never insert behind the group's own last message (rowid == time order).
  const lo = Math.max(from, (g.lastMsgAt ?? 0) + MINUTE);
  if (lo >= to) return [];

  const rng = seededRng(`grp:${seed}:${g.convId}:${from}`);
  const rawBudget = Math.min(
    groupMessageBudget(lo, to, g.memberIds.length),
    // …and still at most one per hour of absence: a big room is more talkative
    // per hour, not a wall of text the moment you open the app.
    Math.max(1, Math.round(hours * Math.min(2, Math.sqrt(g.memberIds.length / 4)))),
  );
  // The activity knob (M-I1) scales the BUDGET only. Spacing below is what
  // enforces the ≤2-per-15min bar and is deliberately untouched; and a quiet
  // room still says at least one thing per absence — quiet is not dead.
  const budget = Math.max(1, Math.round(rawBudget * Math.min(2, Math.max(0.1, g.activity ?? 1))));
  const maxBySpacing = Math.floor((to - lo) / MIN_GROUP_GAP_MS) + 1;
  const count = Math.min(budget, maxBySpacing);
  if (count <= 0) return [];

  const out: SimEvent[] = [];
  let cursor = lo;
  for (let i = 0; i < count; i++) {
    // At least MIN_GROUP_GAP_MS past the previous message, plus jitter, so the
    // group doesn't tick like a metronome.
    const at = Math.round(cursor + rng() * MIN_GROUP_GAP_MS);
    if (at > to) break;
    const speaker = g.memberIds[Math.floor(rng() * g.memberIds.length)];
    out.push({ kind: 'group_msg', contactId: speaker, convId: g.convId, at });
    cursor = at + MIN_GROUP_GAP_MS;
    if (cursor > to) break;
  }
  return out;
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
    // Awake is not the same as available (M-E3). `agendaAt` is a pure seeded
    // function of (contactId, t) — safe here, where `simulate` must stay a pure
    // function of its arguments (constitution rule #4). The affect pulse, which
    // is stored state, is deliberately NOT consulted anywhere in this file.
    if (agendaAt(persona, t).busy) continue;
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
export function groupMessageBudget(from: number, to: number, memberCount = 4): number {
  const hours = Math.max(0, (to - from) / HOUR);
  // Scale gate (M-H2). The per-hour budget was calibrated when a group meant
  // "≤4 AI members": come back after eight hours to a twenty-person group and
  // finding two messages reads as a dead room, not as a quiet night. Scaling
  // is deliberately sub-linear and hard-capped — the completion bar
  // ("≤2 events per 15 minutes", enforced by spacing) still holds, because
  // this only raises the ceiling, never the spacing.
  const scale = Math.min(3, Math.max(1, Math.sqrt(Math.max(1, memberCount) / 4)));
  const perHour = Math.round(LIMITS.groupMessagesPerHour * scale);
  return Math.min(perHour * Math.ceil(hours), perHour * 4);
}
