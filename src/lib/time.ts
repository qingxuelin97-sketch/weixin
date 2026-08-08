/**
 * WeChat-style relative timestamps for the conversation list and chat time bars.
 * `now` is injected (never Date.now inside) so screenshots and tests are stable.
 */

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

/** Conversation-list style: HH:mm today, 昨天, weekday within a week, else M/D. */
export function listTimestamp(ts: number, now: number): string {
  const d = new Date(ts);
  const n = new Date(now);
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (isSameDay(d, n)) return hm;
  const yesterday = new Date(n);
  yesterday.setDate(n.getDate() - 1);
  if (isSameDay(d, yesterday)) return '昨天';
  const diffDays = Math.floor((now - ts) / 86_400_000);
  if (diffDays < 7) return WEEKDAYS[d.getDay()];
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** Chat time-bar style: HH:mm today, 昨天 HH:mm, weekday+time within a week, else full. */
export function chatTimestamp(ts: number, now: number): string {
  const d = new Date(ts);
  const n = new Date(now);
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (isSameDay(d, n)) return hm;
  const yesterday = new Date(n);
  yesterday.setDate(n.getDate() - 1);
  if (isSameDay(d, yesterday)) return `昨天 ${hm}`;
  const diffDays = Math.floor((now - ts) / 86_400_000);
  if (diffDays < 7) return `${WEEKDAYS[d.getDay()]} ${hm}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`;
}

/**
 * Moments style: elapsed-time phrasing rather than a clock ("刚刚", "5分钟前",
 * "2小时前", "昨天", "3天前"), falling back to a date past a week. The feed is
 * browsed as a stream of recent events, so "how long ago" reads better than
 * "at what time" — which is why this differs from the two formats above.
 */
export function momentTimestamp(ts: number, now: number): string {
  const diff = now - ts;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分钟前`;

  const d = new Date(ts);
  const n = new Date(now);
  if (isSameDay(d, n)) return `${Math.floor(diff / 3_600_000)}小时前`;

  const yesterday = new Date(n);
  yesterday.setDate(n.getDate() - 1);
  if (isSameDay(d, yesterday)) return '昨天';

  // Calendar-day difference, not elapsed/86400 — 23:00 Monday viewed at 01:00
  // Wednesday is "2天前", not "1天前".
  const midnight = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((midnight(n) - midnight(d)) / 86_400_000);
  if (days < 7) return `${days}天前`;
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** Whether to show a time bar before a message (gap > 5 min from previous). */
export function shouldShowTimeBar(prevTs: number | null, ts: number): boolean {
  if (prevTs == null) return true;
  return ts - prevTs > 5 * 60_000;
}
