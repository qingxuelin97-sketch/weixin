/**
 * Memory with structure and a real forgetting curve (M-E2).
 *
 * V1 memory was a flat list scored by `importance × 0.5^(age/30d)`, top-20
 * injected. Three things follow from that, all of them felt in conversation:
 *
 *  1. **No retrieval.** What gets injected does not depend on what you are
 *     talking about. Mention your sister and the prompt still carries the
 *     twenty most recent important facts, none of which may be about her.
 *  2. **No contradiction handling.** "他在北京工作" and "他搬到成都了" coexist
 *     forever, both injected, and the model picks one at random each turn.
 *  3. **Wrong forgetting shape.** A fixed half-life means a fact recalled fifty
 *     times decays exactly as fast as one never used again. Human memory does
 *     the opposite: retrieval is what makes a memory durable.
 *
 * The fix rides entirely on columns `memory_facts` has had since M1 and never
 * used — `aboutId`, `scope`, `embedding`, `confidence`, `refCount` — so there is
 * NO storage migration here. `embedding` holds a character-trigram vector
 * (Chinese has no whitespace, so trigrams are the cheapest thing that works
 * without a tokenizer or a network call), and retrieval is BM25 over it.
 *
 * Everything in this file is pure: no clock, no storage, no LLM. `now` is
 * injected, ranking is deterministic, ties break on stable keys.
 */
import type { MemoryFactVM } from '../data/types';

/* ==================================================================== */
/* 1. Character trigrams — the poor man's embedding                      */
/* ==================================================================== */

/** Punctuation and whitespace carry no retrieval signal; strip before indexing. */
const NOISE_RE = /[\s,.!?;:'"()[\]{}<>/\\|`~@#$%^&*_+=—…、。，！？；：""''（）《》【】]/g;

/**
 * Character trigrams, plus unigrams for Latin/digit runs.
 *
 * Chinese is unsegmented, so word-level indexing needs a tokenizer we cannot
 * ship (and will not download). Trigrams over characters approximate it well
 * enough for a corpus this small: 「成都」 inside 「他搬到成都了」 shares the
 * trigram 「到成都」/「成都了」 with a query mentioning 成都.
 */
export function trigrams(text: string): string[] {
  const out: string[] = [];
  // Latin words and numbers are already segmented BY the whitespace — so they
  // must be extracted before it is stripped, or "iPhone 15" fuses into the
  // single token "iphone15" and a query for "iPhone" misses it entirely.
  for (const m of text.matchAll(/[A-Za-z0-9]+/g)) out.push(m[0].toLowerCase());
  const clean = text.replace(NOISE_RE, '');
  if (!clean) return out;
  const cjk = clean.replace(/[A-Za-z0-9]+/g, '');
  if (cjk.length === 1) out.push(cjk);
  if (cjk.length === 2) out.push(cjk);
  for (let i = 0; i + 3 <= cjk.length; i++) out.push(cjk.slice(i, i + 3));
  // Bigrams too: short facts ("爱吃辣") would otherwise produce one token, and a
  // query of "吃辣" would miss it entirely.
  for (let i = 0; i + 2 <= cjk.length; i++) out.push(cjk.slice(i, i + 2));
  return out;
}

/** Term → count. The shape both the index and a query are reduced to. */
export function termFreq(text: string): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of trigrams(text)) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

/**
 * Serialize a term-frequency map for the `embedding` TEXT column.
 * Format: `t:n|t:n` — compact, human-readable in a DB inspector, and trivially
 * diffable. Terms containing the separators are dropped rather than escaped
 * (they are punctuation, which the tokenizer already removed).
 */
export function encodeVector(text: string): string {
  const parts: string[] = [];
  for (const [term, n] of termFreq(text)) {
    if (term.includes('|') || term.includes(':')) continue;
    parts.push(`${term}:${n}`);
  }
  return parts.join('|');
}

/** Inverse of `encodeVector`. Tolerates garbage: a bad row scores 0, never throws. */
export function decodeVector(encoded: string | undefined): Map<string, number> {
  const tf = new Map<string, number>();
  if (!encoded) return tf;
  for (const part of encoded.split('|')) {
    const i = part.lastIndexOf(':');
    if (i <= 0) continue;
    const n = Number(part.slice(i + 1));
    if (!Number.isFinite(n) || n <= 0) continue;
    tf.set(part.slice(0, i), n);
  }
  return tf;
}

/** The vector for a fact, from its stored column or recomputed from the text. */
export function vectorOf(fact: MemoryFactVM): Map<string, number> {
  const stored = decodeVector(fact.embedding);
  return stored.size > 0 ? stored : termFreq(fact.fact);
}

/* ==================================================================== */
/* 2. BM25 over the fact corpus                                          */
/* ==================================================================== */

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;

