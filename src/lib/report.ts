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
import type {
  ContactVM,
  ConversationVM,
  MessageVM,
  MomentCommentVM,
  MomentLikeVM,
  MomentVM,
  WalletTxVM,
} from '../data/types';
import { diceResult, rpsCompare, rpsResult } from './game';

const MINUTE = 60_000;
const DAY = 86_400_000;

/** Two messages within this gap belong to the same连聊 session. */
export const SESSION_GAP_MS = 5 * MINUTE;

/* ==================================================================== */
/* Shapes                                                                */
/* ==================================================================== */

/**
 * The slice of a story save the report reads (M-J12). Structural on purpose:
 * story_saves bypasses the Repo (known debt) and lives in src/ai — importing
 * the full row type here would put a lib→ai edge where none belongs.
 */
export interface ReportStorySave {
  scriptId: string;
  /** The ending this run reached; absent = the run never finished. */
  endingId?: string;
  /** When the run ended. Year attribution key. */
  endedAt?: number;
}

export interface ReportInput {
  conversations: ConversationVM[];
  /** Keyed by convId. Hidden conversations may be present — they are ignored. */
  messagesByConv: Record<string, MessageVM[]>;
  contacts: ContactVM[];
  walletTxs: WalletTxVM[];
  /** Injected clock (rule #4: the library never reads the wall clock). */
  now: number;
  /**
   * Calendar year the report covers (M-J12). Absent = the year of `now`.
   * EVERY statistic is windowed to this year — a 2025 message must never
   * inflate the 2026 report (tests/unit/j12-report.test.ts holds this red).
   */
  year?: number;
  /* ---- M-J12 multi-dimension inputs; all optional, absent = zeros ---- */
  moments?: MomentVM[];
  momentLikes?: MomentLikeVM[];
  momentComments?: MomentCommentVM[];
  storySaves?: ReportStorySave[];
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

export interface MomentsStat {
  /** Posts the user published this year. */
  posts: number;
  /** Friend likes received on the user's posts, by like time. */
  likesReceived: number;
  /** Friend comments received on the user's posts, by comment time. */
  commentsReceived: number;
  /** Who commented on the user's posts the most (top 3). */
  topCommenters: TalkerStat[];
}

export interface CallsStat {
  /** Connected calls (a `durationMs` exists). */
  count: number;
  /** Total connected milliseconds. */
  totalMs: number;
  /** Rows without a duration: missed / declined / cancelled. */
  missed: number;
  longest: { ms: number; convTitle: string; at: number } | null;
}

export interface StoryStat {
  /** Runs that reached an ending this year (by `endedAt`). */
  runsCompleted: number;
  /** Distinct (script, ending) pairs those runs unlocked. */
  endingsSeen: number;
}

export interface GameStat {
  /** The user's own throws. */
  diceThrows: number;
  rpsThrows: number;
  /** Completed user-vs-AI rounds (both games pooled). */
  wins: number;
  losses: number;
  draws: number;
  /** 六点 count — the user's luckiest die. */
  sixes: number;
}

export interface YearReport {
  /** The calendar year the report covers (`input.year`, else the year of `now`). */
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
  /* ---- M-J12 dimensions ---- */
  momentsStat: MomentsStat;
  callsStat: CallsStat;
  storyStat: StoryStat;
  gameStat: GameStat;
}

/** The local-time window of one calendar year: [start, end). */
export function yearRange(year: number): { start: number; end: number } {
  return { start: new Date(year, 0, 1).getTime(), end: new Date(year + 1, 0, 1).getTime() };
}

/* ==================================================================== */
/* Main                                                                  */
/* ==================================================================== */

export function computeReport(input: ReportInput): YearReport {
  const year = input.year ?? new Date(input.now).getFullYear();
  const { start, end } = yearRange(year);
  const inYear = (ts: number) => ts >= start && ts < end;

  // THE filter. Everything below sees only visible conversations — a hidden
  // AI↔AI thread contributes zero to every number on the report. The year
  // window is applied in the SAME pass: a 2025 row must never reach a 2026
  // statistic, whatever key it was handed over under.
  const visible = input.conversations.filter((c) => !c.isHidden);
  const visibleIds = new Set(visible.map((c) => c.id));
  const titleOf = new Map(visible.map((c) => [c.id, c.title]));

  const byConv: Record<string, MessageVM[]> = {};
  const all: MessageVM[] = [];
  for (const conv of visible) {
    const rows: MessageVM[] = [];
    for (const m of input.messagesByConv[conv.id] ?? []) {
      // Belt and braces: a message row claiming a hidden convId is dropped
      // even if it was handed over under a visible key.
      if (visibleIds.has(m.convId) && m.convId === conv.id && inYear(m.createdAt)) rows.push(m);
    }
    rows.sort((a, b) => a.createdAt - b.createdAt);
    byConv[conv.id] = rows;
    all.push(...rows);
  }
  all.sort((a, b) => a.createdAt - b.createdAt);

  const selfMsgs = all.filter((m) => m.senderId === 'self');
  // A past year's span ends at the year's edge, not at today.
  const spanEnd = Math.min(input.now, end - 1);

  return {
    year,
    totalMessages: all.length,
    selfMessages: selfMsgs.length,
    activeDays: countActiveDays(all),
    spanDays: all.length ? Math.max(1, Math.ceil((spanEnd - all[0].createdAt) / DAY)) : 0,
    topTalkers: topTalkers(all, input.contacts),
    hourHistogram: hourHistogram(selfMsgs),
    peakHour: peakHour(selfMsgs),
    money: moneyStat(input.walletTxs.filter((t) => inYear(t.createdAt))),
    longestSession: longestSession(visible, byConv),
    topWords: topWords(selfMsgs),
    latestNight: latestNight(selfMsgs, titleOf),
    busiestDay: busiestDay(all),
    momentsStat: momentsStat(input, inYear),
    callsStat: callsStat(all, titleOf),
    storyStat: storyStat(input.storySaves ?? [], inYear),
    gameStat: gameStat(byConv),
  };
}

/**
 * Which calendar years hold ANY reportable data — the report page's year
 * switcher. Hidden conversations are excluded here with the same pass as
 * computeReport, so a year that only ever saw AI↔AI traffic does not surface
 * as a pickable tab (that alone would be a tell). Always contains the year of
 * `now`, newest first.
 */
export function yearsWithData(input: ReportInput): number[] {
  const years = new Set<number>([new Date(input.now).getFullYear()]);
  const visibleIds = new Set(input.conversations.filter((c) => !c.isHidden).map((c) => c.id));
  for (const [convId, rows] of Object.entries(input.messagesByConv)) {
    if (!visibleIds.has(convId)) continue;
    for (const m of rows) if (m.convId === convId) years.add(new Date(m.createdAt).getFullYear());
  }
  for (const t of input.walletTxs) years.add(new Date(t.createdAt).getFullYear());
  for (const m of input.moments ?? []) {
    if (m.authorId === 'self') years.add(new Date(m.createdAt).getFullYear());
  }
  for (const s of input.storySaves ?? []) {
    if (s.endingId && typeof s.endedAt === 'number') years.add(new Date(s.endedAt).getFullYear());
  }
  return [...years].sort((a, b) => b - a);
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

/* ---- M-J12 dimensions ---- */

/**
 * 朋友圈 stats. Post counts go by the post's own year; likes/comments received
 * go by the REACTION's year — a friend liking your 2025 post in 2026 is 2026
 * warmth. Reactions are attributed through the post's author, so a like on a
 * post that no longer exists (or that isn't the user's) counts nothing.
 */
function momentsStat(input: ReportInput, inYear: (ts: number) => boolean): MomentsStat {
  const moments = input.moments ?? [];
  const authorOf = new Map(moments.map((m) => [m.id, m.authorId]));
  const posts = moments.filter((m) => m.authorId === 'self' && inYear(m.createdAt)).length;

  let likesReceived = 0;
  for (const l of input.momentLikes ?? []) {
    if (l.contactId === 'self' || !inYear(l.createdAt)) continue;
    if (authorOf.get(l.momentId) === 'self') likesReceived++;
  }

  const commenterCounts = new Map<string, number>();
  let commentsReceived = 0;
  for (const c of input.momentComments ?? []) {
    if (c.authorId === 'self' || !inYear(c.createdAt)) continue;
    if (authorOf.get(c.momentId) !== 'self') continue;
    commentsReceived++;
    commenterCounts.set(c.authorId, (commenterCounts.get(c.authorId) ?? 0) + 1);
  }
  const nameOf = (id: string) => {
    const c = input.contacts.find((x) => x.id === id);
    return c?.remark ?? c?.name ?? id;
  };
  const topCommenters = [...commenterCounts.entries()]
    .map(([contactId, count]) => ({ contactId, name: nameOf(contactId), count }))
    .sort((a, b) => b.count - a.count || a.contactId.localeCompare(b.contactId))
    .slice(0, 3);

  return { posts, likesReceived, commentsReceived, topCommenters };
}

/** 通话 stats from type:'call' rows (meta.durationMs = connected; absent = missed). */
function callsStat(all: MessageVM[], titleOf: Map<string, string>): CallsStat {
  let count = 0;
  let totalMs = 0;
  let missed = 0;
  let longest: CallsStat['longest'] = null;
  for (const m of all) {
    if (m.type !== 'call' || m.isRecalled) continue;
    const dur = m.meta?.durationMs;
    if (typeof dur === 'number' && Number.isFinite(dur)) {
      count++;
      totalMs += Math.max(0, dur);
      if (!longest || dur > longest.ms) {
        longest = { ms: dur, convTitle: titleOf.get(m.convId) ?? '', at: m.createdAt };
      }
    } else {
      missed++;
    }
  }
  return { count, totalMs, missed, longest };
}

/** 剧情 stats: finished runs by `endedAt` year; endings distinct per script. */
function storyStat(saves: ReportStorySave[], inYear: (ts: number) => boolean): StoryStat {
  const done = saves.filter(
    (s) => s.endingId && typeof s.endedAt === 'number' && inYear(s.endedAt),
  );
  const endings = new Set(done.map((s) => `${s.scriptId}#${s.endingId}`));
  return { runsCompleted: done.length, endingsSeen: endings.size };
}

/**
 * 表情游戏战绩. A round is two consecutive throws in one conversation's
 * game-only subsequence — same game, different senders, exactly one of them
 * the user (the pairing rule src/ai/game-react.ts gloats by). AI-vs-AI rounds
 * in a group are their business, not the user's record.
 */
function gameStat(byConv: Record<string, MessageVM[]>): GameStat {
  const stat: GameStat = { diceThrows: 0, rpsThrows: 0, wins: 0, losses: 0, draws: 0, sixes: 0 };
  for (const rows of Object.values(byConv)) {
    const throws = rows.filter((m) => m.type === 'game' && !m.isRecalled);
    for (const t of throws) {
      if (t.senderId !== 'self') continue;
      if (t.meta?.game === 'rps') stat.rpsThrows++;
      else {
        stat.diceThrows++;
        if (diceResult(t.meta?.result) === 6) stat.sixes++;
      }
    }
    for (let i = 0; i + 1 < throws.length; i++) {
      const a = throws[i];
      const b = throws[i + 1];
      const sameGame = (a.meta?.game === 'rps') === (b.meta?.game === 'rps');
      const oneIsSelf = (a.senderId === 'self') !== (b.senderId === 'self');
      if (!sameGame || !oneIsSelf) continue;
      const mine = a.senderId === 'self' ? a : b;
      const theirs = a.senderId === 'self' ? b : a;
      let cmp: number;
      if (mine.meta?.game === 'rps') {
        cmp = rpsCompare(rpsResult(mine.meta?.result), rpsResult(theirs.meta?.result));
      } else {
        const diff = diceResult(mine.meta?.result) - diceResult(theirs.meta?.result);
        cmp = diff > 0 ? 1 : diff < 0 ? -1 : 0;
      }
      if (cmp > 0) stat.wins++;
      else if (cmp < 0) stat.losses++;
      else stat.draws++;
      i++; // both throws consumed — a throw plays in at most one round
    }
  }
  return stat;
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

/* ==================================================================== */
/* Whole-history scan (M-J12)                                            */
/* ==================================================================== */

/**
 * Per-conversation ceiling for the report's history pull. Deliberately loud
 * when hit: 20k rows is more than a year of heavy chatting, and a report that
 * silently dropped the tail would present a wrong number as a fact — the page
 * must show「统计截断」instead (never silent; tests hold the condition).
 */
export const REPORT_SCAN_CAP = 20_000;
/** Rows per cursor page while pulling. */
const REPORT_SCAN_PAGE = 500;

export interface ReportScanDeps {
  /**
   * One page of a conversation's messages, chronological, strictly older than
   * `beforeId`. Injected rather than imported (the search.ts precedent) so
   * this module stays pure and the pager is unit-fakeable.
   */
  page: (convId: string, beforeId: number | undefined, limit: number) => Promise<MessageVM[]>;
}

export interface MessageScan {
  messagesByConv: Record<string, MessageVM[]>;
  /**
   * convId → the OLDEST fetched row's createdAt, present only for
   * conversations that hit the cap. What the scan did NOT see is strictly
   * older than this timestamp — which is exactly what decides whether a given
   * year's statistics are complete.
   */
  cappedAt: Record<string, number>;
}

/**
 * Pull each conversation's history newest→oldest, up to `cap` rows per
 * conversation. The caller decides which convIds to scan (the page passes
 * visible ones only; computeReport re-filters regardless).
 */
export async function scanAllMessages(
  convIds: string[],
  deps: ReportScanDeps,
  cap = REPORT_SCAN_CAP,
): Promise<MessageScan> {
  const messagesByConv: Record<string, MessageVM[]> = {};
  const cappedAt: Record<string, number> = {};
  for (const convId of convIds) {
    const rows: MessageVM[] = [];
    let cursor: number | undefined;
    for (;;) {
      const page = await deps.page(convId, cursor, REPORT_SCAN_PAGE);
      if (page.length === 0) break;
      rows.push(...page);
      cursor = page.reduce((min, m) => Math.min(min, m.id), Number.MAX_SAFE_INTEGER);
      // A short page means the history ran out — the scan is COMPLETE, even
      // if the cap was crossed on this very page. Only an interrupted scan
      // records `cappedAt` (order matters: complete-but-large must not raise
      // the truncation banner).
      if (page.length < REPORT_SCAN_PAGE) break;
      if (rows.length >= cap) {
        cappedAt[convId] = rows.reduce((min, m) => Math.min(min, m.createdAt), Infinity);
        break;
      }
    }
    messagesByConv[convId] = rows;
  }
  return { messagesByConv, cappedAt };
}

/**
 * Is `year` incompletely counted? True when any capped conversation's oldest
 * FETCHED row still sits at-or-after the year's start — rows older than it
 * were never read and could belong to this year. A conversation scanned past
 * the year boundary is complete for this year even if it hit the cap further
 * back in time.
 */
export function scanTruncatedForYear(scan: MessageScan, year: number): boolean {
  const { start } = yearRange(year);
  return Object.values(scan.cappedAt).some((oldest) => oldest >= start);
}
