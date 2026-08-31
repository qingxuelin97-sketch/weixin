/**
 * Home-screen widget data feed (M-I10).
 *
 * The widget shows exactly what the chat-list shows — total unread + the most
 * recent conversation's preview — pushed to the Kotlin side (SharedPreferences
 * + RemoteViews render) whenever the app's knowledge changes hands: at the end
 * of every foreground pass and on backgrounding. No polling, no timer: the
 * widget can never know more than the app does, so it updates when the app does.
 *
 * HIDDEN-CONVERSATION RULE (constitution 3.5): AI↔AI DM threads are filtered
 * HERE, in the data producer, not in the renderer — the Kotlin layer never
 * receives them, so no future refactor over there can leak one onto a launcher.
 */
import type { ContactVM, ConversationVM } from '../data/types';
import { updateWidget, isNative } from './bridge';
import { useAppStore } from '../store/appStore';
import { logError } from '../lib/errlog';
import { totalUnread } from '../lib/unread';

export interface WidgetSummary {
  unread: number;
  title: string;
  preview: string;
  convId: string;
}

const EMPTY: WidgetSummary = { unread: 0, title: '微信', preview: '暂无消息', convId: '' };

/** Pure: derive the widget payload from the conversation list. */
export function buildWidgetSummary(
  conversations: ConversationVM[],
  nameOf: (conv: ConversationVM) => string | undefined,
): WidgetSummary {
  const visible = conversations.filter((c) => !c.isHidden);
  if (visible.length === 0) return EMPTY;
  // `totalUnread` rather than a fourth hand-rolled sum (M-I18): this one had
  // the `isHidden` half and was missing the 免打扰 half, so a launcher widget
  // could read 「5」 while the in-app 微信 badge read 「2」 — the header comment
  // above promises they match. The preview below still spans muted threads,
  // because a muted conversation does appear in the chat list; only its count
  // is withheld.
  const unread = totalUnread(visible);
  let latest: ConversationVM | undefined;
  for (const c of visible) {
    if (c.lastMsgAt > 0 && (!latest || c.lastMsgAt > latest.lastMsgAt)) latest = c;
  }
  if (!latest) return { ...EMPTY, unread };
  return {
    unread,
    title: nameOf(latest) ?? '微信',
    preview: latest.lastMsgPreview || '暂无消息',
    convId: latest.id,
  };
}

/** Resolve a conversation's display name the way the chat list does. */
export function convDisplayName(
  conv: ConversationVM,
  contactById: (id: string) => ContactVM | undefined,
): string | undefined {
  if (conv.type === 'group') return conv.title;
  const peer = conv.peerId ? contactById(conv.peerId) : undefined;
  return peer ? (peer.remark ?? peer.name) : conv.title;
}

/** Push the current store state to the widget. No-op on web; never throws. */
export async function syncWidget(): Promise<void> {
  if (!isNative()) return;
  try {
    const s = useAppStore.getState();
    const summary = buildWidgetSummary(s.conversations, (c) => convDisplayName(c, s.contactById));
    await updateWidget(summary);
  } catch (e) {
    logError('native.widgetSync', e);
  }
}
