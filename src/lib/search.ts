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
import type { ContactVM, ConversationVM, MessageVM, MomentVM } from '../data/types';

export type SearchKind = 'contact' | 'conversation' | 'message' | 'moment';

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
}

/** Per-kind base weight, so a matching name outranks a matching message body. */
const KIND_WEIGHT: Record<SearchKind, number> = {
  contact: 1000,
  conversation: 900,
  message: 100,
  moment: 80,
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
      if (m.isRecalled || !m.content) continue;
      const r = findRanges(m.content, query);
      if (r.length === 0) continue;
      const ex = excerpt(m.content, r);
      msgHits.push({
        kind: 'message',
        id: String(m.id),
        title: convTitle.get(convId) ?? convId,
        subtitle: ex.text,
        ranges: ex.ranges,
        score: scoreOf('message', m.content, r, recencyScore(m.createdAt, newest)),
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

  const byScore = (a: SearchHit, b: SearchHit) => b.score - a.score || (b.createdAt ?? 0) - (a.createdAt ?? 0);
  for (const group of [contactHits, convHits, msgHits, momentHits]) {
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
  ];
  return LABELS.map(([kind, label]) => ({
    kind,
    label,
    hits: hits.filter((h) => h.kind === kind),
  })).filter((g) => g.hits.length > 0);
}
