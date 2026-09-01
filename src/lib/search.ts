/**
 * Local search over conversations, contacts, messages and Moments.
 *
 * Deliberately a linear scan, not an index. This is one person's chat history —
 * a few thousand messages — and IndexedDB has no text index, so building one
 * would mean a new object store, a DB_VERSION bump, and a write-path hook on
 * every message, all to speed up a scan that already finishes in a few
 * milliseconds. `src/ai/memory.ts` states the same stance for V1: keyword, not
 * vectors. Revisit only when the scan is measurably slow.
 *
 * Pure functions: no storage, no clock. The caller passes in what it already has
 * hydrated in the store.
 */
import type { ContactVM, ConversationVM, MessageVM, MomentVM, FavoriteVM } from '../data/types';
import type { WorldbookEntry } from '../ai/worldbook';

export type SearchKind =
  | 'contact'
  | 'conversation'
  | 'message'
  | 'moment'
  /** 世界书条目 (M-J10)。用户亲手写的设定，搜不到等于写完就丢。 */
  | 'worldbook'
  /** 收藏 (M-J10)。 */
  | 'favorite'
  /** 记忆事实 (M-J10)。 */
  | 'memory';

export interface SearchHit {
  kind: SearchKind;
  /** Route to open when tapped. */
  id: string;
  title: string;
  /** The line shown under the title — for messages, the matched text. */
  subtitle?: string;
  /** Character ranges in `title` (contacts/conversations) or `subtitle` (others). */
  ranges: Array<[number, number]>;
  score: number;
  /** Extra routing context: which conversation a message belongs to. */
  convId?: string;
  createdAt?: number;
}

/**
 * Find every occurrence of `needle` in `haystack`, case-insensitively.
 *
 * Returns ranges into the ORIGINAL string. Lowercasing can change string length
 * in some locales, so the search runs on a lowercased copy only to locate
 * indices — never to slice the text the user sees.
 */
export function findRanges(haystack: string, needle: string): Array<[number, number]> {
  if (!needle) return [];
  const h = haystack.toLowerCase();
  const n = needle.toLowerCase();
  // Guard: if lowercasing changed the length, indices would not line up, so fall
  // back to a case-sensitive pass rather than highlighting the wrong characters.
  const safe = h.length === haystack.length && n.length === needle.length;
  const src = safe ? h : haystack;
  const pat = safe ? n : needle;
  const out: Array<[number, number]> = [];
  let from = 0;
  while (out.length < 20) {
    const i = src.indexOf(pat, from);
    if (i < 0) break;
    out.push([i, i + pat.length]);
    from = i + pat.length;
  }
  return out;
}

/** Split a piece of text into highlighted / plain runs for rendering. */
export function highlightParts(
  text: string,
  ranges: Array<[number, number]>,
): Array<{ text: string; hit: boolean }> {
  if (ranges.length === 0) return [{ text, hit: false }];
  const parts: Array<{ text: string; hit: boolean }> = [];
  let cursor = 0;
  for (const [s, e] of ranges) {
    if (s > cursor) parts.push({ text: text.slice(cursor, s), hit: false });
    parts.push({ text: text.slice(s, e), hit: true });
    cursor = e;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), hit: false });
  return parts;
}

/**
 * Trim a long message down to a window around the first match, so the hit is
 * visible instead of scrolled off the end. Returns the excerpt and the ranges
 * rebased onto it.
 */
export function excerpt(
  text: string,
  ranges: Array<[number, number]>,
  radius = 18,
): { text: string; ranges: Array<[number, number]> } {
  if (ranges.length === 0 || text.length <= radius * 2) return { text, ranges };
  const [s] = ranges[0];
  const start = Math.max(0, s - radius);
  const end = Math.min(text.length, s + radius * 2);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  const shift = start - prefix.length;
  const rebased = ranges
    .filter(([a, b]) => a >= start && b <= end)
    .map(([a, b]) => [a - shift, b - shift] as [number, number]);
  return { text: prefix + text.slice(start, end) + suffix, ranges: rebased };
}

export interface SearchInput {
  contacts: ContactVM[];
  conversations: ConversationVM[];
  /** Keyed by conversation id, as the store holds them. */
  messages: Record<string, MessageVM[]>;
  moments: MomentVM[];
  /**
   * 搜索 v3 (M-J10)：这三类以前搜不到，加起来是全 App 一半的文字内容。
   * 可选，所以既有调用点（会话内搜索、测试）不必全部改写——但缺席就是
   * 「这次不搜它们」，不是「它们不存在」。
   */
  worldbook?: WorldbookEntry[];
  favorites?: FavoriteVM[];
  memories?: Array<{ id: string; subjectId: string; text: string; createdAt?: number }>;
}

