/**
 * What this conversation is actually in the middle of (M-E6).
 *
 * The 30-message window tells the model what was SAID. It does not tell it what
 * is OPEN — and that is what makes an AI feel like it is not listening:
 *
 *   你：今天面试完了 / 对了你上次说的那家店叫什么来着
 *   她：面试怎么样呀！
 *   （你问的那家店，再也没有人提起）
 *
 * A human holds two or three of those in their head and comes back to them.
 * `conv-state` is that head: the topic stack, the questions nobody answered,
 * the promises made, and who is waiting on whom.
 *
 * **Dual-channel, and that is the whole design.** A state refreshed only by the
 * memory pass is stale for the entire conversation it is supposed to help —
 * `mem_extract` fires minutes after you leave the chat. So:
 *
 *   1. a heuristic pass updates it on EVERY turn, instantly and for free;
 *   2. the memory pass refines it later, riding a call that was happening anyway.
 *
 * Channel 1 is what the user feels. Channel 2 is what keeps it from drifting.
 */
import { repo } from '../db/repo';
import type { MessageVM } from '../data/types';

export interface OpenQuestion {
  /** The question, trimmed. */
  text: string;
  /** 'self' when the user asked it. */
  askerId: string;
  askedAt: number;
  /** Message id, so the same question is never tracked twice. */
  msgId: number;
}

export interface ConvState {
  /** Most recent topics, newest first. Small on purpose. */
  topics: string[];
  /** Questions asked and not answered. */
  open: OpenQuestion[];
  /** Things somebody said they would do. */
  promises: string[];
  /** Who spoke last, so "she is waiting on you" is answerable. */
  lastSpeakerId?: string;
  updatedAt: number;
}

export const EMPTY_STATE: ConvState = { topics: [], open: [], promises: [], updatedAt: 0 };

const MAX_TOPICS = 3;
const MAX_OPEN = 3;
const MAX_PROMISES = 2;
/** After this, an unanswered question is water under the bridge. */
export const QUESTION_TTL_MS = 6 * 3_600_000;

function key(convId: string): string {
  return `convstate:${convId}`;
}

export async function getConvState(convId: string): Promise<ConvState> {
  try {
    const row = await repo.getSetting<ConvState>(key(convId));
    if (!row || !Array.isArray(row.topics)) return { ...EMPTY_STATE };
    return {
      topics: row.topics.slice(0, MAX_TOPICS),
      open: Array.isArray(row.open) ? row.open.slice(0, MAX_OPEN) : [],
      promises: Array.isArray(row.promises) ? row.promises.slice(0, MAX_PROMISES) : [],
      lastSpeakerId: row.lastSpeakerId,
      updatedAt: row.updatedAt ?? 0,
    };
  } catch {
    return { ...EMPTY_STATE };
  }
}

export async function putConvState(convId: string, state: ConvState): Promise<void> {
  try {
    await repo.putSetting(key(convId), state);
  } catch {
    /* conversational state is a nicety; never break a turn over it */
  }
}

/* ==================================================================== */
/* Channel 1: the heuristic pass (pure, instant, free)                   */
/* ==================================================================== */

const QUESTION_RE = /[?？]\s*$/;
const PROMISE_RE = /(我(?:会|来|去|给你|帮你)|等我|回头|明天(?:给|带|发)|下次(?:请|带))/;

/**
 * Is this message plausibly an answer to that question?
 *
 * Deliberately generous: anything the other person said afterwards, that is not
 * itself a question, counts. Being too strict here is what produces the failure
 * this module exists to prevent in mirror image — an AI insisting on a question
 * you already answered.
 */
export function answersQuestion(q: OpenQuestion, m: MessageVM): boolean {
  if (m.createdAt <= q.askedAt) return false;
  if (m.senderId === q.askerId) return false; // you cannot answer yourself
  if (m.type !== 'text' || !m.content) return false;
  return !QUESTION_RE.test(m.content.trim());
}

