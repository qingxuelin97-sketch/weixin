/**
 * Live native alerts for messages that land while the app is BACKGROUNDED but
 * the WebView is still alive (M-I10) — Android keeps the process (and its
 * timers, throttled) running for a while after the user switches away, which
 * is exactly when the scheduler can still deliver a heartbeat or group line
 * with nobody watching.
 *
 * Three surfaces, all fed from one store subscription:
 *  - a RemoteInput message notification (reply from the shade → ReplyQueue →
 *    reply-drain on the next foreground),
 *  - the floating bubble (if SYSTEM_ALERT_WINDOW is granted and the toggle on),
 *  - occasionally, a full-screen INCOMING CALL instead of a plain notification
 *    (seeded per message id — constitution rule 4, no Math.random) that deep
 *    links into CallPage's incoming UI.
 *
 * DIVISION OF LABOR vs lib/notify.ts: that module PRE-schedules OS
 * notifications so they fire when the app is DEAD; this one reacts to messages
 * that actually got generated while it is alive. Known overlap: a pre-scheduled
 * heartbeat notification may fire near the live one (different ids); the
 * foreground rebuild clears the stale half. Accepted — see specs/native-android.md.
 *
 * CONTENT RULES:
 *  - hidden AI↔AI threads never notify (checked here AND unread never counts
 *    them, but this module must not rely on that);
 *  - a full-tier conversation shows NO preview on the lock screen — the body
 *    degrades to WeChat's own "[你收到一条消息]" (NO_PREVIEW_BODY).
 */
import type { MessageVM } from '../data/types';
import { notifyMessage, notifyCall, cancelNotify, showBubble, overlayGranted, isNative } from './bridge';
import { useAppStore } from '../store/appStore';
import { repo } from '../db/repo';
import { NO_PREVIEW_BODY, notificationId } from '../lib/notify';
import { tierOfConversation } from '../lib/nsfw-tier';
import { seededRng } from '../lib/money';
import { logError } from '../lib/errlog';
import { convDisplayName } from './widget-sync';

/** Chance a proactive single-chat message arrives as a voice call instead. */
export const INCOMING_CALL_PROB = 0.07;

/** Trailing debounce so a multi-bubble turn posts ONE notification. */
const BURST_MS = 1_500;

/**
 * How long an un-answered call notification may live (M-J0). The Kotlin side
 * posts it setOngoing (un-swipeable) with a comment promising "the JS side
 * cancels on timeout" — that half simply did not exist, so a missed call left
 * a permanent, un-dismissable 「来电」 in the shade. Slightly longer than the
 * in-app RING_MS (30s) so the ring overlay's own miss path wins when both run.
 */
const CALL_NOTIF_TTL_MS = 35_000;

export interface NativeNotifySettings {
  bubble: boolean;
  incomingCall: boolean;
}

export async function readNativeNotifySettings(): Promise<NativeNotifySettings> {
  const [bubble, call] = await Promise.all([
    repo.getSetting<boolean>('nativeBubble'),
    repo.getSetting<boolean>('nativeIncomingCall'),
  ]);
  return { bubble: bubble ?? true, incomingCall: call ?? true };
}

/**
 * Pure decision: does this freshly-appended message warrant a native surface,
 * and which one? Exported for unit tests.
 */
export function classifyIncoming(args: {
  msg: Pick<MessageVM, 'id' | 'senderId' | 'type'>;
  convId: string;
  convType: 'single' | 'group';
  isHidden: boolean;
  appVisible: boolean;
  settings: NativeNotifySettings;
}): 'none' | 'message' | 'call' {
  const { msg, convId, convType, isHidden, appVisible, settings } = args;
  if (appVisible) return 'none'; // the user is looking at the app
  if (isHidden) return 'none'; // AI↔AI DMs must never surface
  if (msg.senderId === 'self') return 'none';
  if (msg.type === 'system') return 'none';
  if (
    settings.incomingCall &&
    convType === 'single' &&
    msg.type === 'text' &&
    seededRng(`nativecall_${convId}_${msg.id}`)() < INCOMING_CALL_PROB
  ) {
    return 'call';
  }
  return 'message';
}

/** Stable notification id per conversation — a burst updates, not stacks. */
export function msgNotifId(convId: string): number {
  return notificationId(`native_msg_${convId}`);
}

export function callNotifId(convId: string): number {
  return notificationId(`native_call_${convId}`);
}