/** Newest-first within equal relevance. Shared by the pure and deep passes. */
const byScore = (a: SearchHit, b: SearchHit) =>
  b.score - a.score || (b.createdAt ?? 0) - (a.createdAt ?? 0);

/** Per-kind base weight, so a matching name outranks a matching message body. */
const KIND_WEIGHT: Record<SearchKind, number> = {
  contact: 1000,
  conversation: 900,
  message: 100,
  moment: 80,
  // 用户亲手写的设定排在她说过的话之上：找世界书的人是在找**自己写的东西**，
  // 那件事他记得很清楚，容不得被一屏聊天记录压下去。
  worldbook: 700,
  favorite: 200,
  // 记忆是**推断**出来的，不是谁说过的原话——放在最低，出现即可，不该抢位置。
  memory: 60,
};

/** Cap per kind so one chatty conversation can't crowd out everything else. */
const PER_KIND_LIMIT = 30;

/**
 * Score a hit. A match at the start of the field beats one in the middle, and a
 * match covering more of a short field beats an incidental substring of a long
 * one — which is what makes searching "林" put 林小雨 above a message mentioning her.
 */
function scoreOf(kind: SearchKind, field: string, ranges: Array<[number, number]>, recency = 0): number {
  if (ranges.length === 0) return 0;
  const [start, end] = ranges[0];
  const coverage = (end - start) / Math.max(field.length, 1);
  const positionBonus = start === 0 ? 50 : Math.max(0, 20 - start);
  // Recency is a mild tiebreaker only — an old exact match still beats a fresh
  // partial one.
  return KIND_WEIGHT[kind] + coverage * 100 + positionBonus + Math.min(recency, 20);
}

/** Newer items get a small nudge; saturates so ancient history isn't buried. */
function recencyScore(ts: number | undefined, newest: number): number {
  if (!ts || !newest) return 0;
  const ageDays = (newest - ts) / 86_400_000;
  return Math.max(0, 20 - ageDays);
}

