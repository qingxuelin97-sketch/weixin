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
import { planGift } from './money-motive';
import { maybeGroupEvent } from './group-events';
import { maybeGroupInvite } from './agent-invite';
// The live trigger's own threshold (a const — importing it pulls no storage
// call into this pure module): offline and online must agree on what counts
// as "enough conversation to be worth remembering".
import { MEM_EXTRACT_MIN_NEW } from './memory-service';
import type { MomentVisibility, PersonaVM } from '../data/types';
import { canSeeMoment } from '../lib/moment-visibility';
import { NO_FRIEND_PERMS, type FriendPermMap } from '../lib/friend-perms';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

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
  /**
   * Gifts across a whole absence (M-I18). One. Money is a gesture; two of them
   * in one night is a malfunction, and `planGift`'s own cooldown agrees.
   */
  gifts: 1,
  /** 聚会提议 + 拉群提议 planned offline, total (M-I18). */
  socialPlans: 2,
  /** Hard ceiling on LLM calls the drain will make. */
  llmCalls: 10,
  /**
   * Hard ceiling on ROWS, whatever they cost. Some kinds are free (a like is a
   * row, a gift's line was written by the planner, an invite is a template),
   * so the call budget alone would let a long absence queue an unbounded pile
   * of them.
   */
  events: 16,
} as const;

/**
 * What each kind costs the drain, in LLM calls.
 *
 * Counting free kinds as calls is not a conservative rounding — it spends the
 * budget on work that never happens, and the thing it crowds out is always a
 * real message. Keyed by kind so a new kind cannot be added without deciding.
 * Exported (M-J1) so the budget tests bill a plan with the SAME table the
 * planner spends by, instead of a hand-copied one that can drift.
 */
export const LLM_COST: Record<SimEvent['kind'], number> = {
  heartbeat: 1,
  moment_post: 1,
  group_msg: 1,
  moment_comment: 1,
  agent_dm: 1,
  group_event: 1, // the propose line is generated in her voice
  mem_extract: 1, // one extraction call per busy conversation (M-J1)
  moment_like: 0,
  ai_money: 0, // line + note come from the planner
  agent_invite: 0, // `inviteLine` is a template
};

/**
 * Which kinds get the last slot when the budget runs out. Lower wins.
 *
 * Spending the ceiling in chronological order sounds neutral and is not: group
 * chatter outnumbers everything else by an order of magnitude and starts at the
 * top of the window, so a plain `slice` hands it the entire budget and every
 * rarer kind is cut for being later. Measured, that made 聚会 unreachable in
 * 60 consecutive seeds. Order is by what an absence would be poorest without —
 * the one thing that HAPPENED beats the twentieth line of ambient talk.
 */
const KEEP_ORDER: Record<SimEvent['kind'], number> = {
  ai_money: 0,
  agent_invite: 0,
  group_event: 1,
  agent_dm: 1,
  heartbeat: 2,
  moment_post: 3,
  // Remembering a busy absence outranks its twentieth line of chatter (M-J1):
  // the chatter is scenery, the extraction is what makes tomorrow coherent.
  mem_extract: 4,
  moment_comment: 4,
  moment_like: 4,
  group_msg: 5,
};

/**
 * What the gift planner needs that simulate cannot read for itself (M-I18).
 *
 * Resolved by the impure caller, same arrangement as `SimGroup.activity`.
 * Absent = she never sends anything offline in this conversation, which is
 * exactly the pre-I18 behaviour.
 */
export interface SimGiftInput {
  /** Effective closeness 0..100 (relationship edge, already resolved). */
  affinity: number;
  /** When she last gave money HERE. Undefined = never. */
  lastGiftAt?: number;
}

export interface SimContact {
  contactId: string;
  convId: string;
  persona: PersonaVM;
  /** Timestamp of the last message in that conversation, if any. */
  lastMsgAt?: number;
  /** Enables offline gifts for this conversation (M-I18). */
  gift?: SimGiftInput;
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
  recentMoments?: Array<{
    id: string;
    authorId: string;
    createdAt: number;
    /**
     * 可见范围 (M-I18). Rides in with the row because the belated-reaction
     * planner below must honour it — an offline absence that comes back with a
     * like from someone the post was hidden from is the same穿帮 as a live one,
     * and the backfill path is the one most likely to be forgotten.
     */
    visibility?: MomentVisibility;
  }>;
  /**
   * 朋友权限 (M-J7). Passed in for the same reason `activity` is: simulate() is
   * pure and must not read storage — and for the same reason `visibility` rides
   * with the row: the belated-reaction planner is the read path most likely to
   * be forgotten, and a like from someone the user blocked is indistinguishable
   * from a live one once it lands.
   */
  friendPerms?: FriendPermMap;
  /**
   * Member lists of every non-hidden group (M-I18), for `agent_invite`: a trio
   * that already shares a room must never be proposed one. Passed in rather
   * than derived from `groups` so the offline decision uses the SAME rosters
   * the live foreground pass does — including rooms whose members have no
   * persona, which still count as "already together".
   */
  groupRosters?: string[][];
}

