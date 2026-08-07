/**
 * Long-term memory: extraction (LLM) + retrieval scoring (pure).
 *
 * V1 has no vector search — facts are scored by importance × recency decay and
 * the top-K are injected. Every fact must carry evidence message ids; a fact with
 * no evidence is a hallucination and is dropped at the door.
 */
import type { MemoryFactVM, MessageVM } from '../data/types';
import type { LlmRouter } from '../llm/router';
import { repo } from '../db/repo';

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
  opts: { maxPinned?: number; topK?: number } = {},
): { pinned: string[]; topK: string[] } {
  const maxPinned = opts.maxPinned ?? MAX_PINNED;
  const k = opts.topK ?? TOP_K;
  const live = facts.filter((f) => f.status !== 'archived');

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

  return { pinned: pinned.map((f) => f.fact), topK: rest.map((f) => f.fact) };
}

const EXTRACT_SYSTEM = `你是记忆整理员。从对话中提取关于用户的**稳定事实**（偏好、经历、关系、约定、身份等）。
规则：
- 忽略一次性的情绪和寒暄，只留下以后仍然成立的信息。
- 每条事实不超过 30 字，必须附上它出自哪几条消息的 id。
- 最多 5 条；没有值得记的就返回空数组。
只输出 JSON：{"facts":[{"fact":"...","importance":1-5,"evidence_msg_ids":[1,2]}]}`;

interface ExtractedFact {
  fact: string;
  importance: number;
  evidence_msg_ids: number[];
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
): Promise<MemoryFactVM[]> {
  if (messages.length === 0) return [];
  const transcript = messages
    .map((m) => `[${m.id}] ${m.senderId === 'self' ? '用户' : 'TA'}: ${m.content ?? `[${m.type}]`}`)
    .join('\n');

  const res = await router.complete(
    { role: 'memory', nsfwTier: 'off' },
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

  let parsed: { facts?: ExtractedFact[] };
  try {
    parsed = JSON.parse(stripFences(res.text)) as { facts?: ExtractedFact[] };
  } catch {
    return []; // unparseable → extract nothing rather than store garbage
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
      importance: clamp(Math.round(f.importance ?? 3), 1, 5),
      sensitivity: 'normal',
      evidenceMsgIds: f.evidence_msg_ids,
      status: 'pending',
      isPinned: false,
      createdAt: now,
    };
    await repo.putMemory(vm);
    saved.push(vm);
  }
  return saved;
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
