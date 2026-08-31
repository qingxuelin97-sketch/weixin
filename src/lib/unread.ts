/**
 * The one rule for "how many unread does the app admit to" (M-I18).
 *
 * Two exclusions, for two different reasons:
 *
 *  - MUTED (免打扰): WeChat still shows the row's own count, but a muted thread
 *    never contributes to the red number on 微信. That is the whole point of the
 *    setting.
 *  - HIDDEN (AI↔AI 私信): those conversations must never surface on ANY
 *    user-visible surface. A badge counting them is a leak that is impossible to
 *    explain away — "微信 3" with only two readable unread threads is the user
 *    discovering there is a fourth conversation they cannot open.
 *
 * This lived inline in three components (TabScaffold, ChatPage, ChatListPage),
 * two of which spelled the rule out and one of which relied on having filtered
 * the list beforehand. Three copies of an invariant is three chances for the
 * next surface to drop the `isHidden` half — and nothing would go red, because
 * the leak only shows up with a hidden conversation that actually has unread.
 */
import type { ConversationVM } from '../data/types';

export function totalUnread(conversations: readonly ConversationVM[]): number {
  return conversations.reduce((n, c) => n + (c.isMuted || c.isHidden ? 0 : c.unreadCount), 0);
}
