/**
 * When she calls YOU (M-H1).
 *
 * The call shell has existed since M5-D2 and only ever works one way: you dial,
 * the peer picks up. `render-msg` has known how to describe an incoming call
 * since M-E1 (`[对方打来语音通话，未接通]`) and nothing has ever produced one,
 * so that branch has been unreachable for two milestones.
 *
 * A call is the most intrusive thing this app can do. Everything here is
 * therefore a reason NOT to: it takes over the screen, it makes noise, and one
 * unwanted call costs more goodwill than twenty good messages earn. The bar is
 * accordingly much higher than for a gift — close relationship, waking hours
 * for both of you, an actual reason, a week between calls, and a seeded roll
 * that usually fails.
 */
import { seededRng } from '../lib/money';
import { isActiveAt } from './heartbeat';
import type { PersonaVM } from '../data/types';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export type CallReason = 'news' | 'worried' | 'missing' | 'occasion';

export interface CallPlan {
  reason: CallReason;
  /** When it should ring. */
  fireAt: number;
}

export interface CallContext {
  persona: PersonaVM;
  now: number;
  /** Effective closeness, 0..100. */
  affinity: number;
  /** She has fresh news about a mutual friend (rel-arcs). */
  hasFreshArc?: boolean;
  /** The user said something heavy recently. */
  userInTrouble?: boolean;
  /** A birthday / festival today. */
  occasion?: boolean;
  /** Last message in this conversation, either direction. */
  lastMsgAt?: number;
  /** When she last called. */
  lastCallAt?: number;
}

/** Nobody sane rings at 3am; the persona's own window decides the rest. */
const NIGHT_START = 23;
const NIGHT_END = 8;

/** A week between calls, minimum. Twice in one week is a different app. */
export const CALL_COOLDOWN_MS = 7 * DAY;

/** Closeness required. Below this, a phone call from her is alarming. */
const AFFINITY_FLOOR = 65;

/**
 * The conversation has to be LIVE.
 *
 * A call is a synchronous demand for attention; ringing into a chat that has
 * been silent for two days is not intimacy, it is an intrusion. Two hours is
 * roughly "we are both around right now".
 */
const LIVENESS_MS = 2 * HOUR;

const REASON_ODDS: Record<CallReason, number> = {
  worried: 0.35,
  news: 0.12,
  occasion: 0.2,
  missing: 0.05,
};

export function planCall(ctx: CallContext): CallPlan | null {
  const { persona, now } = ctx;
  if (ctx.affinity < AFFINITY_FLOOR) return null;
  if (ctx.lastMsgAt == null || now - ctx.lastMsgAt > LIVENESS_MS) return null;
  if (ctx.lastCallAt != null && now - ctx.lastCallAt < CALL_COOLDOWN_MS) return null;

  const hour = new Date(now).getHours();
  if (hour >= NIGHT_START || hour < NIGHT_END) return null;
  if (!isActiveAt(persona, now)) return null;

  const candidates: CallReason[] = [];
  if (ctx.userInTrouble) candidates.push('worried');
  if (ctx.occasion) candidates.push('occasion');
  if (ctx.hasFreshArc) candidates.push('news');
  candidates.push('missing');

  const dayBucket = Math.floor(now / DAY);
  for (const reason of candidates) {
    const rng = seededRng(`call:${persona.contactId}:${dayBucket}:${reason}`);
    // Proactivity gates it hard: for a 高冷 persona this multiplier is ~0.2,
    // so even a standing reason rarely produces a ring. Someone who does not
    // reach out by message is not going to start by telephoning.
    if (rng() > REASON_ODDS[reason] * (0.15 + persona.proactivity * 0.85)) continue;
    // Soon, but not instantly — a call that lands the same second as a message
    // reads as an automated escalation.
    return { reason, fireAt: Math.round(now + (2 + rng() * 8) * MIN) };
  }
  return null;
}

/**
 * What she says when you pick up, as a directive for the follow-up message.
 *
 * There is no real audio, so the call itself is theatre; what makes it mean
 * something is that the conversation afterwards knows it happened.
 */
export function callOpener(reason: CallReason): string {
  switch (reason) {
    case 'worried':
      return '你刚给对方打了个语音，因为不太放心。接通后先问一句怎么样了，别说教。';
    case 'news':
      return '你刚给对方打了个语音，有件事想直接说，打字太慢。';
    case 'occasion':
      return '你刚给对方打了个语音，想当面（用声音）说一句。';
    case 'missing':
      return '你刚给对方打了个语音，没什么正事，就是想听听声音。';
  }
}
