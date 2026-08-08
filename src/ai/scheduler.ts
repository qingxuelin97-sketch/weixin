/**
 * The single time-evolution path (constitution rule #5).
 *
 * Everything that "happens by itself" — AI grabbing a red packet, a peer
 * accepting a transfer, a proactive heartbeat — is a row in `scheduled_actions`.
 * A foreground tick drains the due rows. There is deliberately no second timer
 * anywhere in the app: one queue means offline backfill (M4) is the same code
 * path as live execution, just with a wider time window.
 */
import { idbGet, idbGetAll, idbPut } from '../db/idb';
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
 * Has an action with this id EVER been queued (any status)? `enqueue` upserts by
 * id, so re-enqueueing a done action would silently revive it — for once-ever
 * actions (nudges) callers must check this first.
 */
export async function actionExists(id: string): Promise<boolean> {
  return (await idbGet<ScheduledAction>('scheduled_actions', id)) != null;
}

/** Is ANY action of this kind still pending? Used for roster-wide schedules (agent DMs). */
export async function hasPendingOfKind(kind: ActionKind): Promise<boolean> {
  const all = await idbGetAll<ScheduledAction>('scheduled_actions');
  return all.some((a) => a.status === 'pending' && a.kind === kind);
}

/**
 * Is an action of this kind already queued for this contact? Used on startup so
 * re-opening the app tops up missing schedules without stacking duplicates on
 * the ones already waiting.
 *
 * Matches the PARSED `contactId` field, not a substring — substring matching
 * false-positived on any payload merely mentioning the id (an agent_dm names
 * two agents; a hint can quote anyone). One-off extras (`nudge: true`) don't
 * count either: a pending nudge must not suppress the standing heartbeat chain.
 */
export async function hasPendingFor(kind: ActionKind, contactId: string): Promise<boolean> {
  const all = await idbGetAll<ScheduledAction>('scheduled_actions');
  return all.some((a) => {
    if (a.status !== 'pending' || a.kind !== kind) return false;
    try {
      const p = JSON.parse(a.payloadJson) as Record<string, unknown>;
      return p.contactId === contactId && p.nudge !== true;
    } catch {
      return false;
    }
  });
}

/** Handlers are registered by the app shell so this module stays dependency-free. */
export type ActionHandler = (payload: Record<string, unknown>, action: ScheduledAction) => Promise<void>;

const handlers = new Map<ActionKind, ActionHandler>();

export function registerHandler(kind: ActionKind, fn: ActionHandler): void {
  handlers.set(kind, fn);
}

let running = false;

/**
 * Kinds where seconds matter (a red-packet grab races the user's thumb). They
 * drain before any LLM-bound kind: a backfill batch of 8 slow generations in
 * front would otherwise stall a grab by minutes.
 */
const FAST_KINDS: ReadonlySet<ActionKind> = new Set(['rp_grab', 'transfer_accept']);

/**
 * Execute every past-due action once. Re-entrant-safe: a slow handler can't cause
 * a second tick to double-fire the same row.
 */
export async function runDueActions(now: number): Promise<number> {
  if (running) return 0;
  running = true;
  let n = 0;
  try {
    const due = (await duePending(now)).sort((a, b) => {
      const fa = FAST_KINDS.has(a.kind) ? 0 : 1;
      const fb = FAST_KINDS.has(b.kind) ? 0 : 1;
      return fa - fb || a.fireAt - b.fireAt;
    });
    for (const action of due) {
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
  // Swallow tick-level failures (e.g. IDB refusing mid-shutdown): an unhandled
  // rejection every second buries the console and can surface as a crash toast.
  timer = setInterval(() => void runDueActions(now()).catch(() => {}), TICK_MS);
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
