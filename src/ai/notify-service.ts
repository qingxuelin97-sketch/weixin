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
 *
 * MOMENTS REACTIONS (M-I15): queued likes/comments on the USER's own posts
 * notify too — that is the half of 朋友圈 that reaches you when the app is
 * closed. Grading:
 *   - a like's body is the ACT ("赞了你的朋友圈"), fully known at schedule
 *     time → kind 'reaction', preview shown;
 *   - a comment's text is GENERATED at fire time → kind 'followup', so it
 *     ships as "[你收到一条消息]" and can never contradict what actually lands.
 * Only the user's own posts qualify — being told a friend liked some third
 * friend's post is noise, and the momentId allowlist is built by the caller
 * from stored self-authored rows, so no other surface can widen it.
 */
import type { ScheduledAction } from './scheduler';
import type { ContactVM } from '../data/types';
import type { NotifyKind } from '../lib/notify';
import {
  notificationId,
  scheduleNotifications,
  cancelAll,
  type ScheduledNotification,
} from '../lib/notify';

/** Don't bother the OS with things further out than this. */
const HORIZON_MS = 24 * 3_600_000;

/** The fixed like line. The act is the content; nothing here can go stale. */
export const LIKE_NOTIFY_BODY = '赞了你的朋友圈';

/** Same grading logic as a like: the repost ACT is fully known at schedule time. */
export const REPOST_NOTIFY_BODY = '转发了你的朋友圈';

export interface NotifiableAction {
  id: string;
  kind: string;
  fireAt: number;
  contactId: string;
  /** Pre-written text; present only when it can be shown verbatim. */
  body?: string;
  /** Explicit grading for non-heartbeat kinds (M-I15); heartbeats derive theirs. */
  notifyKind?: NotifyKind;
}

export interface NotifiableOpts {
  /**
   * Moments the USER authored — the allowlist for like/comment notifications.
   * Absent = no moments notifications at all (the pre-I15 behavior), which is
   * also the safe default for any caller that has no feed context.
   */
  selfMomentIds?: ReadonlySet<string>;
}

/** Parse the queue rows into the minimum this module needs. Bad rows are skipped. */
export function toNotifiable(
  actions: ScheduledAction[],
  opts: NotifiableOpts = {},
): NotifiableAction[] {
  const out: NotifiableAction[] = [];
  for (const a of actions) {
    if (a.status !== 'pending') continue;
    const isMomentKind =
      a.kind === 'moment_like' || a.kind === 'moment_comment' || a.kind === 'moment_repost';
    if (a.kind !== 'heartbeat' && !isMomentKind) continue;
    try {
      const p = JSON.parse(a.payloadJson) as {
        contactId?: unknown;
        body?: unknown;
        momentId?: unknown;
      };
      if (typeof p.contactId !== 'string') continue;
      if (isMomentKind) {
        // Only reactions to the user's OWN posts, and only when the caller
        // could actually verify authorship against stored rows.
        if (typeof p.momentId !== 'string' || !opts.selfMomentIds?.has(p.momentId)) continue;
        out.push({
          id: a.id,
          kind: a.kind,
          fireAt: a.fireAt,
          contactId: p.contactId,
          ...(a.kind === 'moment_like'
            ? { body: LIKE_NOTIFY_BODY, notifyKind: 'reaction' as const }
            : a.kind === 'moment_repost'
              ? { body: REPOST_NOTIFY_BODY, notifyKind: 'reaction' as const }
              : { notifyKind: 'followup' as const }),
        });
        continue;
      }
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
      kind: a.notifyKind ?? (a.body ? 'greeting' : 'followup'),
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
  opts: NotifiableOpts = {},
): Promise<number> {
  await cancelAll();
  const nameOf = (id: string) => {
    const c = contacts.find((x) => x.id === id);
    return c ? (c.remark ?? c.name) : undefined;
  };
  const items = buildNotifications(toNotifiable(actions, opts), nameOf, now);
  if (items.length === 0) return 0;
  return scheduleNotifications(items, now);
}
