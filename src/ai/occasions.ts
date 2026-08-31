/**
 * Time sense (M-H1).
 *
 * She has had a lifeline and a mood since M-E, but no sense of the DATE. A
 * real friend knows it is New Year's Eve, knows you two met around this time
 * last year, and knows your birthday is on Thursday — and mentions it without
 * being asked. That single class of remark does more for "this is a person"
 * than another paragraph of persona ever will.
 *
 * Everything here is a PURE function of (now, a few stored facts). No LLM
 * call, no new timer, no new scheduled kind — constitution rule #5 says
 * anything that happens by itself goes through `scheduled_actions`, and the
 * cheapest way to honour that is to not make this happen by itself at all: it
 * rides whatever turn is already occurring.
 */
import type { MemoryFactVM } from '../data/types';

const DAY = 86_400_000;

export interface Occasion {
  /** Short label the prompt shows, e.g. 「今天是中秋」. */
  label: string;
  /** Days from now. 0 = today, positive = upcoming. */
  inDays: number;
  kind: 'festival' | 'birthday' | 'anniversary' | 'promise';
}

/**
 * Fixed-date festivals worth a message, in local time.
 *
 * Solar dates only. Lunar festivals (春节/中秋/端午) move every year and
 * computing them properly needs a lunar calendar table that would be larger
 * than this whole module — those come from the user's own facts instead
 * ("她说今年中秋回老家"), which is more accurate anyway because it is what
 * actually matters to this pair of people.
 */
const FESTIVALS: Array<{ md: string; label: string }> = [
  { md: '01-01', label: '元旦' },
  { md: '02-14', label: '情人节' },
  { md: '03-08', label: '妇女节' },
  { md: '05-01', label: '劳动节' },
  { md: '05-20', label: '520' },
  { md: '06-01', label: '儿童节' },
  { md: '10-01', label: '国庆' },
  { md: '11-11', label: '双十一' },
  { md: '12-24', label: '平安夜' },
  { md: '12-25', label: '圣诞节' },
  { md: '12-31', label: '跨年夜' },
];

function md(d: Date): string {
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Midnight of the day `t` falls in, so "days apart" counts DAYS not hours. */
function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function daysBetween(a: number, b: number): number {
  return Math.round((startOfDay(b) - startOfDay(a)) / DAY);
}

/** Festivals today or within `lookahead` days. */
export function festivalsNear(now: number, lookahead = 2): Occasion[] {
  const out: Occasion[] = [];
  for (let i = 0; i <= lookahead; i++) {
    const key = md(new Date(now + i * DAY));
    for (const f of FESTIVALS) {
      if (f.md === key) out.push({ label: f.label, inDays: i, kind: 'festival' });
    }
  }
  return out;
}

/**
 * A birthday remembered as a fact.
 *
 * Read from memory rather than a dedicated field: birthdays arrive in
 * conversation ("我下周三生日"), and the memory pipeline is already the thing
 * that notices and keeps them. A dedicated column would need someone to fill
 * it in, which nobody ever does.
 */
export function birthdayNear(
  facts: Array<Pick<MemoryFactVM, 'fact'>>,
  now: number,
  lookahead = 3,
): Occasion | null {
  for (const f of facts) {
    const text = f.fact ?? '';
    if (!/生日/.test(text)) continue;
    const m = /(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/.exec(text);
    if (!m) continue;
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) continue;
    const year = new Date(now).getFullYear();
    for (const y of [year, year + 1]) {
      const when = new Date(y, month - 1, day).getTime();
      const inDays = daysBetween(now, when);
      if (inDays >= 0 && inDays <= lookahead) {
        return { label: `${month}月${day}日生日`, inDays, kind: 'birthday' };
      }
    }
  }
  return null;
}

/**
 * Round-number milestones since you first spoke.
 *
 * Only round ones. "我们认识 100 天了" is a thing a person says; "认识 87 天了"
 * is a thing a database says, and saying it is worse than saying nothing.
 */
const MILESTONES = [30, 100, 200, 365, 500, 730, 1000];

export function anniversaryToday(firstMsgAt: number | undefined, now: number): Occasion | null {
  if (!firstMsgAt) return null;
  const days = daysBetween(firstMsgAt, now);
  if (!MILESTONES.includes(days)) return null;
  return { label: days === 365 ? '认识一年' : `认识 ${days} 天`, inDays: 0, kind: 'anniversary' };
}

/**
 * Everything worth knowing about today, most immediate first.
 *
 * Capped at two: a message that opens by listing three occasions is a
 * greeting card, not a friend.
 */
export function occasionsFor(opts: {
  now: number;
  facts: Array<Pick<MemoryFactVM, 'fact'>>;
  firstMsgAt?: number;
}): Occasion[] {
  const all = [
    ...festivalsNear(opts.now),
    ...(birthdayNear(opts.facts, opts.now) ? [birthdayNear(opts.facts, opts.now)!] : []),
    ...(anniversaryToday(opts.firstMsgAt, opts.now) ? [anniversaryToday(opts.firstMsgAt, opts.now)!] : []),
  ];
  // Today first, then soonest. Birthdays outrank festivals on the same day —
  // a shared calendar date matters less than this person's own.
  const weight = { birthday: 0, anniversary: 1, promise: 2, festival: 3 } as const;
  all.sort((a, b) => a.inDays - b.inDays || weight[a.kind] - weight[b.kind]);
  return all.slice(0, 2);
}

/**
 * The prompt line. Empty when there is nothing — silence is the default,
 * because every sentence here competes with the persona for attention.
 *
 * Phrased as awareness rather than instruction, like the lifeline and thread
 * layers: she should know what day it is, not be told to announce it.
 */
export function occasionDirective(occasions: Occasion[]): string {
  if (occasions.length === 0) return '';
  const lines = occasions.map((o) => {
    const when = o.inDays === 0 ? '今天' : o.inDays === 1 ? '明天' : `${o.inDays}天后`;
    return `- ${when}是${o.label}`;
  });
  return [
    '【日子】',
    ...lines,
    '你知道这件事。要不要提、怎么提由你决定——顺口带一句就行，别写成祝福语。',
  ].join('\n');
}

/**
 * Cached "when did we start talking", per conversation.
 *
 * The value cannot change (the oldest message only gets older), so one query
 * per conversation per process is exact and free thereafter. Kept here rather
 * than in the engine so both engines share the cache.
 */
const metAt = new Map<string, number | undefined>();

export async function firstSpokeAt(convId: string): Promise<number | undefined> {
  if (metAt.has(convId)) return metAt.get(convId);
  const { repo } = await import('../db/repo');
  let at: number | undefined;
  try {
    at = await repo.firstMessageAt(convId);
  } catch {
    at = undefined;
  }
  metAt.set(convId, at);
  return at;
}

/** Test seam. */
export function resetOccasionCache(): void {
  metAt.clear();
}