export function search(input: SearchInput, queryRaw: string): SearchHit[] {
  const query = queryRaw.trim();
  if (!query) return [];

  // Hidden conversations (AI↔AI DMs) are excluded HERE, not in the UI layer:
  // a caller that forgets to pre-filter must still be unable to leak a private
  // AI exchange into results — that tell would be irreversible.
  const hiddenIds = new Set(input.conversations.filter((c) => c.isHidden).map((c) => c.id));

  const hits: SearchHit[] = [];
  const newest = Math.max(
    0,
    ...input.conversations.map((c) => c.lastMsgAt ?? 0),
    ...input.moments.map((m) => m.createdAt),
  );

  // 记忆的标题要显示「这是谁的记忆」而不是一个 id。
  const nameOfContact = new Map(input.contacts.map((c) => [c.id, c.remark ?? c.name]));

  // --- Contacts: match display name, real name, and signature ---
  const contactHits: SearchHit[] = [];
  for (const c of input.contacts) {
    if (c.type === 'self') continue;
    const label = c.remark ?? c.name;
    // Search the remark AND the underlying name: a user who renamed someone
    // still thinks of them by either.
    const fields = [label, c.name, c.signature ?? ''].filter(Boolean);
    let best: { ranges: Array<[number, number]>; score: number } | null = null;
    for (const f of fields) {
      const r = findRanges(f, query);
      if (r.length === 0) continue;
      const s = scoreOf('contact', f, r);
      if (!best || s > best.score) best = { ranges: f === label ? r : findRanges(label, query), score: s };
    }
    if (best) {
      contactHits.push({
        kind: 'contact',
        id: c.id,
        title: label,
        subtitle: c.signature,
        ranges: best.ranges,
        score: best.score,
      });
    }
  }

  // --- Conversations: match the title ---
  const convHits: SearchHit[] = [];
  for (const c of input.conversations) {
    if (c.isHidden) continue;
    const r = findRanges(c.title, query);
    if (r.length === 0) continue;
    convHits.push({
      kind: 'conversation',
      id: c.id,
      title: c.title,
      subtitle: c.lastMsgPreview,
      ranges: r,
      score: scoreOf('conversation', c.title, r, recencyScore(c.lastMsgAt, newest)),
      convId: c.id,
      createdAt: c.lastMsgAt,
    });
  }

  // --- Messages: match text bodies ---
  const convTitle = new Map(input.conversations.map((c) => [c.id, c.title]));
  const msgHits: SearchHit[] = [];
  for (const [convId, list] of Object.entries(input.messages)) {
    if (hiddenIds.has(convId)) continue;
    for (const m of list) {
      // A recalled message shows no text in the UI; finding it by its original
      // content would leak what was withdrawn.
      if (m.isRecalled) continue;
      // 语音转写与文件名 (M-J10)：两者在气泡上都是**看得见的字**，用户当然会
      // 拿它们去搜。语音的 content 就是转写，所以它一直是可搜的；文件名住在
      // meta 里，此前完全搜不到——发过来的「合同.pdf」在搜索里不存在。
      const fileName = typeof m.meta?.fileName === 'string' ? m.meta.fileName : '';
      const body = m.content || fileName;
      if (!body) continue;
      const r = findRanges(body, query);
      if (r.length === 0) continue;
      const ex = excerpt(body, r);
      msgHits.push({
        kind: 'message',
        id: String(m.id),
        title: convTitle.get(convId) ?? convId,
        subtitle: ex.text,
        ranges: ex.ranges,
        score: scoreOf('message', body, r, recencyScore(m.createdAt, newest)),
        convId,
        createdAt: m.createdAt,
      });
    }
  }

  // --- Moments ---
  const momentHits: SearchHit[] = [];
  for (const m of input.moments) {
    if (!m.text) continue;
    const r = findRanges(m.text, query);
    if (r.length === 0) continue;
    const ex = excerpt(m.text, r);
    momentHits.push({
      kind: 'moment',
      id: m.id,
      title: '朋友圈',
      subtitle: ex.text,
      ranges: ex.ranges,
      score: scoreOf('moment', m.text, r, recencyScore(m.createdAt, newest)),
      createdAt: m.createdAt,
    });
  }

  // --- 世界书 / 收藏 / 记忆 (M-J10) ---
  const wbHits: SearchHit[] = [];
  for (const w of input.worldbook ?? []) {
    // 关键词与正文都搜：用户经常只记得自己设的那个触发词。
    const fields = [w.content, w.keywords.join(' ')].filter(Boolean);
    let best: { field: string; ranges: Array<[number, number]> } | null = null;
    for (const f of fields) {
      const r = findRanges(f, query);
      if (r.length > 0 && !best) best = { field: f, ranges: r };
    }
    if (!best) continue;
    const ex = excerpt(best.field, best.ranges);
    wbHits.push({
      kind: 'worldbook',
      id: w.id,
      title: w.keywords[0] ?? '世界书',
      subtitle: ex.text,
      ranges: ex.ranges,
      score: scoreOf('worldbook', best.field, best.ranges),
    });
  }

  const favHits: SearchHit[] = [];
  for (const f of input.favorites ?? []) {
    // 收藏来自某个会话；隐藏会话的收藏本来就进不了 repo.getFavorites()，
    // 但这里再挡一次——两道过滤的成本是一个 Set 查询。
    if (f.convId && hiddenIds.has(f.convId)) continue;
    const body = f.content ?? '';
    if (!body) continue;
    const r = findRanges(body, query);
    if (r.length === 0) continue;
    const ex = excerpt(body, r);
    favHits.push({
      kind: 'favorite',
      id: f.id,
      title: '收藏',
      subtitle: ex.text,
      ranges: ex.ranges,
      score: scoreOf('favorite', body, r, recencyScore(f.createdAt, newest)),
      createdAt: f.createdAt,
    });
  }

  const memHits: SearchHit[] = [];
  for (const f of input.memories ?? []) {
    const r = findRanges(f.text, query);
    if (r.length === 0) continue;
    const ex = excerpt(f.text, r);
    memHits.push({
      kind: 'memory',
      id: f.id,
      title: nameOfContact.get(f.subjectId) ?? '记忆',
      subtitle: ex.text,
      ranges: ex.ranges,
      score: scoreOf('memory', f.text, r, recencyScore(f.createdAt ?? 0, newest)),
      createdAt: f.createdAt,
    });
  }

  for (const group of [contactHits, convHits, msgHits, momentHits, wbHits, favHits, memHits]) {
    hits.push(...group.sort(byScore).slice(0, PER_KIND_LIMIT));
  }
  return hits.sort(byScore);
}

/** Group results for the sectioned UI, preserving score order within each kind. */
export function groupByKind(hits: SearchHit[]): Array<{ kind: SearchKind; label: string; hits: SearchHit[] }> {
  const LABELS: Array<[SearchKind, string]> = [
    ['contact', '联系人'],
    ['conversation', '聊天'],
    ['message', '聊天记录'],
    ['moment', '朋友圈'],
    ['worldbook', '世界书'],
    ['favorite', '收藏'],
    ['memory', '记忆'],
  ];
  return LABELS.map(([kind, label]) => ({
    kind,
    label,
    hits: hits.filter((h) => h.kind === kind),
  })).filter((g) => g.hits.length > 0);
}

/* ==================================================================== */
/* Whole-database search (M-G2)                                          */
/* ==================================================================== */

