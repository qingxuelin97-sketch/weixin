/**
 * The single time-evolution path (constitution rule #5).
 *
 * Everything that "happens by itself" — AI grabbing a red packet, a peer
 * accepting a transfer, a proactive heartbeat — is a row in `scheduled_actions`.
 * A foreground tick drains the due rows. There is deliberately no second timer
 * anywhere in the app: one queue means offline backfill (M4) is the same code
 * path as live execution, just with a wider time window.
 */
import { idbGet, idbGetAllByIndex, idbPut, idbDelete, idbRangeByIndex } from '../db/idb';
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

/**
 * Everything past due and still pending, oldest first.
 *
 * Indexed on `fireAt` (v6). This runs once a SECOND while the app is open, and
 * used to be a full-table `getAll()` — over a store that only ever grew, since
 * completed rows were never removed. A month of ordinary use turned the idle
 * tick into a scan of thousands of rows, on a phone, forever.
 */
export async function duePending(now: number): Promise<ScheduledAction[]> {
  const rows = await idbRangeByIndex<ScheduledAction>('scheduled_actions', 'byFireAt', {
    upTo: now,
  });
  return rows.filter((a) => a.status === 'pending').sort((a, b) => a.fireAt - b.fireAt);
}

/**
 * How long a settled row is kept. Not zero: `enqueue` upserts by id, so
 * `actionExists()` on a completed row is what stops a once-ever action (a nudge)
 * from being queued again. Delete it too early and the nudge fires forever.
 *
 * 14 days is far outside every once-ever window in the app (the widest is the
 * nudge's 6–48h), so a GC'd row can no longer be re-triggered by its own rule.
 */
export const ACTION_RETENTION_MS = 14 * 24 * 3_600_000;

/**
 * Drop settled rows older than the retention window. Idempotent and cheap to
 * call on every foreground pass; returns how many rows went.
 */
export async function gcActions(now: number): Promise<number> {
  const cutoff = now - ACTION_RETENTION_MS;
  // Only settled rows are collectable, and `byStatus` can name them directly
  // — this used to `getAll()` a store that grows for the life of the install
  // and then discard the pending majority in JS.
  const settled = [
    ...(await idbGetAllByIndex<ScheduledAction>('scheduled_actions', 'byStatus', 'done')),
    ...(await idbGetAllByIndex<ScheduledAction>('scheduled_actions', 'byStatus', 'cancelled')),
  ];
  let n = 0;
  for (const a of settled) {
    // `fireAt` can be far in the past for backfilled rows; createdAt is when
    // this device actually learned about it, which is the honest age.
    if (Math.max(a.createdAt, a.fireAt) > cutoff) continue;
    await idbDelete('scheduled_actions', a.id);
    n++;
  }
  return n;
}

/**
 * Every action still waiting to run.
 *
 * The one place that reads the pending set, so the `byStatus` index (declared
 * in v1, unread until M-G1) is honoured everywhere. Four separate helpers used
 * to `getAll()` the whole store and filter in JS; on a return to the
 * foreground the app ran two of them PER CONVERSATION, so a 23-conversation
 * install did 46 full-table scans plus a JSON.parse per row per scan, every
 * time you switched back to the app.
 */
export async function pendingActions(): Promise<ScheduledAction[]> {
  return idbGetAllByIndex<ScheduledAction>('scheduled_actions', 'byStatus', 'pending');
}

