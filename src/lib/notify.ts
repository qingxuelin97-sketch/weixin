/**
 * Pre-scheduled local notifications.
 *
 * The app has no server, so a notification that fires while the app is closed
 * must have been scheduled — with its text already written — before the app was
 * closed. That single constraint drives everything here.
 *
 * TWO RULES THAT MATTER MORE THAN THE PLUMBING:
 *
 * 1. CONTENT GRADING. Only time-anchored lines can be written in advance
 *    ("早安", a festival greeting, a promise to check in tomorrow) — their
 *    meaning doesn't depend on anything that happens between now and delivery.
 *    A follow-up that references a recent conversation cannot: by the time it
 *    fires, the conversation may have moved on and the preview would be wrong.
 *    Those ship WITHOUT a preview, exactly like WeChat's own "[你收到一条消息]".
 *
 * 2. CONSISTENCY. Whatever body a notification displays MUST be stored as a
 *    real message with `createdAt === fireAt`. The user may have read it on the
 *    lock screen; if opening the app showed different text, or the same text at
 *    a different time, the illusion breaks in the most jarring way possible.
 *
 * On web this degrades to the Notification API (no scheduling — a page that
 * isn't running can't fire anything), and to a silent no-op without permission.
 * Real lock-screen delivery needs the APK.
 */
import { Capacitor } from '@capacitor/core';

/** Why a notification is being scheduled — decides whether it can show a preview. */
export type NotifyKind =
  | 'greeting' // 早安/晚安 — anchored to a time of day
  | 'festival' // holiday wishes — anchored to a date
  | 'promise' // "明天提醒你" — anchored to an agreed moment
  | 'followup'; // references recent conversation — NOT pre-generatable

export interface ScheduledNotification {
  id: number;
  title: string;
  /** Full text. Ignored for kinds that can't show a preview. */
  body: string;
  fireAt: number;
  kind: NotifyKind;
}

/** WeChat's own no-preview line, used when the body can't be trusted to age well. */
export const NO_PREVIEW_BODY = '[你收到一条消息]';

/**
 * Whether this kind's real text may be baked into the notification now and
 * still be true whenever it fires.
 */
export function canPregenerateBody(kind: NotifyKind): boolean {
  return kind === 'greeting' || kind === 'festival' || kind === 'promise';
}

/** The body that will actually be displayed, after grading. */
export function displayBody(n: Pick<ScheduledNotification, 'kind' | 'body'>): string {
  return canPregenerateBody(n.kind) ? n.body : NO_PREVIEW_BODY;
}

interface LocalNotificationsPlugin {
  requestPermissions(): Promise<{ display: string }>;
  schedule(opts: { notifications: unknown[] }): Promise<unknown>;
  cancel(opts: { notifications: Array<{ id: number }> }): Promise<void>;
  getPending(): Promise<{ notifications: Array<{ id: number }> }>;
}

/**
 * Load the Capacitor plugin only when running natively. Importing it statically
 * on web pulls in a plugin that can't work there, and a failed dynamic import
 * must not take the app down.
 */
async function nativePlugin(): Promise<LocalNotificationsPlugin | null> {
  if (!Capacitor.isNativePlatform()) return null;
  try {
    const mod = await import('@capacitor/local-notifications');
    return mod.LocalNotifications as unknown as LocalNotificationsPlugin;
  } catch {
    return null;
  }
}

/** Ask for permission. Returns whether notifications may be posted. */
export async function requestPermission(): Promise<boolean> {
  const plugin = await nativePlugin();
  if (plugin) {
    try {
      return (await plugin.requestPermissions()).display === 'granted';
    } catch {
      return false;
    }
  }
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

/**
 * Schedule notifications for future delivery.
 *
 * Native: handed to the OS, so they fire with the app closed — the point of the
 * feature.
 *
 * Web: a browser cannot schedule anything for a page that isn't running, so
 * future items are simply not accepted. Already-due items ARE shown immediately
 * (that much the browser can do). The return value counts only what the platform
 * genuinely took on, so callers never report success the platform never promised.
 */
export async function scheduleNotifications(
  items: ScheduledNotification[],
  now: number,
): Promise<number> {
  const future = items.filter((n) => n.fireAt > now);
  const due = items.filter((n) => n.fireAt <= now);

  const plugin = await nativePlugin();
  if (plugin) {
    if (future.length === 0 && due.length === 0) return 0;
    try {
      await plugin.schedule({
        notifications: [...due, ...future].map((n) => ({
          id: n.id,
          title: n.title,
          body: displayBody(n),
          // A past `at` fires immediately on Android; keep it rather than
          // dropping the item, so a due notification is never silently lost.
          schedule: { at: new Date(Math.max(n.fireAt, now)), allowWhileIdle: true },
        })),
      });
      return due.length + future.length;
    } catch {
      return 0;
    }
  }

  // Web: show what's already due, decline the rest.
  let shown = 0;
  if (due.length && typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    for (const n of due) {
      try {
        new Notification(n.title, { body: displayBody(n), tag: String(n.id) });
        shown++;
      } catch {
        /* some browsers refuse outside a service worker; count only what worked */
      }
    }
  }
  return shown;
}

/**
 * Drop every pending notification. Called on foreground: anything still queued
 * was written against a world state the user has now moved past, so it gets
 * rebuilt from scratch rather than left to fire something stale.
 */
export async function cancelAll(): Promise<void> {
  const plugin = await nativePlugin();
  if (!plugin) return;
  try {
    const pending = await plugin.getPending();
    if (pending.notifications.length) {
      await plugin.cancel({ notifications: pending.notifications.map((n) => ({ id: n.id })) });
    }
  } catch {
    /* nothing pending, or the plugin is unavailable */
  }
}

/** Stable numeric id (the native API requires an int) derived from a string key. */
export function notificationId(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) | 0;
  return Math.abs(h) % 2_000_000_000;
}
