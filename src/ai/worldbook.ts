/**
 * 世界书 (M-I4) — user-authored lore that rides into the prompt when it is
 * relevant, and only then.
 *
 * A memory fact is something SHE learned from the conversation; a worldbook
 * entry is something the USER decreed about the world ("我们都在杭州",
 * "她的猫叫年糕", "群里说的『老地方』是学校后门的烧烤摊"). Facts are
 * extracted, scored and forgotten; entries are authored, matched and eternal
 * until edited. Keeping the two systems separate is what lets each keep its
 * own rules.
 *
 * INJECTION lives INSIDE the prompt's memory layer — the six-layer order of
 * `assembleSystemPrompt` is fixed by the constitution, and the memory layer
 * is where "things she knows" already belongs.
 *
 * MATCHING is two-tier, and the two tiers are load-bearing:
 *
 *   - **keywordless = constant.** Always on within its scope. This is the
 *     user's escape hatch — when matching is not doing what they want, an
 *     empty keyword list is a switch they can reach without reading any of
 *     this. It is never scored, never approximate, never surprising.
 *   - **keyworded = triggered.** Exact substring first, exactly as before; and
 *     since M-I18, an APPROXIMATE tier underneath it that reuses the memory
 *     retriever's own trigram/BM25 machinery (`entity-graph.ts`). Without it
 *     an entry keyed on 「年糕」 sat silent through an entire conversation
 *     about 你家猫 — the lore was authored, stored, scoped correctly, and
 *     simply never fired.
 *
 * Approximate hits always rank BELOW every exact and constant hit, are capped
 * at `WORLDBOOK_FUZZY_MAX` of their own, and pass through the same 5-entry /
 * 600-character budget — so the loosest thing here can add at most two lines
 * to a prompt, and only when nothing better wanted the room.
 */
import { repo } from '../db/repo';
import { trigrams, buildCorpus, bm25, encodeTerms } from './entity-graph';
import type { NsfwTier } from '../llm/router';

export interface WorldbookEntry {
  id: string;
  /** Short display name in the editor list. */
  title: string;
  /** Exact-substring triggers. EMPTY = constant: always active within scope. */
  keywords: string[];
  /** What gets injected, verbatim. */
  content: string;
  /** Who this is true for. */
  scope: 'global' | 'persona' | 'conv';
  /** contactId (persona) or convId (conv); unset for global. */
  scopeId?: string;
  /** 0-100; higher survives the cap first. */
  priority: number;
  enabled: boolean;
  /**
   * Entry contains adult material and may only ride tiers above 'off'.
   * The tier itself is always DERIVED by the caller (constitution rule #6).
   */
  nsfw?: boolean;
  createdAt: number;
}

/** Hard caps on what matching may inject per prompt. Unit-locked. */
export const WORLDBOOK_MAX_ENTRIES = 5;
export const WORLDBOOK_CHAR_BUDGET = 600;
/** Per-entry authoring caps (editor + write path both clamp). */
export const WORLDBOOK_LIMITS = { title: 20, content: 200, keywords: 8, keywordChars: 16 } as const;

export function clampEntry(e: WorldbookEntry): WorldbookEntry {
  return {
    ...e,
    title: e.title.trim().slice(0, WORLDBOOK_LIMITS.title),
    content: e.content.trim().slice(0, WORLDBOOK_LIMITS.content),
    keywords: e.keywords
      .map((k) => k.trim().slice(0, WORLDBOOK_LIMITS.keywordChars))
      .filter(Boolean)
      .slice(0, WORLDBOOK_LIMITS.keywords),
    priority: Math.min(100, Math.max(0, Math.round(e.priority))),
  };
}

/** Approximate matches admitted per prompt, on top of the exact ones. */
export const WORLDBOOK_FUZZY_MAX = 2;

/**
 * How much shared vocabulary counts as "she would have thought of this".
 *
 * One distinctive character clears it (猫 in a query about 你家猫 against an
 * entry that says 她的猫叫年糕); one shared function word does not, because
 * those score zero.
 */
export const WORLDBOOK_FUZZY_MIN = 0.5;

/**
 * Characters that appear in every other sentence in Chinese. They are dropped
 * from the unigram tier entirely — IDF alone cannot suppress them in a
 * worldbook of three entries, where every term is technically rare.
 */
const STOP_CHARS = new Set(
  '的了是我你他她它们在有和就不人都一个上也很到说要去这那么什吗呢啊吧被把给对还会能可以没'.split(
    '',
  ),
);

/** How distinctive a matched term is: multi-character > salient单字 > nothing. */
function termWeight(term: string): number {
  if (term.length > 1) return 1; // bigram / trigram / latin word
  if (/[一-鿿]/.test(term) && !STOP_CHARS.has(term)) return 0.5;
  return 0;
}

