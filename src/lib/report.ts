/**
 * Chat annual-report statistics (M-I14; specs/year-report.md).
 *
 * Pure local computation: no LLM, no network, no wall clock — `now` is injected
 * by the page. Money stays integer fen end to end (constitution rule #3); the
 * page formats it for display and nowhere else.
 *
 * THE rule of this module: **hidden conversations contribute zero**. The filter
 * lives INSIDE `computeReport`, exactly like `search()` keeps its own filter —
 * a page that forgets to pre-filter still cannot leak an AI↔AI DM into a
 * shareable report screenshot. Leaking one is an irreversible tell, so this is
 * enforced by a deliberately-red test (tests/unit/report.test.ts).
 */
import type { ContactVM, ConversationVM, MessageVM, WalletTxVM } from '../data/types';

const MINUTE = 60_000;
const DAY = 86_400_000;

/** Two messages within this gap belong to the same连聊 session. */
export const SESSION_GAP_MS = 5 * MINUTE;

/* ==================================================================== */
/* Shapes                                                                */
/* ==================================================================== */

export interface ReportInput {
  conversations: ConversationVM[];
  /** Keyed by convId. Hidden conversations may be present — they are ignored. */
  messagesByConv: Record<string, MessageVM[]>;
  contacts: ContactVM[];
  walletTxs: WalletTxVM[];
  /** Injected clock (rule #4: the library never reads the wall clock). */
  now: number;
}

export interface TalkerStat {
  contactId: string;
  name: string;
  count: number;
}

export interface SessionStat {
  convId: string;
  convTitle: string;
  count: number;
  durationMs: number;
  startAt: number;
}

export interface WordStat {
  word: string;
  count: number;
}

export interface MoneyStat {
  /** All integer fen — display formatting is the page's job. */
  sentFen: number;
  receivedFen: number;
  sentCount: number;
  receivedCount: number;
}

export interface YearReport {
  /** The calendar year the report covers (derived from `now`). */
  year: number;
  totalMessages: number;
  selfMessages: number;
  /** Distinct local days with at least one message. */
  activeDays: number;
  /** Days between the first message and `now` (>= 1 when any message exists). */
  spanDays: number;
  topTalkers: TalkerStat[];
  /** 24 buckets of the user's own message count by local hour. */
  hourHistogram: number[];
  /** Local hour (0-23) the user sends most, or null with no self messages. */
  peakHour: number | null;
  money: MoneyStat;
  longestSession: SessionStat | null;
  topWords: WordStat[];
  /** The latest-at-night self message (01:00–05:59), if any. */
  latestNight: { at: number; convTitle: string } | null;
  /** The single local day with the most messages. */
  busiestDay: { dayStart: number; count: number } | null;
}

/* ==================================================================== */
/* Main                                                                  */
/* ==================================================================== */

export function computeReport(input: ReportInput): YearReport {
  // THE filter. Everything below sees only visible conversations — a hidden
  // AI↔AI thread contributes zero to every number on the report.
  const visible = input.conversations.filter((c) => !c.isHidden);
  const visibleIds = new Set(visible.map((c) => c.id));
  const titleOf = new Map(visible.map((c) => [c.id, c.title]));

  const all: MessageVM[] = [];
  for (const conv of visible) {
    for (const m of input.messagesByConv[conv.id] ?? []) {
      // Belt and braces: a message row claiming a hidden convId is dropped
      // even if it was handed over under a visible key.
      if (visibleIds.has(m.convId) && m.convId === conv.id) all.push(m);
    }
  }
  all.sort((a, b) => a.createdAt - b.createdAt);

  const selfMsgs = all.filter((m) => m.senderId === 'self');

  return {
    year: new Date(input.now).getFullYear(),
    totalMessages: all.length,
    selfMessages: selfMsgs.length,
    activeDays: countActiveDays(all),
    spanDays: all.length ? Math.max(1, Math.ceil((input.now - all[0].createdAt) / DAY)) : 0,
    topTalkers: topTalkers(all, input.contacts),
    hourHistogram: hourHistogram(selfMsgs),
    peakHour: peakHour(selfMsgs),
    money: moneyStat(input.walletTxs),
    longestSession: longestSession(visible, input.messagesByConv),
    topWords: topWords(selfMsgs),
    latestNight: latestNight(selfMsgs, titleOf),
    busiestDay: busiestDay(all),
  };
}

/* ==================================================================== */
/* Pieces                                                                */
/* ==================================================================== */