/** How far back per conversation. A ceiling, not a page size. */
export const DEEP_SCAN_LIMIT = 3000;
/** Rows per cursor page while scanning. */
const SCAN_PAGE = 400;

export interface DeepSearchDeps {
  /**
   * One page of a conversation's messages, newest first, strictly older than
   * `beforeId`. Injected rather than imported so this module stays pure and
   * unit-testable — the repo-backed implementation lives at the call site.
   */
  page: (convId: string, beforeId: number | undefined, limit: number) => Promise<MessageVM[]>;
}

export interface DeepSearchResult {
  hits: SearchHit[];
  /** True when some conversation hit `DEEP_SCAN_LIMIT` before running out. */
  truncated: boolean;
}

/**
 * Search everything, including history the store never loaded.
 *
 * `search()` above matches only `input.messages` — what hydration happened to
 * put in memory, which was a flat 200 per conversation. So the app could not
 * find a message it was perfectly capable of storing: "搜不到" and "翻不到"
 * were the same bug seen from two directions, and M-G2 fixes both ends.
 *
 * The hidden-conversation rule is enforced HERE, exactly as in `search()`: a
 * hidden thread is never even scanned. Keeping that check inside this module
 * (rather than asking callers to pre-filter) is what makes leaking an AI↔AI
 * exchange impossible rather than merely unlikely — that tell cannot be taken
 * back once seen.
 */
export async function searchAll(
  input: SearchInput,
  queryRaw: string,
  deps: DeepSearchDeps,
): Promise<DeepSearchResult> {
  const query = queryRaw.trim();
  if (!query) return { hits: [], truncated: false };

  // Everything except messages comes from the pure pass — contacts, titles and
  // Moments are fully in memory already.
  const shallow = search({ ...input, messages: {} }, query);

  const hidden = new Set(input.conversations.filter((c) => c.isHidden).map((c) => c.id));
  const scanned: Record<string, MessageVM[]> = {};
  let truncated = false;

  for (const conv of input.conversations) {
    if (hidden.has(conv.id)) continue;
    const rows: MessageVM[] = [];
    let cursor: number | undefined;
    for (;;) {
      const page = await deps.page(conv.id, cursor, SCAN_PAGE);
      if (page.length === 0) break;
      rows.push(...page);
      cursor = page.reduce((min, m) => Math.min(min, m.id), Number.MAX_SAFE_INTEGER);
      if (page.length < SCAN_PAGE) break;
      if (rows.length >= DEEP_SCAN_LIMIT) {
        truncated = true;
        break;
      }
    }
    if (rows.length) scanned[conv.id] = rows;
  }

  // Re-run the pure matcher over the scanned bodies so message scoring,
  // excerpting and the recall rule stay in exactly one place.
  const deep = search({ ...input, messages: scanned }, query).filter((h) => h.kind === 'message');

  return { hits: [...shallow, ...deep].sort(byScore), truncated };
}

/* ==================================================================== */
/* Conversation-scoped search (M-I6)                                     */
/* ==================================================================== */

/**
 * Search inside ONE conversation — the ChatInfoPage「查找聊天记录」entry.
 *
 * Reuses `search()` on a scoped input rather than re-implementing matching, so
 * scoring, excerpting and the recall rule stay in exactly one place. The hidden
 * guard is re-stated here even though `search()` also enforces it: this
 * function takes a convId directly, so it must refuse a hidden id on its own —
 * a caller cannot be trusted to have checked, and the leak is irreversible.
 */
export function searchConversation(input: SearchInput, convId: string, query: string): SearchHit[] {
  const conv = input.conversations.find((c) => c.id === convId);
  if (!conv || conv.isHidden) return [];
  const scoped: SearchInput = {
    contacts: [],
    conversations: [conv],
    messages: { [convId]: input.messages[convId] ?? [] },
    moments: [],
  };
  return search(scoped, query).filter((h) => h.kind === 'message');
}

/**
 * Conversation-scoped deep pass: scans this one thread's full history through
 * the same paging dependency `searchAll` uses, and nothing else — the other
 * conversations are never even read.
 */
export async function searchConversationAll(
  input: SearchInput,
  convId: string,
  query: string,
  deps: DeepSearchDeps,
): Promise<DeepSearchResult> {
  const conv = input.conversations.find((c) => c.id === convId);
  if (!conv || conv.isHidden) return { hits: [], truncated: false };
  const scoped: SearchInput = {
    contacts: [],
    conversations: [conv],
    messages: {},
    moments: [],
  };
  const r = await searchAll(scoped, query, deps);
  return { hits: r.hits.filter((h) => h.kind === 'message'), truncated: r.truncated };
}
