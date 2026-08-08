/**
 * The single time-evolution path (constitution rule #5).
 *
 * Everything that "happens by itself" — AI grabbing a red packet, a peer
 * accepting a transfer, a proactive heartbeat — is a row in `scheduled_actions`.
 * A foreground tick drains the due rows. There is deliberately no second timer
 * anywhere in the app: one queue means offline backfill (M4) is the same code
 * path as live execution, just with a wider time window.
 */
import { idbGetAll, idbPut } from '../db/idb';
import type { ScheduledActionKind } from '../db/schema';

/**
 * Derived from the persisted column's enum (src/db/schema.ts) so the two cannot
 * drift — they already had, silently, until M5.
 */
export type ActionKind = ScheduledActionKind;

export interface ScheduledAction {
  id: string;
  fireAt: number;
  kind: ActionKind;
  payloadJson: string;
  status: 'pending' | 'done' | 'cancelled';
  createdAt: number;
}

/** Foreground tick. 1s because red-packet grabs are second-scale. */
export const TICK_MS = 1_000;

export async function enqueue(opts: {
  kind: ActionKind;
  fireAt: number;
  payload: Record<string, unknown>;
  now: number;
  /** Stable id so re-enqueueing the same logical action doesn't duplicate it. */
  id?: string;
}): Promise<ScheduledAction> {
  const row: ScheduledAction = {
    id: opts.id ?? `${opts.kind}_${opts.fireAt}_${JSON.stringify(opts.payload).length}_${Math.trunc(opts.now)}`,
    fireAt: opts.fireAt,
    kind: opts.kind,
    payloadJson: JSON.stringify(opts.payload),
    status: 'pending',
    createdAt: opts.now,
  };
  await idbPut('scheduled_actions', row);
  return row;
}

export async function duePending(now: number): Promise<ScheduledAction[]> {
  const all = await idbGetAll<ScheduledAction>('scheduled_actions');
  return all
    .filter((a) => a.status === 'pending' && a.fireAt <= now)
    .sort((a, b) => a.fireAt - b.fireAt);
}

export async function markDone(a: ScheduledAction): Promise<void> {
  await idbPut('scheduled_actions', { ...a, status: 'done' });
}

/**
 * Is an action of this kind already queued for this contact? Used on startup so
 * re-opening the app tops up missing schedules without stacking duplicates on
 * the ones already waiting.
 */
export async function hasPendingFor(kind: ActionKind, contactId: string): Promise<boolean> {
  const all = await idbGetAll<ScheduledAction>('scheduled_actions');
  return all.some(
    (a) => a.status === 'pending' && a.kind === kind && a.payloadJson.includes(`"${contactId}"`),
  );
}

/** Handlers are registered by the app shell so this module stays dependency-free. */
export type ActionHandler = (payload: Record<string, unknown>, action: ScheduledAction) => Promise<void>;

const handlers = new Map<ActionKind, ActionHandler>();

export function registerHandler(kind: ActionKind, fn: ActionHandler): void {
  handlers.set(kind, fn);
}

let running = false;

/**
 * Execute every past-due action once. Re-entrant-safe: a slow handler can't cause
 * a second tick to double-fire the same row.
 */
export async function runDueActions(now: number): Promise<number> {
  if (running) return 0;
  running = true;
  let n = 0;
  try {
    for (const action of await duePending(now)) {
      const fn = handlers.get(action.kind);
      // Mark done BEFORE running so a throwing handler can't loop forever.
      await markDone(action);
      if (!fn) continue;
      try {
        await fn(JSON.parse(action.payloadJson) as Record<string, unknown>, action);
        n++;
      } catch {
        /* a failed action is dropped, never retried into an infinite loop */
      }
    }
  } finally {
    running = false;
  }
  return n;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the foreground tick. Idempotent. */
export function startScheduler(now: () => number = () => Date.now()): void {
  if (timer) return;
  timer = setInterval(() => void runDueActions(now()), TICK_MS);
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