export interface SimEvent {
  kind:
    | 'heartbeat'
    | 'moment_post'
    | 'group_msg'
    | 'moment_like'
    | 'moment_comment'
    | 'agent_dm'
    | 'ai_money'
    | 'group_event'
    | 'agent_invite'
    | 'mem_extract';
  contactId: string;
  convId?: string;
  at: number;
  /** For moment_like / moment_comment: which post drew the reaction. */
  momentId?: string;
  /** For agent_dm: the session's pair and shared room. */
  dm?: { a: string; b: string; groupId: string };
  /**
   * Stable action id, when the LIVE path owns one too (M-I18).
   *
   * `gift_<conv>_<day>` / `gevt_<conv>_<week>_propose` / `ainv_<id>_<week>` are
   * all guarded by `actionExists` in the foreground pass. Materialising them
   * under backfill's own `bf_…` id would defeat that guard and schedule the
   * same event twice — once from the absence, once from the pass that runs
   * three lines later.
   */
  id?: string;
  /** Extra payload fields the live handler for this kind already reads. */
  payload?: Record<string, unknown>;
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
      // 可见范围 (M-I18) + 朋友权限 (M-J7), one check, one chokepoint.
      if (!canSeeMoment(m, cand.contactId, input.friendPerms ?? NO_FRIEND_PERMS)) continue;
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

  // --- Gifts (M-I18). She has been able to send you something since M-H1, but
  // only from the FOREGROUND pass, which plans with `now` = the live clock —
  // so every gift it has ever produced fires from now on, and three days away
  // meant three days in which she demonstrably never sent anything. The
  // decision stays `planGift`: one planner, live and offline. ---
  let gifts = 0;
  for (const cand of candidates) {
    if (gifts >= LIMITS.gifts) break;
    const g = cand.gift;
    if (!g || cand.lastMsgAt == null) continue; // a chat with no history gets none
    const floor = Math.max(from, cand.lastMsgAt + MINUTE);
    if (floor >= to) continue;
    const at = pickTimes(floor, to, 1, cand.persona, `gift:${seed}:${cand.contactId}`)[0];
    if (at == null) continue;
    const plan = planGift({
      persona: cand.persona,
      now: at,
      affinity: g.affinity,
      // Date-anchored reasons (生日/节日) belong to TODAY, which the live pass
      // owns; reactive ones (道歉/安慰) need something you just said to react
      // to. What is left is the one that actually reads as an absence that
      // kept going: 「随手请你喝杯奶茶」.
      occasions: [],
      recent: [
        { senderId: cand.contactId, type: 'text', content: '', createdAt: cand.lastMsgAt },
      ],
      lastGiftAt: g.lastGiftAt,
    });
    // `planGift` already aligned fireAt to an active hour; it may land past the
    // window, in which case this is simply not an offline gift.
    if (!plan || plan.fireAt <= floor || plan.fireAt > to) continue;
    gifts++;
    events.push({
      kind: 'ai_money',
      contactId: cand.contactId,
      convId: cand.convId,
      at: plan.fireAt,
      // Same id the live `considerGift` would mint for that day — one gift per
      // conversation per day, whichever path got there first.
      id: `gift_${cand.convId}_${Math.floor(at / DAY)}`,
      payload: {
        kind: plan.kind,
        reason: plan.reason,
        amountFen: plan.amountFen,
        note: plan.note,
        line: plan.line,
        ...(plan.kind === 'rp' ? { count: 1 } : {}),
      },
    });
  }

  // --- Social plans (M-I3, offline since M-I18). 聚会 and 拉群 proposals are
  // seeded weekly dice that the foreground pass rolls with `now` and schedules
  // 2–30h into the FUTURE — so they could never once happen during an absence.
  // Rolled here at `from` instead, with the same pure planners and the same
  // stable ids, so the live pass's actionExists guard still sees them. ---
  const personaById = new Map(candidates.map((c) => [c.contactId, c.persona]));
  const awakeFor = (contactId: string, t: number): boolean => {
    const p = personaById.get(contactId);
    if (p) return isActiveAt(p, t) && !agendaAt(p, t).busy;
    // No card to consult (a group member with no 1:1): fall back to plain
    // daytime. A 3am 聚会提议 is the same failure as the 6am night-owl text.
    const h = new Date(t).getHours();
    return h >= 9 && h < 23;
  };

