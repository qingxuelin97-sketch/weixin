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
 * is where "things she knows" already belongs. Matching is exact-substring
 * keywords over the current query, plus keywordless "constant" entries that
 * are always on within their scope; both are capped by entry count AND a
 * character budget so a prolific author cannot silently double every prompt.
 */
import { repo } from '../db/repo';
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
  for (const e of entries) {
    if (!e.enabled || !e.content.trim()) continue;
    // Full-open-tier content must never ride a surface at 'off' — the same
    // direction of caution the memory whitelist applies.
    if (e.nsfw && tier === 'off') continue;
    if (e.scope === 'persona' && e.scopeId !== opts.contactId) continue;
    if (e.scope === 'conv' && e.scopeId !== opts.convId) continue;
    const hits = e.keywords.filter((k) => k && q.includes(k)).length;
    if (e.keywords.length > 0 && hits === 0) continue; // triggered entry, no trigger
    scored.push({ score: e.priority + hits * 10, content: e.content.trim(), createdAt: e.createdAt });
  }
  scored.sort((a, b) => b.score - a.score || a.createdAt - b.createdAt);

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
