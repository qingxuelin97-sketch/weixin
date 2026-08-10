/**
 * Event-driven emotion, layered on top of the daily mood (M-E3).
 *
 * `mood.ts` gives each agent a mood for the DAY, seeded and replayable. That is
 * the right base — but it means nothing you do changes how she feels. Send a
 * red packet, apologise after a fight, ignore her for a week: the mood rolls
 * the same either way. A friend whose feelings never respond to you is the
 * loudest possible tell.
 *
 * Affect is a short-lived pulse ON TOP of that base: an event nudges valence
 * and arousal, and the pulse decays back toward the day's mood over hours. It
 * reuses the EXISTING consumption points (`cpmMul` / `proactMul` in mood.ts) so
 * the behaviour change is real without touching the engines.
 *
 * REPLAY DISCIPLINE (constitution rule #4 / guardrail G6): a pulse is caused by
 * a persisted event, so it is stored in a settings row and driven only by rowid
 * order. `simulate()` must NEVER read it — the offline planner has to stay a
 * pure function of (t0, t1, state, seed), and a decaying pulse read from
 * storage would make two replays of the same window disagree.
 */
import { repo } from '../db/repo';
import { moodOf, moodParams, type MoodParams } from './mood';

const HOUR = 3_600_000;

/** What happened. Each maps to a fixed (valence, arousal) nudge. */
export type AffectEvent =
  | 'user_reply' // you answered — the baseline good thing
  | 'user_warm' // a compliment, a thank-you, an apology
  | 'gift_received' // red packet or transfer landed
  | 'user_ignored' // a message of hers went unanswered long enough to hurt
  | 'user_cold' // a curt or dismissive reply
  | 'conflict' // an actual argument
  | 'good_news' // something went right in her own life
  | 'bad_news';

interface Pulse {
  /** −1 (miserable) … +1 (delighted). */
  valence: number;
  /** 0 (flat) … 1 (keyed up). Anger and joy are both high-arousal. */
  arousal: number;
  /** Hours for the pulse to decay to ~37% (one time constant). */
  halfLifeH: number;
}

/**
 * Magnitudes are deliberately modest. A persona who swings to despair because
 * you took four hours to reply is not moving, it is exhausting — and it makes
 * the app feel like it is manipulating you.
 */
const EVENT_PULSE: Record<AffectEvent, Pulse> = {
  user_reply: { valence: 0.15, arousal: 0.1, halfLifeH: 3 },
  user_warm: { valence: 0.45, arousal: 0.25, halfLifeH: 8 },
  gift_received: { valence: 0.5, arousal: 0.35, halfLifeH: 6 },
  user_ignored: { valence: -0.3, arousal: -0.1, halfLifeH: 10 },
  user_cold: { valence: -0.25, arousal: 0.15, halfLifeH: 5 },
  conflict: { valence: -0.55, arousal: 0.5, halfLifeH: 14 },
  good_news: { valence: 0.4, arousal: 0.3, halfLifeH: 12 },
  bad_news: { valence: -0.4, arousal: 0.2, halfLifeH: 16 },
};

export interface AffectState {
  valence: number;
  arousal: number;
  /** When the current pulse was last updated. Decay is measured from here. */
  at: number;
}

const ZERO: AffectState = { valence: 0, arousal: 0, at: 0 };

function key(contactId: string): string {
  return `affect:${contactId}`;
}

/** Exponential decay of a stored pulse to `now`. Pure. */
export function decayAffect(state: AffectState, now: number, halfLifeH = 8): AffectState {
  const dt = Math.max(0, now - state.at);
  const k = Math.exp(-dt / (halfLifeH * HOUR));
  return { valence: state.valence * k, arousal: state.arousal * k, at: now };
}

/** Read the current pulse, already decayed. Never throws; absent → zero. */
export async function getAffect(contactId: string, now: number): Promise<AffectState> {
  try {
    const row = await repo.getSetting<AffectState>(key(contactId));
    if (!row || typeof row.valence !== 'number') return { ...ZERO, at: now };
    return decayAffect(row, now);
  } catch {
    return { ...ZERO, at: now };
  }
}