  let socialPlans = 0;
  for (const g of input.groups) {
    if (socialPlans >= LIMITS.socialPlans) break;
    if (g.memberIds.length === 0) continue;
    const ev = maybeGroupEvent(g.convId, g.memberIds, from);
    if (!ev) continue;
    const lo = Math.max(from, (g.lastMsgAt ?? 0) + MINUTE);
    if (ev.proposeAt <= lo || ev.proposeAt > to) continue;
    if (!awakeFor(ev.initiator, ev.proposeAt)) continue;
    // The proposal IS a message in that room, so it answers to the same
    // ≤2-per-15-min bar the chatter does. A collision means skipping, not
    // squeezing: the live pass re-rolls this week's event under the same
    // stable id, so nothing is lost by staying quiet here.
    if (
      events.some(
        (e) => e.convId === g.convId && Math.abs(e.at - ev.proposeAt) < MIN_GROUP_GAP_MS,
      )
    ) {
      continue;
    }
    socialPlans++;
    events.push({
      kind: 'group_event',
      contactId: ev.initiator,
      convId: g.convId,
      at: ev.proposeAt,
      id: `${ev.id}_propose`,
      payload: {
        eventId: ev.id,
        initiator: ev.initiator,
        activity: ev.activity,
        phase: 'propose',
      },
    });
  }

  const rosters = input.groupRosters ?? input.groups.map((g) => g.memberIds);
  for (const cand of candidates) {
    if (socialPlans >= LIMITS.socialPlans) break;
    const relationAiIds = Object.keys(cand.persona.relations ?? {}).filter(
      (id) => id !== 'user' && personaById.has(id),
    );
    const inv = maybeGroupInvite(cand.contactId, relationAiIds, rosters, from);
    if (!inv) continue;
    const lo = Math.max(from, (cand.lastMsgAt ?? 0) + MINUTE);
    if (inv.fireAt <= lo || inv.fireAt > to) continue;
    if (!awakeFor(cand.contactId, inv.fireAt)) continue;
    socialPlans++;
    events.push({
      kind: 'agent_invite',
      contactId: cand.contactId,
      convId: cand.convId,
      at: inv.fireAt,
      id: inv.id,
      payload: { friend1: inv.friends[0], friend2: inv.friends[1] },
    });
  }

  // --- 离线也产记忆 (M-J1). A conversation the absence filled with enough
  // chatter deserves one memory pass at the window's tail — otherwise "she
  // remembers our talks" is true only for talks the user watched happen. The
  // threshold is the live trigger's own (MEM_EXTRACT_MIN_NEW); the subject id
  // follows the live convention (ChatPage): the contact for a single chat, the
  // conversation itself for a group. No `uptoMsgId` — the messages do not
  // exist yet at planning time; the handler resolves the frontier at fire
  // time, and the drain runs in time order so the chatter lands first. ---
  const groupConvIds = new Set(input.groups.map((g) => g.convId));
  const contactByConv = new Map(input.singles.map((c) => [c.convId, c.contactId]));
  const perConv = new Map<string, number>();
  for (const e of events) {
    if (!e.convId) continue; // DMs live in hidden threads; reactions have no conv
    if (e.kind !== 'heartbeat' && e.kind !== 'group_msg' && e.kind !== 'group_event') continue;
    perConv.set(e.convId, (perConv.get(e.convId) ?? 0) + 1);
  }
  for (const [convId, n] of perConv) {
    if (n < MEM_EXTRACT_MIN_NEW) continue;
    const subject = groupConvIds.has(convId) ? convId : contactByConv.get(convId);
    if (!subject) continue;
    events.push({ kind: 'mem_extract', contactId: subject, convId, at: to });
  }

  // Chronological: the drain inserts in this order, keeping rowid == time order.
  events.sort((a, b) => a.at - b.at);

  // Two ceilings, because the two costs are different: the network bill (LLM
  // calls) and the wall of rows the user opens the app to. A free kind that
  // does not fit under `events` still stops here; a free kind that does keeps
  // going even when the call budget is spent. Spent in KEEP_ORDER, returned in
  // time order — the drain inserts in the order it is handed.
  const keep = new Set<SimEvent>();
  let calls = 0;
  for (const e of [...events].sort(
    (a, b) => KEEP_ORDER[a.kind] - KEEP_ORDER[b.kind] || a.at - b.at,
  )) {
    if (keep.size >= LIMITS.events) break;
    const cost = LLM_COST[e.kind];
    if (calls + cost > LIMITS.llmCalls) continue;
    calls += cost;
    keep.add(e);
  }
  return { events: events.filter((e) => keep.has(e)), from, to, truncated };
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
