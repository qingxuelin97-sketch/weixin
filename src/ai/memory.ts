/**
 * Long-term memory: extraction (LLM) + retrieval scoring (pure).
 *
 * V1 has no vector search — facts are scored by importance × recency decay and
 * the top-K are injected. Every fact must carry evidence message ids; a fact with
 * no evidence is a hallucination and is dropped at the door.
 */
import type { MemoryFactVM, MessageVM } from '../data/types';
import type { LlmRouter, NsfwTier } from '../llm/router';
import { sensitivityForTier, mayInjectFact } from '../lib/nsfw-tier';
import { repo } from '../db/repo';
import { renderTranscript } from './render-msg';
import {
  retention,
  encodeVector,
  entityOf,
  findSuperseded,
  selectForInjection,
  isForgotten,
} from './entity-graph';

export const MAX_PINNED = 10;
export const TOP_K = 20;

/**
 * Score a fact for injection: importance weighted by exponential recency decay.
 * Pure and deterministic — `now` is injected.
 */
export function scoreFact(fact: MemoryFactVM, now: number): number {
  // Was a fixed 30-day half-life. Now the Ebbinghaus curve from entity-graph,
  // whose stability grows with how often the fact has actually been recalled —
  // so a memory she uses every day stops decaying like one used once.
  return fact.importance * retention(fact, now);
}

/**
 * Choose which facts to inject: all pinned (capped), then the highest-scoring
 * remainder. Archived facts are never injected. Ordering is stable so the prompt
 * prefix stays cacheable.
 */
export function selectFactsForInjection(
  facts: MemoryFactVM[],
  now: number,
  opts: {
    maxPinned?: number;
    topK?: number;
    /** Where these facts are headed. Gates nsfw/sensitive rows (specs/nsfw.md). */
    surface?: 'single' | 'group' | 'moments' | 'director' | 'dm';
    /** Effective tier of that surface. Defaults to 'off' — the safe direction. */
    tier?: NsfwTier;
    /**
     * What the conversation is currently about (M-E2). With it, retrieval is
     * topical; without it, ranking degrades to importance × retention, which is
     * still strictly better than the old importance × age.
     */
    query?: string;
  } = {},
): { pinned: string[]; topK: string[]; ids: string[] } {
  const surface = opts.surface ?? 'single';
  const tier = opts.tier ?? 'off';
  // The injection whitelist specs/nsfw.md always required and nothing built:
  // graded facts only reach surfaces cleared for them. Applied BEFORE ranking,
  // so a blocked fact cannot even influence the corpus statistics.
  const live = facts.filter(
    (f) => f.status !== 'archived' && mayInjectFact(f.sensitivity, surface, tier),
  );
  return selectForInjection(live, now, {
    query: opts.query,
    topK: opts.topK ?? TOP_K,
    maxPinned: opts.maxPinned ?? MAX_PINNED,
  });
}

/** How the rolling summary introduces itself, per surface. */
const SUMMARY_PREFIX = {
  single: '上次你们聊到：',
  group: '上次群里聊到：',
} as const;

/**
 * Put the conversation's rolling summary (M-D2, `conv_summaries`) in front of
 * the retrieved facts.
 *
 * Shared by both engines since M-I18, and that is the point. The writer side
 * has always covered groups — `putConvSummary` never cared what kind of
 * conversation it was handed — but only the 1:1 engine ever READ one back. So
 * a group's summary was generated, backed up and cascade-deleted while never
 * once reaching a prompt: leave a room for a day and she picked the thread
 * back up in your DM while having no idea what the group had been about.
 * One function means the two surfaces cannot drift apart again.
 */
export function withConvSummary(
  topK: string[],
  summary: string | undefined,
  surface: 'single' | 'group' = 'single',
): string[] {
  const s = summary?.trim();
  return s ? [`${SUMMARY_PREFIX[surface]}${s}`, ...topK] : topK;
}

/** Mark injected facts as referenced; first use flips pending → confirmed. */
export async function touchFacts(subjectId: string, factIds: string[], now: number): Promise<void> {
  if (factIds.length === 0) return;
  const wanted = new Set(factIds);
  const all = await repo.getMemory(subjectId);
  for (const f of all) {
    if (!wanted.has(f.id)) continue;
    await repo.putMemory({
      ...f,
      refCount: (f.refCount ?? 0) + 1,
      lastRefAt: now,
      status: f.status === 'pending' ? 'confirmed' : f.status,
    });
  }
}

const ARCHIVE_AFTER_MS = 30 * 24 * 3_600_000;

/**
 * Retire what has genuinely faded.
 *
 * Two rules, and the second is the M-E2 one: a fact whose retention has fallen
 * below the floor is forgotten, whatever its importance — but retention now
 * grows with use, so a fact she keeps bringing up never reaches the floor. The
 * original rule (importance ≤ 2 and untouched for 30 days) stays as a cheap
 * fast path for trivia that was never worth much to begin with.
 */
export async function maintainMemory(subjectId: string, now: number): Promise<number> {
  const all = await repo.getMemory(subjectId);
  let archived = 0;
  for (const f of all) {
    if (f.status === 'archived' || f.isPinned) continue;
    const lastTouch = f.lastRefAt ?? f.createdAt;
    const trivia = f.importance <= 2 && now - lastTouch > ARCHIVE_AFTER_MS;
    if (trivia || isForgotten(f, now)) {
      await repo.putMemory({ ...f, status: 'archived' });
      archived++;
    }
  }
  return archived;
}