/**
 * Terms for worldbook matching: the memory retriever's trigrams (bigrams and
 * trigrams over CJK, whole words for Latin), PLUS CJK unigrams.
 *
 * The unigrams are the whole reason approximate matching works here and are
 * deliberately NOT pushed down into `trigrams()`: memory retrieval runs over
 * dozens of facts where single characters are noise, while a worldbook is a
 * handful of authored entries where 「猫」 is the entire connection between
 * what the user wrote and what was just said.
 */
function worldTerms(text: string): Map<string, number> {
  const tf = new Map<string, number>();
  const add = (t: string) => tf.set(t, (tf.get(t) ?? 0) + 1);
  for (const t of trigrams(text)) add(t);
  for (const ch of text) if (/[一-鿿]/.test(ch)) add(ch);
  return tf;
}

/** Everything about an entry a query could plausibly be talking about. */
function matchText(e: WorldbookEntry): string {
  return [...e.keywords, e.title, e.content].join(' ');
}

/**
 * Pure matching: which entries fire for this query, in this scope, at this
 * tier — bounded by count and characters. Deterministic (stable sort).
 */
export function matchWorldbook(
  entries: WorldbookEntry[],
  opts: { query: string; contactId?: string; convId?: string; tier?: NsfwTier },
): string[] {
  const q = opts.query ?? '';
  const tier = opts.tier ?? 'off';
  const scored: Array<{ score: number; content: string; createdAt: number }> = [];
  /** Keyworded entries whose triggers did NOT fire — the approximate tier. */
  const missed: WorldbookEntry[] = [];
  for (const e of entries) {
    if (!e.enabled || !e.content.trim()) continue;
    // Full-open-tier content must never ride a surface at 'off' — the same
    // direction of caution the memory whitelist applies.
    if (e.nsfw && tier === 'off') continue;
    if (e.scope === 'persona' && e.scopeId !== opts.contactId) continue;
    if (e.scope === 'conv' && e.scopeId !== opts.convId) continue;
    const hits = e.keywords.filter((k) => k && q.includes(k)).length;
    if (e.keywords.length > 0 && hits === 0) {
      missed.push(e); // a trigger that did not fire — try approximate below
      continue;
    }
    scored.push({ score: e.priority + hits * 10, content: e.content.trim(), createdAt: e.createdAt });
  }
  scored.sort((a, b) => b.score - a.score || a.createdAt - b.createdAt);
  scored.push(...approximate(missed, q));

  const out: string[] = [];
  let chars = 0;
  for (const s of scored) {
    if (out.length >= WORLDBOOK_MAX_ENTRIES) break;
    if (chars + s.content.length > WORLDBOOK_CHAR_BUDGET) continue; // try a shorter one
    out.push(s.content);
    chars += s.content.length;
  }
  return out;
}

/**
 * The approximate tier: keyworded entries the query nearly, but not exactly,
 * asked for. Ordered strongest first, capped at WORLDBOOK_FUZZY_MAX.
 *
 * Scoring is BM25 over the entries' own little corpus, which is what makes a
 * character shared with every entry worth almost nothing and one shared with
 * a single entry worth a lot — the same reasoning memory retrieval uses, on
 * the same code. The gate above it is `termWeight`, because in a two-entry
 * worldbook IDF has nothing to work with.
 */
function approximate(
  missed: WorldbookEntry[],
  query: string,
): Array<{ score: number; content: string; createdAt: number }> {
  if (missed.length === 0 || !query.trim()) return [];
  const q = worldTerms(query);
  const terms = new Map(missed.map((e) => [e.id, worldTerms(matchText(e))]));
  const corpus = buildCorpus(
    missed.map((e) => ({
      id: e.id,
      fact: matchText(e),
      embedding: encodeTerms(terms.get(e.id) ?? new Map()),
    })),
  );
  const out: Array<{ score: number; content: string; createdAt: number }> = [];
  for (const e of missed) {
    let strength = 0;
    for (const t of terms.get(e.id)?.keys() ?? []) if (q.has(t)) strength += termWeight(t);
    if (strength < WORLDBOOK_FUZZY_MIN) continue;
    const score = bm25(corpus, e.id, q);
    if (score <= 0) continue;
    out.push({ score, content: e.content.trim(), createdAt: e.createdAt });
  }
  return out
    .sort((a, b) => b.score - a.score || a.createdAt - b.createdAt)
    .slice(0, WORLDBOOK_FUZZY_MAX);
}

/**
 * The storage-reading convenience the engines call: all entries → matched
 * lines. Failures return [] — lore must never break a turn.
 */
export async function worldLinesFor(opts: {
  query: string;
  contactId?: string;
  convId?: string;
  tier?: NsfwTier;
}): Promise<string[]> {
  try {
    return matchWorldbook(await repo.getWorldbook(), opts);
  } catch {
    return [];
  }
}
