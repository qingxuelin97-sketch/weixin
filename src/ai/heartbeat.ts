/**
 * Proactive-message scheduling ("她先找我").
 *
 * This module owns only the *timing math* — when should a persona next reach out.
 * The queue itself lives in `scheduler.ts` (constitution rule #5: one time-evolution
 * path); this file must never grow its own pending/done bookkeeping again.
 *
 * Scheduling is seeded so reopening the app replays the same plan instead of
 * re-rolling a fresh one every launch.
 */
import { seededRng } from '../lib/money';
import type { PersonaVM } from '../data/types';
import { enqueue, type ScheduledAction } from './scheduler';

/** Local hour a timestamp falls in (activity windows are in local hours). */
function hourOf(ts: number): number {
  return new Date(ts).getHours();
}

/** Whether `ts` falls inside any of the persona's active windows (end may wrap past 24). */
export function isActiveAt(persona: PersonaVM, ts: number): boolean {
  const h = hourOf(ts);
  return persona.activeHours.some(([start, end]) => {
    if (end <= 24) return h >= start && h < end;
    // Window wraps past midnight, e.g. [14, 26] == 14:00–02:00.
    return h >= start || h < end - 24;
  });
}

/**
 * Pick the next heartbeat time for a persona: an exponential-ish interval scaled
 * by proactivity, nudged forward until it lands inside an active window.
 * Deterministic for a given (personaId, dayBucket) seed.
 */
export function nextHeartbeatAt(persona: PersonaVM, from: number): number {
  const dayBucket = Math.floor(from / 86_400_000);
  const rng = seededRng(`${persona.contactId}:${dayBucket}`);
  // Higher proactivity → shorter base interval.
  const base = persona.heartbeatBaseMin * (1.6 - persona.proactivity); // minutes
  const jitter = 0.5 + rng(); // 0.5..1.5
  let t = from + base * jitter * 60_000;
  // Walk forward in hour steps until inside an active window (max 48 steps).
  for (let i = 0; i < 48 && !isActiveAt(persona, t); i++) t += 3_600_000;
  return Math.round(t);
}

/** Queue this persona's next proactive message. Id is stable per fire time. */
export async function scheduleHeartbeat(
  persona: PersonaVM,
  convId: string,
  from: number,
): Promise<ScheduledAction> {
  const fireAt = nextHeartbeatAt(persona, from);
  return enqueue({
    kind: 'heartbeat',
    fireAt,
    payload: { contactId: persona.contactId, convId },
    now: from,
    id: `hb_${persona.contactId}_${fireAt}`,
  });
}