/**
 * Fold a conversation slice into the state. Pure — the caller persists it.
 *
 * `now` is injected and the result is a plain value, so the whole "what is this
 * conversation in the middle of" question is unit-testable without storage.
 */
export function updateConvState(prev: ConvState, messages: MessageVM[], now: number): ConvState {
  const topics = [...prev.topics];
  let open = [...prev.open];
  const promises = [...prev.promises];
  let lastSpeakerId = prev.lastSpeakerId;

  for (const m of messages) {
    if (m.type !== 'text' || !m.content || m.isRecalled) continue;
    const text = m.content.trim();
    if (!text) continue;
    lastSpeakerId = m.senderId;

    // A new message may answer something that was open.
    open = open.filter((q) => !answersQuestion(q, m));

    if (QUESTION_RE.test(text)) {
      if (!open.some((q) => q.msgId === m.id)) {
        open.unshift({
          text: text.slice(0, 40),
          askerId: m.senderId,
          askedAt: m.createdAt,
          msgId: m.id,
        });
      }
    } else if (PROMISE_RE.test(text) && !promises.includes(text.slice(0, 30))) {
      promises.unshift(text.slice(0, 30));
    }

    // Topic tracking is coarse on purpose: the newest substantial line IS the
    // topic, well enough for a prompt hint. Anything cleverer needs an LLM pass
    // per message, which is exactly the cost this channel exists to avoid.
    if (text.length >= 6 && !QUESTION_RE.test(text)) {
      const t = text.slice(0, 30);
      if (topics[0] !== t) topics.unshift(t);
    }
  }

  return {
    topics: topics.slice(0, MAX_TOPICS),
    // Stale questions are dropped: coming back to something from yesterday
    // afternoon reads as odd, not as attentive.
    open: open.filter((q) => now - q.askedAt < QUESTION_TTL_MS).slice(0, MAX_OPEN),
    promises: promises.slice(0, MAX_PROMISES),
    lastSpeakerId,
    updatedAt: now,
  };
}

/* ==================================================================== */
/* The prompt line                                                       */
/* ==================================================================== */

/**
 * One short block for the scene layer. Empty when there is nothing to say —
 * every sentence here competes with the persona for the model's attention
 * (guardrails G3/G10), so silence is the default.
 *
 * `selfId` is the AI: only questions THE USER asked are worth returning to.
 * Reminding her to answer her own question is nonsense.
 */
export function convStateDirective(state: ConvState, now: number): string {
  const lines: string[] = [];

  const unanswered = state.open.filter(
    (q) => q.askerId === 'self' && now - q.askedAt < QUESTION_TTL_MS,
  );
  if (unanswered.length > 0) {
    lines.push(`- 对方问过但你还没答：「${unanswered[0].text}」——找个自然的地方回上`);
  }
  if (state.promises.length > 0) {
    lines.push(`- 之前说过：「${state.promises[0]}」`);
  }
  if (lines.length === 0) return '';
  return `【这段对话还没了结的事】\n${lines.join('\n')}\n别一次全提，挑一件说。`;
}

/* ==================================================================== */
/* Channel 1's entry point                                               */
/* ==================================================================== */

/**
 * Refresh from the recent window. Called on every turn — cheap enough to be
 * unconditional, which is the point: a state that updates only when the memory
 * pass runs is stale for the entire conversation it was meant to help.
 */
export async function refreshConvState(
  convId: string,
  messages: MessageVM[],
  now: number,
): Promise<ConvState> {
  const prev = await getConvState(convId);
  // Only messages newer than the last fold, so re-reading the window does not
  // re-open questions that were already answered and dropped.
  const fresh = messages.filter((m) => m.createdAt > prev.updatedAt);
  if (fresh.length === 0) return prev;
  const next = updateConvState(prev, fresh, now);
  await putConvState(convId, next);
  return next;
}
