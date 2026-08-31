/**
 * 群的自发生命 (M-J2) — ambient chatter while the app is OPEN.
 *
 * Until now the only LIVE producer of a group message was DM spill-over:
 * with the app in the foreground, a group never spoke unless you spoke first
 * (runForegroundPass armed group_event's weekly dice and nothing else). The
 * offline half already exists — simulate() plans `group_msg` rows for the
 * backfill — so this module is deliberately the SAME shape pointed at the
 * live clock: a self-chaining kind (`group_chatter`) whose work step picks a
 * seeded speaker + topic hint and hands them to the existing
 * sendGroupProactiveMessage. No second engine, no new timer (rule #5).
 *
 * State rides IN THE CHAIN PAYLOAD (recent topics, last speaker) instead of a
 * settings row: the chain dies with its conversation (conversationExists guard),
 * so there is nothing for deleteContactCascade to learn about.
 *
 * Pure planning here; the impure enqueue lives at the bottom and the work step
 * in handlers.ts. Everything is seeded — rule #4.
 */
import type { PersonaVM } from '../data/types';
import type { GroupCfg } from './group-config';
import { seededRng } from '../lib/money';
import { enqueue } from './scheduler';

/** Someone spoke this recently → hold the interjection, keep the chain. */
export const CHATTER_MIN_QUIET_MS = 5 * 60_000;

/** Topics used in the last N chatter rounds are off the table (rotation). */
export const CHATTER_TOPIC_MEMORY = 3;

/**
 * Seeded interval to the next ambient line, by the group's activity knob.
 * Level 0 is quiet but NOT dead (group-config's own doctrine); level 2 is the
 * neutral default and roughly "a group that says something every hour or so".
 */
export function nextChatterDelayMs(activity: GroupCfg['activity'], seed: string): number {
  const rng = seededRng(`gchat:${seed}`);
  const [min, max] =
    activity === 0
      ? [180, 360]
      : activity === 1
        ? [90, 180]
        : activity === 2
          ? [40, 90]
          : [15, 40];
  return Math.round((min + rng() * (max - min)) * 60_000);
}

export interface ChatterMemberRef {
  contactId: string;
  persona?: PersonaVM;
}

/**
 * Who pipes up. Weighted by proactivity so the chatty personas carry the room,
 * with the previous speaker halved — the same voice twice in a row reads as a
 * monologue, not a group.
 */
export function pickChatterSpeaker(
  members: ChatterMemberRef[],
  lastSpeaker: string | undefined,
  seed: string,
): string | undefined {
  const cands = members.filter((m) => m.persona);
  if (cands.length === 0) return undefined;
  const rng = seededRng(`gchat-speaker:${seed}`);
  const weights = cands.map((m) => {
    const base = 0.2 + (m.persona?.proactivity ?? 0.5);
    return m.contactId === lastSpeaker ? base / 2 : base;
  });
  const total = weights.reduce((a, b) => a + b, 0);
  let roll = rng() * total;
  for (let i = 0; i < cands.length; i++) {
    roll -= weights[i];
    if (roll <= 0) return cands[i].contactId;
  }
  return cands[cands.length - 1].contactId;
}

/**
 * The topic hint for this round, rotating through the group's configured
 * topics and skipping the recently used ones. No configured topics → no hint;
 * the room drifts on its own, which is what an unconfigured group always did.
 */
export function pickChatterTopic(
  topics: string[],
  recent: string[],
  seed: string,
): string | undefined {
  const fresh = topics.filter((t) => !recent.includes(t));
  const pool = fresh.length > 0 ? fresh : topics;
  if (pool.length === 0) return undefined;
  const rng = seededRng(`gchat-topic:${seed}`);
  return pool[Math.floor(rng() * pool.length)];
}

/** Chain-payload topic memory: newest last, bounded. */
export function rememberTopic(recent: unknown, used: string | undefined): string[] {
  const base = Array.isArray(recent) ? recent.filter((t): t is string => typeof t === 'string') : [];
  if (!used) return base.slice(-CHATTER_TOPIC_MEMORY);
  return [...base, used].slice(-CHATTER_TOPIC_MEMORY);
}

/**
 * Queue the next ambient line for a group. Stable-per-fireAt id like the
 * heartbeat's, so a replayed chain step upserts instead of stacking.
 */
export async function scheduleGroupChatter(
  convId: string,
  activity: GroupCfg['activity'],
  from: number,
  carry: { recentTopics?: string[]; lastSpeaker?: string } = {},
  // Injectable for the handler path (HandlerDeps.enqueue) and for tests;
  // defaults to the real scheduler so the foreground arming stays one-liner.
  enq: (opts: {
    kind: 'group_chatter';
    fireAt: number;
    payload: Record<string, unknown>;
    now: number;
    id?: string;
  }) => Promise<unknown> = enqueue,
): Promise<unknown> {
  const fireAt = from + nextChatterDelayMs(activity, `${convId}:${from}`);
  return enq({
    kind: 'group_chatter',
    fireAt,
    payload: {
      convId,
      // Seed material for BOTH the chain step and the work step: they run at
      // different moments with different inputs, but must agree on who speaks
      // and about what — same payload + same pure functions = same answer.
      at: fireAt,
      ...(carry.recentTopics?.length ? { recentTopics: carry.recentTopics } : {}),
      ...(carry.lastSpeaker ? { lastSpeaker: carry.lastSpeaker } : {}),
    },
    now: from,
    id: `gchat_${convId}_${fireAt}`,
  });
}
