/**
 * L0 proactive-message heartbeat (foreground tick).
 *
 * The ONLY time-evolution path is the scheduled_actions queue (constitution rule
 * #5): a tick executes every past-due action and schedules the next one. Nothing
 * else may advance time. Scheduling is seeded (`seededRng`) so a reopened app
 * replays the same plan instead of re-rolling.
 */
import { seededRng } from '../lib/money';
import type { PersonaVM } from '../data/types';
import { idbGetAll, idbPut } from '../db/idb';

export interface ScheduledActionRow {
  id: string;
  fireAt: number;
  kind: 'heartbeat';
  payloadJson: string; // { contactId, convId }
  status: 'pending' | 'done' | 'cancelled';
  createdAt: number;
}

export const TICK_MS = 30_000;

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

export async function getPendingActions(now: number): Promise<ScheduledActionRow[]> {
  const all = await idbGetAll<ScheduledActionRow>('scheduled_actions');
  return all.filter((a) => a.status === 'pending' && a.fireAt <= now);
}

export async function scheduleHeartbeat(
  persona: PersonaVM,
  convId: string,
  from: number,
): Promise<ScheduledActionRow> {
  const fireAt = nextHeartbeatAt(persona, from);
  const row: ScheduledActionRow = {
    id: `hb_${persona.contactId}_${fireAt}`,
    fireAt,
    kind: 'heartbeat',
    payloadJson: JSON.stringify({ contactId: persona.contactId, convId }),
    status: 'pending',
    createdAt: from,
  };
  await idbPut('scheduled_actions', row);
  return row;
}

export async function markDone(row: ScheduledActionRow): Promise<void> {
  await idbPut('scheduled_actions', { ...row, status: 'done' });
}

/** Has this persona already got a pending heartbeat queued? */
export async function hasPendingHeartbeat(contactId: string): Promise<boolean> {
  const all = await idbGetAll<ScheduledActionRow>('scheduled_actions');
  return all.some((a) => a.status === 'pending' && a.payloadJson.includes(`"${contactId}"`));
}