/** Parse a pending row's payload; `null` when it is corrupt. */
export function payloadOf(a: ScheduledAction): Record<string, unknown> | null {
  try {
    return JSON.parse(a.payloadJson) as Record<string, unknown>;
  } catch {
    return null;
  }
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

/**
 * The status of a row by id, or `null` when no such row was ever queued.
 *
 * `actionExists` answers "was this id ever used", which is the RIGHT question
 * for a once-ever action (a nudge must not fire twice, whatever happened to the
 * first row). It is the WRONG question for a self-chaining action: a `cancelled`
 * row also "exists", so a guard written on existence turns a cancellation into a
 * permanent stop. That is exactly how auto-backup died — `setAutoBackupFreq`
 * cancels the pending row and immediately re-schedules, and within the same
 * period the successor's deterministic id is the id it just cancelled, so the
 * guard skipped it and the chain never restarted (tapping 每天 twice was enough).
 * Chain guards must ask about the STATE, not the existence.
 */
export async function actionStatus(id: string): Promise<ScheduledAction['status'] | null> {
  return (await idbGet<ScheduledAction>('scheduled_actions', id))?.status ?? null;
}

/** Is ANY action of this kind still pending? Used for roster-wide schedules (agent DMs). */
export async function hasPendingOfKind(kind: ActionKind): Promise<boolean> {
  return (await pendingActions()).some((a) => a.kind === kind);
}

/**
 * The same question against an already-loaded pending set.
 *
 * Callers that ask about many contacts in a row (the foreground pass asks
 * twice per conversation) load the set once and use these instead of paying
 * for a query each time.
 */
export function isPendingForIn(
  pending: readonly ScheduledAction[],
  kind: ActionKind,
  contactId: string,
): boolean {
  return pending.some((a) => {
    if (a.kind !== kind) return false;
    const p = payloadOf(a);
    return p != null && p.contactId === contactId && p.nudge !== true;
  });
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
  return isPendingForIn(await pendingActions(), kind, contactId);
}

/**
 * Cancel every pending action whose payload matches. Used when the thing an
 * action refers to stops existing — deleting a conversation used to leave its
 * heartbeat chain running forever: the handler generated a reply, found no
 * conversation, dropped it, and re-chained. An invisible, permanent LLM burn
 * that survived restarts because the chain lives in the DB, not in memory.
 *
 * Cancelled (not deleted) so the row's stable id still blocks `enqueue` from
 * reviving a once-ever action.
 */
export async function cancelPendingWhere(
  match: (payload: Record<string, unknown>, action: ScheduledAction) => boolean,
): Promise<number> {
  let n = 0;
  for (const a of await pendingActions()) {
    const payload = payloadOf(a);
    if (payload == null) continue;
    if (!match(payload, a)) continue;
    await idbPut('scheduled_actions', { ...a, status: 'cancelled' });
    n++;
  }
  return n;
}

/** Cancel everything queued against one conversation id. */
export async function cancelActionsForConversation(convId: string): Promise<number> {
  return cancelPendingWhere((p) => p.convId === convId);
}

/**
 * Cancel everything queued against one contact — for contact deletion, where
 * the chains are keyed by person rather than thread. Deliberately separate from
 * the conversation sweep: deleting one GROUP must not silence its members'
 * single chats, and the payload field names differ per handler.
 */
export async function cancelActionsForContact(contactId: string): Promise<number> {
  return cancelPendingWhere(
    (p) =>
      p.contactId === contactId ||
      p.speakerId === contactId ||
      p.authorId === contactId ||
      p.a === contactId ||
      p.b === contactId,
  );
}

/** Handlers are registered by the app shell so this module stays dependency-free. */
export type ActionHandler = (payload: Record<string, unknown>, action: ScheduledAction) => Promise<void>;

const handlers = new Map<ActionKind, ActionHandler>();

export function registerHandler(kind: ActionKind, fn: ActionHandler): void {
  handlers.set(kind, fn);
}

/**
 * Register a SELF-CHAINING kind — one whose handler is responsible for queueing
 * its own successor (heartbeats, Moments posts, agent DMs). The chain step runs
 * FIRST, before the work that can fail.
 *
 * Order is the whole point. Written the natural way — do the work, then chain —
 * a single thrown error ends that chain permanently: the row is already marked
 * done, no successor was queued, and nothing else in the app ever queues one.
 * One transient failure at 3am and that AI never speaks again, on a phone, with
 * no error anywhere. Chaining first costs nothing (a stale successor is
 * harmless; every enqueue is id-idempotent) and makes the failure survivable.
 */
export function registerChainedHandler(
  kind: ActionKind,
  steps: { chain: ActionHandler; work: ActionHandler },
): void {
  handlers.set(kind, async (payload, action) => {
    try {
      await steps.chain(payload, action);
    } catch (e) {
      // A failed chain still must not stop the work — and vice versa.
      onHandlerError(`chain:${kind}`, e);
    }
    await steps.work(payload, action);
  });
}

/** Where handler failures go. Set by the app shell; defaults to a no-op. */
let onHandlerError: (scope: string, err: unknown) => void = () => {};

export function setHandlerErrorSink(fn: (scope: string, err: unknown) => void): void {
  onHandlerError = fn;
}

let running = false;

/**
 * Kinds where seconds matter (a red-packet grab races the user's thumb). They
 * drain before any LLM-bound kind: a backfill batch of 8 slow generations in
 * front would otherwise stall a grab by minutes.
 */
const FAST_KINDS: ReadonlySet<ActionKind> = new Set([
  'rp_grab',
  'transfer_accept',
  // 斗图 (M-I18): a sticker comeback is a 0.8–2.5s beat in a live exchange. It
  // costs no LLM call, so letting it queue behind a backfill batch would turn
  // the one instant reaction in the app into a two-minute delayed punchline.
  'sticker_reply',
]);

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
      } catch (e) {
        // Dropped, never retried into an infinite loop — but no longer silent.
        // This catch is where "她突然不说话了" went to die for four milestones.
        onHandlerError(`action:${action.kind}`, e);
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