function dayKey(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function countActiveDays(msgs: MessageVM[]): number {
  const days = new Set<number>();
  for (const m of msgs) days.add(dayKey(m.createdAt));
  return days.size;
}

/** Message counts per AI sender, top 5, names resolved from the roster. */
function topTalkers(msgs: MessageVM[], contacts: ContactVM[]): TalkerStat[] {
  const counts = new Map<string, number>();
  for (const m of msgs) {
    if (m.senderId === 'self' || m.type === 'system') continue;
    counts.set(m.senderId, (counts.get(m.senderId) ?? 0) + 1);
  }
  const nameOf = (id: string) => {
    const c = contacts.find((x) => x.id === id);
    return c?.remark ?? c?.name ?? id;
  };
  return [...counts.entries()]
    .map(([contactId, count]) => ({ contactId, name: nameOf(contactId), count }))
    .sort((a, b) => b.count - a.count || a.contactId.localeCompare(b.contactId))
    .slice(0, 5);
}

function hourHistogram(selfMsgs: MessageVM[]): number[] {
  const buckets = new Array<number>(24).fill(0);
  for (const m of selfMsgs) buckets[new Date(m.createdAt).getHours()]++;
  return buckets;
}

function peakHour(selfMsgs: MessageVM[]): number | null {
  if (selfMsgs.length === 0) return null;
  const buckets = hourHistogram(selfMsgs);
  let best = 0;
  for (let h = 1; h < 24; h++) if (buckets[h] > buckets[best]) best = h;
  return best;
}

/**
 * Red-packet/transfer totals from the user's own wallet ledger. The ledger is
 * self-scoped (it records what the USER paid and received), so there is no
 * hidden-conversation dimension here — and amounts are already integer fen.
 */
function moneyStat(txs: WalletTxVM[]): MoneyStat {
  let sentFen = 0;
  let receivedFen = 0;
  let sentCount = 0;
  let receivedCount = 0;
  for (const t of txs) {
    if (t.kind === 'rp_out' || t.kind === 'transfer_out') {
      sentFen += Math.abs(t.amountFen);
      sentCount++;
    } else if (t.kind === 'rp_in' || t.kind === 'transfer_in') {
      receivedFen += Math.abs(t.amountFen);
      receivedCount++;
    }
  }
  return { sentFen, receivedFen, sentCount, receivedCount };
}

/**
 * The longest连聊: within one conversation, a run of messages where each gap is
 * ≤ SESSION_GAP_MS. Ranked by message count (a 3-hour silence-punctuated haul
 * is not "连聊"), ties by duration.
 */
function longestSession(
  visible: ConversationVM[],
  messagesByConv: Record<string, MessageVM[]>,
): SessionStat | null {
  let best: SessionStat | null = null;
  for (const conv of visible) {
    const msgs = [...(messagesByConv[conv.id] ?? [])]
      .filter((m) => m.type !== 'system')
      .sort((a, b) => a.createdAt - b.createdAt);
    let runStart = 0;
    for (let i = 1; i <= msgs.length; i++) {
      const broken = i === msgs.length || msgs[i].createdAt - msgs[i - 1].createdAt > SESSION_GAP_MS;
      if (!broken) continue;
      const count = i - runStart;
      const durationMs = msgs[i - 1].createdAt - msgs[runStart].createdAt;
      if (
        count >= 2 &&
        (best == null || count > best.count || (count === best.count && durationMs > best.durationMs))
      ) {
        best = {
          convId: conv.id,
          convTitle: conv.title,
          count,
          durationMs,
          startAt: msgs[runStart].createdAt,
        };
      }
      runStart = i;
    }
  }
  return best;
}

/* ---- word frequency ---- */

/**
 * Function-word bigrams that dominate any Chinese chat log and say nothing
 * about the person. Kept short on purpose — over-filtering hides the fun ones.
 */
const STOP_WORDS = new Set([
  '就是',
  '然后',
  '那个',
  '这个',
  '什么',
  '怎么',
  '现在',
  '时候',
  '可以',
  '不是',
  '没有',
  '但是',
  '所以',
  '因为',
  '如果',
  '还是',
  '觉得',
  '知道',
  '真的',
  '已经',
  '应该',
  '我们',
  '你们',
  '他们',
  '一个',
  '有点',
  '不过',
  '今天',
  '明天',
  '这么',
  '那么',
  '还有',
  '是不是',
]);

/** Single characters that make a bigram noise rather than a word. */
const NOISE_CHARS = /[的了吗呢啊呀哈嗯哦噢诶吧嘛咯喔]/;

/**
 * Top words from the user's own text messages. Deliberately simple: CJK runs
 * are mined for bigrams (the dominant Chinese word length), ASCII words are
 * taken whole. No segmenter — the goal is "常用词" flavor, not linguistics.
 */
function topWords(selfMsgs: MessageVM[], topN = 10): WordStat[] {
  const counts = new Map<string, number>();
  const bump = (w: string) => counts.set(w, (counts.get(w) ?? 0) + 1);

  for (const m of selfMsgs) {
    if (m.type !== 'text' || !m.content || m.isRecalled) continue;
    const text = m.content.replace(/https?:\/\/\S+/g, ' ');
    // CJK runs → bigrams.
    for (const run of text.match(/[一-鿿]+/g) ?? []) {
      for (let i = 0; i + 1 < run.length; i++) {
        const bi = run.slice(i, i + 2);
        if (NOISE_CHARS.test(bi) || STOP_WORDS.has(bi)) continue;
        bump(bi);
      }
    }
    // ASCII words (lowercased), length 2-12.
    for (const w of text.match(/[A-Za-z][A-Za-z0-9']{1,11}/g) ?? []) {
      bump(w.toLowerCase());
    }
  }

  return [...counts.entries()]
    .filter(([, c]) => c >= 2)
    .map(([word, count]) => ({ word, count }))
    .sort((a, b) => b.count - a.count || a.word.localeCompare(b.word))
    .slice(0, topN);
}

function latestNight(
  selfMsgs: MessageVM[],
  titleOf: Map<string, string>,
): { at: number; convTitle: string } | null {
  let best: MessageVM | null = null;
  let bestScore = -1;
  for (const m of selfMsgs) {
    const d = new Date(m.createdAt);
    const h = d.getHours();
    if (h < 1 || h >= 6) continue; // 深夜 = 01:00–05:59
    const score = h * 60 + d.getMinutes();
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  }
  return best ? { at: best.createdAt, convTitle: titleOf.get(best.convId) ?? '' } : null;
}

function busiestDay(msgs: MessageVM[]): { dayStart: number; count: number } | null {
  const days = new Map<number, number>();
  for (const m of msgs) {
    const k = dayKey(m.createdAt);
    days.set(k, (days.get(k) ?? 0) + 1);
  }
  let best: { dayStart: number; count: number } | null = null;
  for (const [dayStart, count] of days) {
    if (!best || count > best.count || (count === best.count && dayStart < best.dayStart)) {
      best = { dayStart, count };
    }
  }
  return best;
}