interface Corpus {
  /** term → how many facts contain it */
  df: Map<string, number>;
  n: number;
  avgLen: number;
  vectors: Map<string, Map<string, number>>;
  lengths: Map<string, number>;
}

/** Build the inverted statistics once per retrieval. Pure. */
export function buildCorpus(facts: MemoryFactVM[]): Corpus {
  const df = new Map<string, number>();
  const vectors = new Map<string, Map<string, number>>();
  const lengths = new Map<string, number>();
  let total = 0;
  for (const f of facts) {
    const v = vectorOf(f);
    vectors.set(f.id, v);
    let len = 0;
    for (const [term, n] of v) {
      len += n;
      df.set(term, (df.get(term) ?? 0) + 1);
    }
    lengths.set(f.id, len);
    total += len;
  }
  return { df, n: facts.length, avgLen: facts.length ? total / facts.length : 1, vectors, lengths };
}

/** Okapi BM25 for one fact against one query. 0 when nothing overlaps. */
export function bm25(corpus: Corpus, factId: string, query: Map<string, number>): number {
  const v = corpus.vectors.get(factId);
  if (!v) return 0;
  const len = corpus.lengths.get(factId) ?? 0;
  let score = 0;
  for (const term of query.keys()) {
    const tf = v.get(term);
    if (!tf) continue;
    const df = corpus.df.get(term) ?? 0;
    // +1 inside the log keeps idf non-negative for terms present in every doc,
    // which matters here: a 20-fact corpus makes "every doc" entirely ordinary.
    const idf = Math.log(1 + (corpus.n - df + 0.5) / (df + 0.5));
    const norm = tf * (BM25_K1 + 1);
    const denom = tf + BM25_K1 * (1 - BM25_B + (BM25_B * len) / (corpus.avgLen || 1));
    score += idf * (norm / (denom || 1));
  }
  return score;
}

/* ==================================================================== */
/* 3. Forgetting: Ebbinghaus with reconsolidation                        */
/* ==================================================================== */

/**
 * Baseline stability, calibrated against the model it replaces: an ordinary
 * fact (importance 3, extracted from chat so confidence 0.9, never re-referenced)
 * retains ~50% at 30 days — exactly the old fixed half-life. Everything the new
 * curve buys is in the DIFFERENCES from that point: trivia and hearsay fade
 * much faster, and anything actually used stops fading at all.
 */
export const BASE_STABILITY_MS = 15 * 24 * 3_600_000;

/**
 * Memory stability S — the time constant of the retention curve.
 *
 * Grows with importance and, crucially, with how often the fact has actually
 * been USED (`refCount`, bumped by `touchFacts` when an injected fact produced
 * a reply). That is the reconsolidation effect: retrieving a memory is what
 * makes it durable. The old fixed half-life had no such term, so a fact she
 * brings up every day faded on exactly the same schedule as one mentioned once.
 *
 * Pinned facts are unforgettable by definition, expressed as infinite stability
 * rather than as a special case in every caller.
 */
export function stability(fact: MemoryFactVM): number {
  if (fact.isPinned) return Infinity;
  const importance = clamp(fact.importance, 1, 5);
  const refs = Math.max(0, fact.refCount ?? 0);
  // Each retrieval multiplies stability by ~1.6, with diminishing returns via
  // the sqrt: the 10th recall should not make a fact 10× more permanent.
  const reconsolidation = 1 + 0.6 * Math.sqrt(refs);
  // Confidence is the hearsay discount: gossip you overheard fades faster than
  // something you were told directly. Direct extraction is 0.9, hearsay 0.4.
  const trust = 0.4 + 0.6 * clamp(fact.confidence ?? 0.6, 0, 1);
  return BASE_STABILITY_MS * importance * reconsolidation * trust;
}

/**
 * Retention R(t) = e^(−t/S) — the probability the fact is still available.
 * Age counts from the LAST retrieval, not from creation: that is what makes
 * re-reference actually reset the curve.
 */
export function retention(fact: MemoryFactVM, now: number): number {
  const s = stability(fact);
  if (!Number.isFinite(s)) return 1;
  const age = Math.max(0, now - (fact.lastRefAt ?? fact.createdAt));
  return Math.exp(-age / s);
}

/** Below this, a fact is treated as forgotten and stops being injected. */
export const FORGOTTEN_BELOW = 0.15;

export function isForgotten(fact: MemoryFactVM, now: number): boolean {
  return !fact.isPinned && retention(fact, now) < FORGOTTEN_BELOW;
}

/* ==================================================================== */
/* 4. Entities: who/what a fact is about                                 */
/* ==================================================================== */

/**
 * Relation markers, longest first so 「的妹妹」 wins over 「的」. Used only to
 * find the entity a fact hangs off — this is not a parser and does not pretend
 * to understand the sentence.
 */