const EXTRACT_SYSTEM = `你是记忆整理员。从对话中提取关于用户的**稳定事实**（偏好、经历、关系、约定、身份等）。
规则：
- 忽略一次性的情绪和寒暄，只留下以后仍然成立的信息。
- 每条事实不超过 30 字，必须附上它出自哪几条消息的 id。
- 最多 5 条；没有值得记的就返回空数组。
- summary 用一句话（≤50字）概括这段对话聊了什么、进展到哪，供下次接着聊。
只输出 JSON：{"facts":[{"fact":"...","importance":1-5,"evidence_msg_ids":[1,2]}],"summary":"..."}`;

interface ExtractedFact {
  fact: string;
  importance: number;
  evidence_msg_ids: number[];
}

export interface ExtractResult {
  facts: MemoryFactVM[];
  /** One-line conversation summary riding along in the SAME llm call (cost=0 extra). */
  summary?: string;
}

/**
 * Extract memory facts from a slice of conversation. Facts without evidence ids
 * are discarded (anti-hallucination gate). Returns the facts that were saved.
 */
export async function extractMemory(
  router: LlmRouter,
  subjectId: string,
  messages: MessageVM[],
  now: number,
  /**
   * Effective tier of the material being sent. REQUIRED, and never invented
   * here: this transcript is verbatim chat content, so declaring 'off' for a
   * full-tier conversation routes explicit text to a domestic endpoint
   * (constitution rule #6). Callers derive it via lib/nsfw-tier.
   *
   * No default (M-I18). It used to be `= 'off'`, three lines under the word
   * REQUIRED — so a caller that simply forgot the argument declared explicit
   * material safe for a mainland endpoint, silently, at runtime. Rule 6 is
   * meant to be a code-level constraint; a required parameter makes the
   * compiler the one enforcing it.
   */
  tier: NsfwTier,
): Promise<ExtractResult> {
  if (messages.length === 0) return { facts: [] };
  // Projected, so a fact like "他转了我 52 块请我喝奶茶" is extractable at all —
  // the raw `[transfer]` placeholder carried none of it.
  const transcript = renderTranscript(messages, { withIds: true, includeVoiceText: true });

  const res = await router.complete(
    { role: 'memory', nsfwTier: tier },
    {
      messages: [
        { role: 'system', content: EXTRACT_SYSTEM },
        { role: 'user', content: transcript },
      ],
      json: true,
      temperature: 0.2,
    },
    {},
    `memory:${subjectId}`,
  );

  let parsed: { facts?: ExtractedFact[]; summary?: string };
  try {
    parsed = JSON.parse(stripFences(res.text)) as { facts?: ExtractedFact[]; summary?: string };
  } catch {
    return { facts: [] }; // unparseable → extract nothing rather than store garbage
  }

  // Existing memory, read once: new facts are checked against it for
  // contradictions before anything is written.
  const existing = await repo.getMemory(subjectId);
  const saved: MemoryFactVM[] = [];
  for (const f of parsed.facts ?? []) {
    // Evidence gate: no citation, no fact.
    if (!f?.fact?.trim() || !Array.isArray(f.evidence_msg_ids) || f.evidence_msg_ids.length === 0) {
      continue;
    }
    const text = f.fact.trim().slice(0, 50);
    const vm: MemoryFactVM = {
      id: `mem_${subjectId}_${now}_${saved.length}`,
      subjectId,
      fact: text,
      // Graph fields (M-E2), on columns the schema has carried since M1:
      // who it is about, and its trigram vector for topical retrieval.
      ...(entityOf(text) ? { aboutId: entityOf(text) } : {}),
      embedding: encodeVector(text),
      // Grade at the source: a fact extracted from full-tier talk is nsfw and
      // must stay behind the injection whitelist (specs/nsfw.md), not leak into
      // Moments or group prompts. NaN-safe: a non-numeric importance used to
      // persist as NaN forever.
      importance: clamp(Math.round(Number(f.importance) || 3), 1, 5),
      sensitivity: sensitivityForTier(tier),
      evidenceMsgIds: f.evidence_msg_ids,
      status: 'pending',
      isPinned: false,
      createdAt: now,
      source: 'chat',
      confidence: 0.9,
      refCount: 0,
    };
    await repo.putMemory(vm);
    // Contradiction handling: a newer fact filling the same mutually-exclusive
    // slot RETIRES the old one instead of coexisting with it. Without this,
    // "他住在北京" and "他搬到成都了" were both injected forever and the model
    // picked one at random each turn. Preferences are deliberately excluded —
    // liking both coffee and tea is not a contradiction.
    const { superseded } = findSuperseded([...existing, ...saved], vm);
    for (const old of superseded) {
      await repo.putMemory({ ...old, status: 'archived', supersededBy: vm.id });
    }
    saved.push(vm);
  }
  const summary = parsed.summary?.trim().slice(0, 80) || undefined;
  return { facts: saved, summary };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

function stripFences(s: string): string {
  return s
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}
