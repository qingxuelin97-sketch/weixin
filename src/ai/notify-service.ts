/**
 * Turning queued actions into lock-screen notifications.
 *
 * `src/lib/notify.ts` had no caller at all until now — it was written in M4 and
 * left unwired, so the whole pre-scheduled-notification feature was inert. This
 * module is the missing half.
 *
 * THE CONSISTENCY RULE (specs/backfill.md) is what shapes the design: whatever a
 * notification displays must already exist as a real message with
 * `createdAt === fireAt`. The user may read it on the lock screen and open the
 * app minutes later; different text, or the same text at a different time, is the
 * most jarring possible tell.
 *
 * Satisfying that without a server means the body has to be known *at schedule
 * time*. Rather than burn an LLM call on every foreground to invent one, this
 * uses `PersonaVM.greeting` — a hand-written, persona-specific opener that has
 * been sitting in the schema (and in every seed row) unread since M2. It is
 * time-anchored by nature, so it is still true whenever it fires.
 *
 * Heartbeats WITHOUT a pre-written body stay `followup`: they'd quote a
 * conversation that may have moved on, so they ship with no preview.
 */
import type { ScheduledAction } from './scheduler';
import type { ContactVM } from '../data/types';
import {
  notificationId,
  scheduleNotifications,
  cancelAll,
  type ScheduledNotification,
} from '../lib/notify';

/** Don't bother the OS with things further out than this. */
const HORIZON_MS = 24 * 3_600_000;

export interface NotifiableAction {
  id: string;
  kind: string;
  fireAt: number;
  contactId: string;
  /** Pre-written text; present only when it can be shown verbatim. */
  body?: string;
}

/** Parse the queue rows into the minimum this module needs. Bad rows are skipped. */
export function toNotifiable(actions: ScheduledAction[]): NotifiableAction[] {
  const out: NotifiableAction[] = [];
  for (const a of actions) {
    if (a.status !== 'pending' || a.kind !== 'heartbeat') continue;
    try {
      const p = JSON.parse(a.payloadJson) as { contactId?: unknown; body?: unknown };
      if (typeof p.contactId !== 'string') continue;
      out.push({
        id: a.id,
        kind: a.kind,
        fireAt: a.fireAt,
        contactId: p.contactId,
        body: typeof p.body === 'string' && p.body.trim() ? p.body : undefined,
      });
    } catch {
      /* malformed payload — not worth failing the whole sync over */
    }
  }
  return out;
}

/**
 * Build the notification list. Pure, so the grading and horizon rules are
 * unit-testable without touching the OS.
 *
 * @param nameOf resolve a contact id to its display name (the notification title)
 */
export function buildNotifications(
  actions: NotifiableAction[],
  nameOf: (contactId: string) => string | undefined,
  now: number,
): ScheduledNotification[] {
  const out: ScheduledNotification[] = [];
  for (const a of actions) {
    if (a.fireAt <= now) continue; // already due — the live tick handles it
    if (a.fireAt - now > HORIZON_MS) continue;
    const title = nameOf(a.contactId);
    if (!title) continue; // contact deleted since the action was queued
    out.push({
      id: notificationId(a.id),
      title,
      // A pre-written greeting can be shown verbatim; anything else must not be.
      // `displayBody()` enforces this again at delivery — belt and braces,
      // because a leaked preview is not a recoverable mistake.
      body: a.body ?? '',
      fireAt: a.fireAt,
      kind: a.body ? 'greeting' : 'followup',
    });
  }
  return out.sort((x, y) => x.fireAt - y.fireAt);
}

/**
 * Rebuild the OS notification set from the queue. Called on every foreground:
 * whatever was pending was written against a world the user has now moved past.
 *
 * @returns how many the platform actually accepted (0 on web — it cannot
 *          schedule ahead, and saying otherwise would be a lie)
 */
export async function syncNotifications(
  actions: ScheduledAction[],
  contacts: ContactVM[],
  now: number,
): Promise<number> {
  await cancelAll();
  const nameOf = (id: string) => {
    const c = contacts.find((x) => x.id === id);
    return c ? (c.remark ?? c.name) : undefined;
  };
  const items = buildNotifications(toNotifiable(actions), nameOf, now);
  if (items.length === 0) return 0;
  return scheduleNotifications(items, now);
}