const ENTITY_PATTERNS: Array<{ re: RegExp; group: number }> = [
  // 和X聊到… / 听X说… — the gossip framings agent-dm writes.
  { re: /^(?:和|跟)(.{1,8}?)(?:聊到|说起|提到)[：:]/, group: 1 },
  { re: /^听(.{1,8}?)说[：:]/, group: 1 },
  // X的Y是… / X在… / X喜欢…
  //
  // Bounded to 2–5 characters on purpose. An 8-char window let a subject-less
  // sentence match on any stray 的: 「随便一句没有主语的话」 produced the
  // "entity" 随便一句没有主语, which would then become a heading on the memory
  // page and a retrieval boost term. A name is short; over-reaching is worse
  // than returning nothing.
  { re: /^(.{2,5}?)(?:的|在|去|喜欢|讨厌|想要|正在|已经|最近)/, group: 1 },
];

/**
 * The entity a fact is about, as free text (a name or a noun), or undefined.
 *
 * Deliberately conservative: a wrong entity is worse than none, because facts
 * are grouped by it in the UI and boosted by it in retrieval. When in doubt,
 * return nothing and let BM25 do the work.
 */
export function entityOf(fact: string): string | undefined {
  const text = fact.trim();
  if (!text) return undefined;
  for (const { re, group } of ENTITY_PATTERNS) {
    const m = re.exec(text);
    const found = m?.[group]?.trim();
    // A single filler character ("他"/"她"/"你") is not an entity worth grouping.
    if (found && found.length >= 2) return found;
  }
  return undefined;
}

export interface EntityGroup {
  /** Display key: the entity name, or '其他' for facts with no clear subject. */
  entity: string;
  facts: MemoryFactVM[];
}

export const UNGROUPED = '其他';

/**
 * Group facts by entity for the memory page. Stable ordering: biggest groups
 * first, ties alphabetical, `其他` always last — so the page does not reshuffle
 * itself between renders.
 */
export function groupByEntity(facts: MemoryFactVM[]): EntityGroup[] {
  const groups = new Map<string, MemoryFactVM[]>();
  for (const f of facts) {
    const key = f.aboutId?.trim() || entityOf(f.fact) || UNGROUPED;
    const list = groups.get(key);
    if (list) list.push(f);
    else groups.set(key, [f]);
  }
  return [...groups.entries()]
    .map(([entity, list]) => ({
      entity,
      facts: [...list].sort((a, b) => b.createdAt - a.createdAt),
    }))
    .sort((a, b) => {
      if (a.entity === UNGROUPED) return 1;
      if (b.entity === UNGROUPED) return -1;
      return b.facts.length - a.facts.length || a.entity.localeCompare(b.entity);
    });
}

/* ==================================================================== */
/* 5. Contradiction: supersede rather than accumulate                    */
/* ==================================================================== */

/**
 * Predicate markers that make two facts mutually exclusive when they share an
 * entity: a person lives in ONE city, works at ONE company, has ONE birthday.
 * Preferences and experiences are NOT here — liking both coffee and tea is not
 * a contradiction, and treating it as one silently deletes half a persona's
 * knowledge of you.
 */
const EXCLUSIVE_PREDICATES: Array<{ key: string; re: RegExp }> = [
  { key: 'residence', re: /(住在|搬到|定居|现居)/ },
  { key: 'workplace', re: /(在.{0,8}(?:上班|工作)|入职|跳槽到|就职于)/ },
  { key: 'occupation', re: /(职业是|是一名|当上了|做的是)/ },
  { key: 'relationship', re: /(在一起|分手|结婚|离婚|单身|恋爱)/ },
  { key: 'age', re: /(\d{1,2}\s*岁)/ },
  { key: 'birthday', re: /(生日是|出生于)/ },
];

/** Which mutually-exclusive slot (if any) a fact fills. */
export function predicateOf(fact: string): string | undefined {
  for (const { key, re } of EXCLUSIVE_PREDICATES) {
    if (re.test(fact)) return key;
  }
  return undefined;
}

export interface SupersedeDecision {
  /** The incoming fact that wins. */
  winner: MemoryFactVM;
  /** Existing facts it replaces — archive these. */
  superseded: MemoryFactVM[];
}

/**
 * Decide what an incoming fact makes obsolete.
 *
 * Only fires when the two facts fill the SAME exclusive slot for the SAME
 * entity. "他住在北京" + "他搬到成都了" → the first is superseded. "他喜欢咖啡"
 * + "他喜欢茶" → both survive, because liking two things is not a contradiction.
 *
 * The incoming fact wins on recency, but never against a pinned one: the user
 * pinned it deliberately, and an LLM extraction must not overrule that.
 */
