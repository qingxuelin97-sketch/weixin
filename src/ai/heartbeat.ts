/**
 * Proactive-message scheduling ("她先找我").
 *
 * This module owns only the *timing math* — when should a persona next reach out.
 * The queue itself lives in `scheduler.ts` (constitution rule #5: one time-evolution
 * path); this file must never grow its own pending/done bookkeeping again.
 *
 * Scheduling is seeded so reopening the app replays the same plan instead of
 * re-rolling a fresh one every launch.
 */
import { seededRng } from '../lib/money';
import type { PersonaVM } from '../data/types';
import { enqueue, type ScheduledAction } from './scheduler';

/** Local hour a timestamp falls in (activity windows are in local hours). */
function hourOf(ts: number): number {
  return new Date(ts).getHours();
}

/** Whether `ts` falls inside any of the persona's active windows (end may wrap past 24). */
export function isActiveAt(persona: PersonaVM, ts: number): boolean {
  const h = hourOf(ts);
  return persona.activeHours.some(([start, end]) => {
    if (end <= 24) return h >= start && h < end;
    // Window wraps past midnight, e.g. [14, 26] == 14:00–02:00.
    return h >= start || h < end - 24;
  });
}

/**
 * Pick the next heartbeat time for a persona: an exponential-ish interval scaled
 * by proactivity, nudged forward until it lands inside an active window.
 * Deterministic for a given (personaId, dayBucket) seed.
 */
export function nextHeartbeatAt(persona: PersonaVM, from: number): number {
  const dayBucket = Math.floor(from / 86_400_000);
  const rng = seededRng(`${persona.contactId}:${dayBucket}`);
  // Higher proactivity → shorter base interval.
  const base = persona.heartbeatBaseMin * (1.6 - persona.proactivity); // minutes
  const jitter = 0.5 + rng(); // 0.5..1.5
  let t = from + base * jitter * 60_000;
  // Walk forward in hour steps until inside an active window (max 48 steps).
  for (let i = 0; i < 48 && !isActiveAt(persona, t); i++) t += 3_600_000;
  return Math.round(t);
}

/**
 * Whether a heartbeat at `ts` may carry its text up front.
 *
 * Only the first message after a long silence qualifies. A persona's `greeting`
 * is a generic opener — believable when they haven't spoken in a while, wrong if
 * they messaged an hour ago. Everything else must be written at delivery, which
 * is why it ships without a lock-screen preview (see notify-service).
 */
export function canPreWriteGreeting(persona: PersonaVM, lastMsgAt: number | undefined, ts: number): boolean {
  if (!persona.greeting?.trim()) return false;
  if (lastMsgAt == null) return true;
  return ts - lastMsgAt >= 6 * 3_600_000;
}

/**
 * Queue this persona's next proactive message. Id is stable per fire time.
 *
 * When the opener can be written now, it rides along in the payload: the
 * notification shows exactly this text, and the handler persists exactly this
 * text stamped at `fireAt`. That equality IS the consistency rule — see
 * specs/backfill.md; without a pre-written body there is nothing a lock-screen
 * notification could honestly display.
 */
export async function scheduleHeartbeat(
  persona: PersonaVM,
  convId: string,
  from: number,
  lastMsgAt?: number,
): Promise<ScheduledAction> {
  const fireAt = nextHeartbeatAt(persona, from);
  const body = canPreWriteGreeting(persona, lastMsgAt, fireAt) ? persona.greeting : undefined;
  return enqueue({
    kind: 'heartbeat',
    fireAt,
    payload: { contactId: persona.contactId, convId, ...(body ? { body } : {}) },
    now: from,
    id: `hb_${persona.contactId}_${fireAt}`,
  });
}


/* ---- Proactive-opener material (M-A: 主动性) ---- */

/**
 * What a proactive message opens WITH. "有事找你" beats "打招呼" — a real
 * person reaches out because something reminded them of you.
 */
export interface OpenerSource {
  kind: 'memory' | 'moment' | 'greeting';
  /** The directive appended to the system prompt. */
  directive: string;
}

/**
 * Pick the opener's material, seeded so a replayed heartbeat opens the same way.
 *
 * Priority is probabilistic, not fixed: with material available, ~55% follow up
 * on a remembered fact, ~25% share their own fresh moment, rest plain greeting —
 * fixed priority would make every opener a follow-up, which reads as surveillance.
 */
export function pickOpener(
  facts: Array<{ fact: string; status: string }>,
  ownRecentMomentText: string | undefined,
  seed: string,
): OpenerSource {
  const rng = seededRng(`opener:${seed}`);
  const usable = facts.filter((f) => f.status === 'confirmed' && f.fact.trim());
  const roll = rng();

  if (usable.length > 0 && roll < 0.55) {
    const fact = usable[Math.floor(rng() * usable.length)].fact;
    return {
      kind: 'memory',
      directive:
        `你想起了这件事：「${fact}」。找个自然的方式提起或追问它——` +
        '像朋友惦记着对方的事，而不是审问。',
    };
  }
  if (ownRecentMomentText && roll < 0.8) {
    return {
      kind: 'moment',
      directive:
        `你刚发了条朋友圈：「${ownRecentMomentText}」。招呼对方去看看，` +
        '或者直接把里面的事当话头聊起来。',
    };
  }
  return { kind: 'greeting', directive: '' };
}

/**
 * Should this conversation get a "在忙？" nudge? True only when the LAST message
 * is the AI's own, it has sat unanswered for 6–48 hours, and the persona's
 * proactivity clears a seeded roll. The caller must use a stable action id per
 * (conv, message) — one nudge per ignored message, ever. Pestering is the
 * opposite of humanization.
 */
export const NUDGE_MIN_SILENCE_MS = 6 * 3_600_000;
export const NUDGE_MAX_SILENCE_MS = 48 * 3_600_000;

export function shouldNudge(
  lastMsg: { senderId: string; createdAt: number; id: number } | undefined,
  persona: PersonaVM,
  now: number,
): boolean {
  if (!lastMsg || lastMsg.senderId === 'self') return false;
  const silence = now - lastMsg.createdAt;
  if (silence < NUDGE_MIN_SILENCE_MS || silence > NUDGE_MAX_SILENCE_MS) return false;
  // Seeded on the ignored message, so re-running the check can't flip the answer.
  return seededRng(`nudge:${persona.contactId}:${lastMsg.id}`)() < persona.proactivity * 0.6;
}