interface PendingBurst {
  timer: ReturnType<typeof setTimeout>;
  surface: 'message' | 'call';
}

/**
 * Start watching the store for background-arriving messages. Returns a stop
 * function. No-op on web (returns an inert stop).
 */
export function startBackgroundNotify(): () => void {
  if (!isNative()) return () => {};

  const seen = new Map<string, number>(); // convId → last seen message id
  const bursts = new Map<string, PendingBurst>();
  // Armed call notifications (M-J0): each cancels itself after the ring window,
  // and cancels EARLY the moment the in-app ring resolves (answer/decline/miss).
  const callTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let ringingConv: string | null = useAppStore.getState().incomingCall?.convId ?? null;
  const dropCallNotif = (convId: string) => {
    const t = callTimers.get(convId);
    if (t) clearTimeout(t);
    callTimers.delete(convId);
    void cancelNotify(callNotifId(convId));
  };
  // Prime with current state so hydration's initial load never notifies.
  for (const [convId, msgs] of Object.entries(useAppStore.getState().messages)) {
    const last = msgs.at(-1);
    if (last) seen.set(convId, last.id);
  }

  const fire = async (convId: string, surface: 'message' | 'call') => {
    try {
      const s = useAppStore.getState();
      const conv = s.conversationById(convId);
      if (!conv || conv.isHidden) return;
      // Re-check visibility at fire time: the user may have come back during
      // the debounce window, and notifying about a chat they are reading is
      // exactly the annoyance this module exists to avoid.
      if (document.visibilityState === 'visible') return;
      const title = convDisplayName(conv, s.contactById) ?? '微信';

      if (surface === 'call') {
        await notifyCall(convId, title, callNotifId(convId));
        const t = callTimers.get(convId);
        if (t) clearTimeout(t);
        callTimers.set(
          convId,
          setTimeout(() => dropCallNotif(convId), CALL_NOTIF_TTL_MS),
        );
        return;
      }

      const memberIds =
        conv.type === 'group' ? (conv.memberIds ?? []) : conv.peerId ? [conv.peerId] : [];
      const tier = await tierOfConversation(memberIds, s.personaFor);
      const body = tier === 'full' ? NO_PREVIEW_BODY : conv.lastMsgPreview || NO_PREVIEW_BODY;
      await notifyMessage(convId, title, body, msgNotifId(convId));

      const settings = await readNativeNotifySettings();
      if (settings.bubble && (await overlayGranted())) {
        await showBubble(convId, title, body);
      }
    } catch (e) {
      logError('native.backgroundNotify', e);
    }
  };

  const onChange = () => {
    const s = useAppStore.getState();
    const appVisible = document.visibilityState === 'visible';
    // Ring resolved in-app (answered / declined / rung out) → the shade must
    // agree immediately, not after the TTL.
    const nowRinging = s.incomingCall?.convId ?? null;
    if (ringingConv && ringingConv !== nowRinging) dropCallNotif(ringingConv);
    ringingConv = nowRinging;
    for (const [convId, msgs] of Object.entries(s.messages)) {
      const last = msgs.at(-1);
      if (!last) continue;
      const prev = seen.get(convId);
      if (prev === last.id) continue;
      seen.set(convId, last.id);
      if (prev === undefined) continue; // first sighting = hydration, not arrival
      const conv = s.conversationById(convId);
      if (!conv) continue;
      void (async () => {
        const settings = await readNativeNotifySettings();
        const surface = classifyIncoming({
          msg: last,
          convId,
          convType: conv.type,
          isHidden: conv.isHidden === true,
          appVisible,
          settings,
        });
        if (surface === 'none') return;
        // Trailing debounce per conversation; a call outranks a message if
        // both were classified within one burst.
        const existing = bursts.get(convId);
        if (existing) clearTimeout(existing.timer);
        const escalated = surface === 'call' || existing?.surface === 'call' ? 'call' : 'message';
        bursts.set(convId, {
          surface: escalated,
          timer: setTimeout(() => {
            bursts.delete(convId);
            void fire(convId, escalated);
          }, BURST_MS),
        });
      })();
    }
  };

  const unsub = useAppStore.subscribe(onChange);
  return () => {
    unsub();
    for (const b of bursts.values()) clearTimeout(b.timer);
    bursts.clear();
    for (const t of callTimers.values()) clearTimeout(t);
    callTimers.clear();
  };
}