export function findSuperseded(
  existing: MemoryFactVM[],
  incoming: MemoryFactVM,
): SupersedeDecision {
  const predicate = predicateOf(incoming.fact);
  if (!predicate) return { winner: incoming, superseded: [] };
  const entity = incoming.aboutId?.trim() || entityOf(incoming.fact);

  const superseded = existing.filter((f) => {
    if (f.id === incoming.id) return false;
    if (f.status === 'archived') return false;
    if (f.isPinned) return false; // a pinned fact is the user's word, not the model's
    if (predicateOf(f.fact) !== predicate) return false;
    const otherEntity = f.aboutId?.trim() || entityOf(f.fact);
    // Same slot, same subject. Two facts about DIFFERENT people living in
    // different cities are both true and must both survive.
    if ((entity ?? '') !== (otherEntity ?? '')) return false;
    // Identical text is a duplicate, not a contradiction — but archiving the
    // older copy is still the right move (one row per truth).
    return f.createdAt <= incoming.createdAt;
  });

  return { winner: incoming, superseded };
}

/* ==================================================================== */
/* 6. Retrieval                                                          */
/* ==================================================================== */

export interface RetrieveOptions {
  /** What the conversation is currently about. Empty → recency/importance only. */
  query?: string;
  /** How many non-pinned facts to return. */
  topK?: number;
  maxPinned?: number;
  /** Weight of topical match against the always-on baseline. */
  queryWeight?: number;
}

export interface ScoredFact {
  fact: MemoryFactVM;
  score: number;
  /** Contribution breakdown, for the memory page's "why is this here". */
  parts: { base: number; topical: number; retention: number };
}

const DEFAULTS = { topK: 20, maxPinned: 10, queryWeight: 1.0 };

/**
 * Rank facts for injection.
 *
 * score = importance × retention(t) × (1 + w · normalizedBM25)
 *
 * The retention factor is what replaces the old fixed half-life; the BM25 term
 * is what makes the selection depend on the conversation at all. With no query
 * the ranking degrades gracefully to importance × retention, which is strictly
 * better than the old importance × age — a fact she uses often now stays.
 */
export function rankFacts(
  facts: MemoryFactVM[],
  now: number,
  opts: RetrieveOptions = {},
): ScoredFact[] {
  const { queryWeight } = { ...DEFAULTS, ...opts };
  const live = facts.filter((f) => f.status !== 'archived');
  const corpus = buildCorpus(live);
  const query = opts.query ? termFreq(opts.query) : new Map<string, number>();

  const raw = live.map((f) => {
    const topicalRaw = query.size > 0 ? bm25(corpus, f.id, query) : 0;
    return { fact: f, topicalRaw };
  });
  // Normalize BM25 within this retrieval: absolute scores are corpus-dependent
  // and would otherwise let a one-fact corpus dominate a twenty-fact one.
  const maxTopical = raw.reduce((m, r) => Math.max(m, r.topicalRaw), 0);

  return raw
    .map(({ fact, topicalRaw }) => {
      const r = retention(fact, now);
      const base = clamp(fact.importance, 1, 5) * r;
      const topical = maxTopical > 0 ? topicalRaw / maxTopical : 0;
      return {
        fact,
        score: base * (1 + queryWeight * topical),
        parts: { base, topical, retention: r },
      };
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.fact.importance - a.fact.importance ||
        a.fact.createdAt - b.fact.createdAt ||
        a.fact.id.localeCompare(b.fact.id),
    );
}

export interface Selection {
  pinned: string[];
  topK: string[];
  ids: string[];
}

/**
 * The injection set: pinned facts first (they are the user's explicit word),
 * then the highest-ranked remainder that has not been forgotten.
 *
 * Ordering is stable across turns for the same inputs so the prompt prefix
 * stays cacheable — a reshuffled memory block invalidates the cache on every
 * single message.
 */
export function selectForInjection(
  facts: MemoryFactVM[],
  now: number,
  opts: RetrieveOptions = {},
): Selection {
  const { topK, maxPinned } = { ...DEFAULTS, ...opts };
  const ranked = rankFacts(facts, now, opts);

  const pinned = ranked.filter((r) => r.fact.isPinned).slice(0, maxPinned);
  const pinnedIds = new Set(pinned.map((r) => r.fact.id));
  const rest = ranked
    .filter((r) => !pinnedIds.has(r.fact.id) && !isForgotten(r.fact, now))
    .slice(0, topK);

  return {
    pinned: pinned.map((r) => r.fact.fact),
    topK: rest.map((r) => r.fact.fact),
    ids: [...pinned, ...rest].map((r) => r.fact.id),
  };
}

/* ==================================================================== */

function clamp(n: number, lo: number, hi: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.min(Math.max(v, lo), hi);
}