/**
 * Record an event. Pulses ADD, then clamp — three warm things in a row feel
 * better than one, but nothing reaches saturation from a single gesture.
 *
 * Fire-and-forget by design: emotion bookkeeping must never delay or break a
 * visible reply, so every failure here is swallowed after being recorded.
 */
export async function recordAffect(
  contactId: string,
  event: AffectEvent,
  now: number,
): Promise<AffectState> {
  const pulse = EVENT_PULSE[event];
  const current = await getAffect(contactId, now);
  const next: AffectState = {
    valence: clamp(current.valence + pulse.valence, -1, 1),
    arousal: clamp(current.arousal + pulse.arousal, -1, 1),
    at: now,
  };
  try {
    await repo.putSetting(key(contactId), next);
  } catch {
    /* the pulse is a nicety; losing it must not break the turn */
  }
  return next;
}

/**
 * The behaviour parameters for a turn: the day's mood, shifted by the pulse.
 *
 * Reuses mood.ts's existing multipliers rather than adding a second mechanism —
 * so this is felt in typing speed and proactive pacing immediately, with no
 * change to the engines at all.
 */
export function affectedParams(base: MoodParams, affect: AffectState): MoodParams {
  // Arousal drives typing speed; valence drives the will to reach out.
  return {
    cpmMul: clamp(base.cpmMul * (1 + 0.25 * affect.arousal), 0.5, 1.6),
    proactMul: clamp(base.proactMul * (1 + 0.4 * affect.valence), 0.3, 2.0),
  };
}

/** Convenience: everything a turn needs, in one call. */
export async function affectFor(
  contactId: string,
  now: number,
): Promise<{ affect: AffectState; params: MoodParams; line: string }> {
  const affect = await getAffect(contactId, now);
  const mood = moodOf(contactId, now);
  return {
    affect,
    params: affectedParams(moodParams(mood.key), affect),
    line: affectLine(mood.line, affect),
  };
}

/** Below this the pulse is noise and adds nothing but tokens. */
export const AFFECT_FLOOR = 0.18;

/**
 * The scene-layer line. Returns the plain mood line when the pulse is small —
 * a prompt that describes a feeling she does not have is worse than silence,
 * and every extra sentence here dilutes the persona (guardrail G3/G10).
 */
export function affectLine(moodLine: string, affect: AffectState): string {
  const v = affect.valence;
  if (Math.abs(v) < AFFECT_FLOOR) return moodLine;
  if (v > 0.55) return `${moodLine}而且刚刚有点开心，语气比平常暖。`;
  if (v > 0) return `${moodLine}心情比刚才好了一点。`;
  if (v > -0.55) return `${moodLine}不过这会儿有点不是滋味，但没打算说破。`;
  return `${moodLine}这会儿心里挺不舒服的——不会闹，但热络不起来。`;
}

/**
 * Classify a user message into an affect event, or null for the ordinary case.
 *
 * Pattern-based on purpose: an LLM pass per message would double the cost of
 * every turn to move a number by 0.3. Only unmistakable signals count — a false
 * "she thinks I insulted her" is far more damaging than a missed compliment.
 */
export function classifyUserMessage(text: string): AffectEvent | null {
  const t = text.trim();
  if (!t) return null;
  if (/(对不起|抱歉|我错了|别生气|原谅我)/.test(t)) return 'user_warm';
  if (/(谢谢|感谢|太好了|辛苦了|喜欢你|想你|爱你|抱抱)/.test(t)) return 'user_warm';
  if (/(闭嘴|烦死|滚|无聊|你有病|懒得理)/.test(t)) return 'conflict';
  // A bare "哦"/"嗯"/"随便" is the classic cold shoulder — but only when it is
  // the ENTIRE message; "嗯，我也这么觉得" is warm agreement.
  if (/^(哦+|嗯+|额+|随便|无所谓|不知道)[。.!！]?$/.test(t)) return 'user_cold';
  return null;
}

function clamp(n: number, lo: number, hi: number): number {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.min(Math.max(v, lo), hi);
}
