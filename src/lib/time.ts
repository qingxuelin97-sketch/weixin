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

/** Whether to show a time bar before a message (gap > 5 min from previous). */
export function shouldShowTimeBar(prevTs: number | null, ts: number): boolean {
  if (prevTs == null) return true;
  return ts - prevTs > 5 * 60_000;
}
