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

const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const MAX_PINNED = 10;
export const TOP_K = 20;

/**
 * Score a fact for injection: importance weighted by exponential recency decay.
 * Pure and deterministic — `now` is injected.
 */
export function scoreFact(fact: MemoryFactVM, now: number): number {
  const ref = fact.lastRefAt ?? fact.createdAt;
  const ageMs = Math.max(0, now - ref);
  const decay = Math.pow(0.5, ageMs / HALF_LIFE_MS);
  return fact.importance * decay;
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
  } = {},
): { pinned: string[]; topK: string[]; ids: string[] } {
  const maxPinned = opts.maxPinned ?? MAX_PINNED;
  const k = opts.topK ?? TOP_K;
  const surface = opts.surface ?? 'single';
  const tier = opts.tier ?? 'off';
  // The injection whitelist specs/nsfw.md always required and nothing built:
  // graded facts only reach surfaces cleared for them.
  const live = facts.filter(
    (f) => f.status !== 'archived' && mayInjectFact(f.sensitivity, surface, tier),
  );

  const pinned = live
    .filter((f) => f.isPinned)
    .sort((a, b) => b.importance - a.importance || a.createdAt - b.createdAt)
    .slice(0, maxPinned);

  const pinnedIds = new Set(pinned.map((f) => f.id));
  const rest = live
    .filter((f) => !pinnedIds.has(f.id))
    .map((f) => ({ f, s: scoreFact(f, now) }))
    .sort((a, b) => b.s - a.s || a.f.createdAt - b.f.createdAt)
    .slice(0, k)
    .map((x) => x.f);

  return {
    pinned: pinned.map((f) => f.fact),
    topK: rest.map((f) => f.fact),
    // Injected fact ids, so a successful reply can bump their refCount (the
    // pending→confirmed signal): a memory that got USED is a memory that held.
    ids: [...pinned, ...rest].map((f) => f.id),
  };
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

/** Retire trivia: low-importance facts unreferenced for 30 days go to archive. */
export async function maintainMemory(subjectId: string, now: number): Promise<number> {
  const all = await repo.getMemory(subjectId);
  let archived = 0;
  for (const f of all) {
    if (f.status === 'archived' || f.isPinned) continue;
    const lastTouch = f.lastRefAt ?? f.createdAt;
    if (f.importance <= 2 && now - lastTouch > ARCHIVE_AFTER_MS) {
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
   */
  tier: NsfwTier = 'off',
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

  const saved: MemoryFactVM[] = [];
  for (const f of parsed.facts ?? []) {
    // Evidence gate: no citation, no fact.
    if (!f?.fact?.trim() || !Array.isArray(f.evidence_msg_ids) || f.evidence_msg_ids.length === 0) {
      continue;
    }
    const vm: MemoryFactVM = {
      id: `mem_${subjectId}_${now}_${saved.length}`,
      subjectId,
      fact: f.fact.trim().slice(0, 50),
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
