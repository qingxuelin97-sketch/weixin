/**
 * Group events (M-I3): an AI proposes a聚会 in the group, others RSVP over
 * the next hours, and a day later there is a "we actually went" moment.
 *
 * The arc is three chained scheduled phases — propose → rsvp → aftermath —
 * so it survives restarts, backfills correctly, and obeys constitution rule
 * #5 (the queue is the only clock). All PLANNING here is pure and seeded:
 * whether this week's group throws an event, who proposes, what activity,
 * and every delay are functions of (convId, week) alone.
 *
 * COST GATES (unit-locked):
 *   - `GROUP_EVENT_LLM_CALLS_PER_PHASE` = 1. The RSVP round is ONE dispatch
 *     call that writes every member's line — never one call per member.
 *   - at most `RSVP_MAX` members answer; the rest are presumed lurkers, which
 *     is also what a real group looks like.
 */
import { seededRng } from '../lib/money';

const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;

export const EVENT_ACTIVITIES = {
  hotpot: '组个火锅局',
  hike: '周末去爬山',
  ktv: '约一场KTV',
  boardgame: '找天来打桌游',
  movie: '一起去看那部新片',
} as const;

export type EventActivity = keyof typeof EVENT_ACTIVITIES;

/** Per group per week. Roughly one event every three weeks per lively group. */
export const GROUP_EVENT_CHANCE_PER_WEEK = 0.35;
export const GROUP_EVENT_LLM_CALLS_PER_PHASE = 1;
export const RSVP_MAX = 4;

export type EventPhase = 'propose' | 'rsvp' | 'aftermath';

export function weekBucket(now: number): number {
  return Math.floor(now / WEEK);
}

export function eventIdFor(convId: string, week: number): string {
  return `gevt_${convId}_${week}`;
}

/**
 * Does this group throw an event this week? Pure and seeded — the foreground
 * pass may ask any number of times and always gets the same answer, and the
 * stable id + actionExists guard (CLAUDE.md: enqueue upserts by id) is what
 * keeps the answer from being scheduled twice.
 */
export function maybeGroupEvent(
  convId: string,
  memberIds: string[],
  now: number,
): { id: string; initiator: string; activity: EventActivity; proposeAt: number } | null {
  if (memberIds.length < 3) return null; // a "group event" needs a group
  const week = weekBucket(now);
  const rng = seededRng(`gevt:${convId}:${week}`);
  if (rng() >= GROUP_EVENT_CHANCE_PER_WEEK) return null;
  const activities = Object.keys(EVENT_ACTIVITIES) as EventActivity[];
  const activity = activities[Math.floor(rng() * activities.length)];
  const initiator = memberIds[Math.floor(rng() * memberIds.length)];
  // Somewhere in the next 2-30 hours — never the instant the app opens.
  const proposeAt = now + Math.round((2 + rng() * 28) * HOUR);
  return { id: eventIdFor(convId, week), initiator, activity, proposeAt };
}

export function nextPhase(phase: string): EventPhase | null {
  return phase === 'propose' ? 'rsvp' : phase === 'rsvp' ? 'aftermath' : null;
}

/** Delay from the previous phase's fire time, seeded off the event identity. */
export function phaseDelayMs(phase: EventPhase, eventId: string): number {
  const rng = seededRng(`gevtdelay:${eventId}:${phase}`);
  if (phase === 'rsvp') return Math.round((1 + rng() * 2) * HOUR); // answers trickle in
  return Math.round((20 + rng() * 20) * HOUR); // the event "happens" next day
}

/** Staggered gaps between RSVP lines so the round reads as people, not a burst. */
export function rsvpGapMs(eventId: string, index: number): number {
  const rng = seededRng(`gevtgap:${eventId}:${index}`);
  return Math.round((1 + rng() * 5) * 60_000);
}

/** The one RSVP dispatch call: every answering member's line, one JSON. */
export function rsvpSystem(activity: EventActivity, names: string[]): string {
  return `群里有人提议「${EVENT_ACTIVITIES[activity]}」。下面这些人要在群里接话：${names.join('、')}。
只输出 JSON 数组：[{"name": "名字", "text": "TA 在群里回的那句话"}]

要求：
- 每人一条，口语、短（≤25 字）。
- 有人爽快答应、有人犹豫问细节（几点/在哪/多少钱）、可以有一个人放鸽子或吐槽。
- 名字必须从上面给的名单里取，不许发明新人。`;
}

/** Keep only lines from real members, bounded. Null = the round quietly skips. */
export function parseRsvps(
  raw: unknown,
  validNames: Set<string>,
): Array<{ name: string; text: string }> | null {
  if (!Array.isArray(raw)) return null;
  const out: Array<{ name: string; text: string }> = [];
  for (const r of raw) {
    const name = typeof (r as Record<string, unknown>)?.name === 'string' ? String((r as Record<string, unknown>).name).trim() : '';
    const text = typeof (r as Record<string, unknown>)?.text === 'string' ? String((r as Record<string, unknown>).text).trim() : '';
    if (!name || !text || !validNames.has(name)) continue;
    if (out.some((x) => x.name === name)) continue; // one line per person
    out.push({ name, text: text.slice(0, 40) });
    if (out.length >= RSVP_MAX) break;
  }
  return out.length ? out : null;
}

/** The aftermath moment: the initiator posts about how it went. One call. */
export function aftermathSystem(activity: EventActivity, initiatorName: string): string {
  return `${initiatorName} 前几天在群里${EVENT_ACTIVITIES[activity]}，事情已经发生了。
给 TA 写一条发朋友圈的文案（≤50 字）：说说实际去了之后怎么样——可以圆满、可以翻车、
可以吐槽谁没来。口语，别用 hashtag。只输出文案本身，不要引号不要解释。`;
}
