/**
 * Why she would send YOU money (M-H1).
 *
 * Money has only ever flowed one way in this app: the user sends, the AI grabs.
 * Every red packet in the codebase is `senderId: 'self'`. That asymmetry is felt
 * long before it is noticed — she takes and never gives, which is not a friend,
 * it is a slot machine.
 *
 * This module is the DECISION half: given who she is, how close you two are,
 * what day it is and what just happened in the conversation, would she send
 * something — and what, and how much. It performs no I/O and never calls a
 * model, so the whole question is unit-testable and replay-stable (rule #4:
 * randomness comes from `seededRng`, the clock is injected).
 *
 * THE HARD PART IS SAYING NO. A persona that sends money every other day is not
 * generous, it is a bot with a payment API. Nearly everything below is a gate:
 * closeness floors, a multi-day cooldown, a liveness check, and a seeded roll
 * that most days fails. A gift is supposed to be rare enough to mean something.
 */
import { seededRng } from '../lib/money';
import { classifyUserMessage } from '../lib/affect';
import { isActiveAt } from './heartbeat';
import type { Occasion } from './occasions';
import type { MessageVM, PersonaVM } from '../data/types';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

export type GiftReason = 'birthday' | 'apology' | 'comfort' | 'festival' | 'treat';

export interface GiftPlan {
  /** A packet is a gesture; a transfer is a statement. See `KIND_OF`. */
  kind: 'rp' | 'transfer';
  reason: GiftReason;
  /** Integer fen, always (rule #3). */
  amountFen: number;
  /** Packet greeting, or transfer note. */
  note: string;
  /** The line she types just before it lands. May be empty. */
  line: string;
  /** Absolute time it should happen, already inside an active hour. */
  fireAt: number;
}

/** Just enough of a message for the signal readers below. */
export type GiftMessage = Pick<MessageVM, 'senderId' | 'type' | 'content' | 'createdAt'>;

export interface GiftContext {
  persona: PersonaVM;
  now: number;
  /** Effective closeness 0..100 (relationship edge, already resolved). */
  affinity: number;
  /** From `occasionsFor()` — today's dates, if any. */
  occasions: Occasion[];
  /** The tail of the conversation. Read for conflict / low-mood signals. */
  recent: GiftMessage[];
  /** When she last gave money HERE. Undefined = never. */
  lastGiftAt?: number;
}

/**
 * How open-handed this persona is, 0..1.
 *
 * Read defensively: personas stored before this field existed have it as
 * `undefined`, and `undefined` in a comparison silently means "never" — the
 * exact failure mode the constitution's `makePersona()` trap describes.
 */
export function generosityOf(persona: Pick<PersonaVM, 'generosity'>): number {
  const g = persona.generosity;
  return typeof g === 'number' && Number.isFinite(g) ? Math.min(Math.max(g, 0), 1) : 0.35;
}

/* --------------------------- gates --------------------------- */

/** Days between gifts. A birthday and an apology may jump it; nothing else. */
export const GIFT_COOLDOWN_MS = 5 * DAY;
/** No gifts into a conversation that has gone quiet — that reads as a bribe. */
export const GIFT_LIVENESS_MS = 3 * DAY;

/** Closeness required, per reason. Strangers do not send money. */
const AFFINITY_FLOOR: Record<GiftReason, number> = {
  birthday: 25,
  apology: 35,
  comfort: 30,
  festival: 30,
  treat: 45,
};

/** Chance the reason fires at all, before generosity scaling. */
const BASE_ODDS: Record<GiftReason, number> = {
  birthday: 0.9,
  apology: 0.45,
  comfort: 0.3,
  festival: 0.35,
  // The unprompted one. Deliberately tiny: it is the only reason with no
  // trigger behind it, so it is the only one that could become noise.
  treat: 0.06,
};

/**
 * Amount ladders, in fen.
 *
 * Chinese gift amounts are not arbitrary numbers — 5.20 / 13.14 / 66.66 / 88.88
 * carry meaning, and a red packet of ¥37.42 is instantly wrong in a way no
 * amount of prompt engineering fixes. Every rung here is a number a person
 * would actually pick.
 */
const LADDER: Record<GiftReason, number[]> = {
  birthday: [5_200, 6_666, 8_888, 13_140],
  apology: [2_000, 3_344, 5_200, 6_666],
  comfort: [1_500, 1_800, 2_500, 3_000],
  festival: [520, 666, 888, 1_666],
  treat: [520, 666, 888, 1_000],
};

/**
 * Packet or transfer.
 *
 * A red packet is playful and its amount is hidden until you open it — right
 * for a festival or a birthday. A transfer shows the number and carries a note
 * — right when the money is saying something specific ("去买杯奶茶", "对不起").
 */
const KIND_OF: Record<GiftReason, 'rp' | 'transfer'> = {
  birthday: 'rp',
  festival: 'rp',
  treat: 'rp',
  apology: 'transfer',
  comfort: 'transfer',
};

/* --------------------------- signals --------------------------- */

/**
 * Did you two just have a row?
 *
 * Reuses `classifyUserMessage` rather than a second regex: the conflict
 * vocabulary that moved her mood is by definition the same vocabulary that
 * would make her want to make up, and two lists would drift apart.
 */
export function conflictRecently(recent: GiftMessage[], now: number, within = 24 * HOUR): boolean {
  return recent.some(
    (m) =>
      m.senderId === 'self' &&
      m.type === 'text' &&
      now - m.createdAt <= within &&
      // …but not in the last half hour. Money sent mid-argument is not an
      // apology, it is a way of ending the conversation.
      now - m.createdAt >= 30 * MIN &&
      classifyUserMessage(m.content ?? '') === 'conflict',
  );
}

/** Things people say when the day has gone badly. */
const LOW_RE =
  /(好累|太累|累死|心累|难受|不开心|emo|烦死|压力好大|加班|被骂|吵架了|生病|发烧|头疼|失眠|哭|崩溃|没胃口|想辞职)/;

/**
 * Are YOU the one having a bad day?
 *
 * `affect.ts` tracks how SHE feels; nothing tracked how you seem. Pattern-based
 * for the same reason `classifyUserMessage` is: an extra model call per turn to
 * move one boolean is not worth it, and a false positive here costs real money.
 */
export function userNeedsCheeringUp(recent: GiftMessage[], now: number, within = 12 * HOUR): boolean {
  return recent.some(
    (m) =>
      m.senderId === 'self' &&
      m.type === 'text' &&
      now - m.createdAt <= within &&
      LOW_RE.test(m.content ?? ''),
  );
}

/* --------------------------- wording --------------------------- */

const NOTES: Record<GiftReason, string[]> = {
  birthday: ['生日快乐', '生日快乐！', '祝你今年都顺'],
  festival: ['节日快乐', '沾沾喜气', '恭喜发财'],
  treat: ['请你喝奶茶', '看到这个想到你', '拿去花'],
  apology: ['刚才是我不好', '别气了', '我错了'],
  comfort: ['买杯喝的', '照顾好自己', '别硬撑'],
};

const LINES: Record<GiftReason, string[]> = {
  birthday: ['生日快乐呀', '今天可是你的日子', '差点忘了说——生日快乐'],
  festival: ['给你发个红包', '沾点喜气', '过节了'],
  treat: ['喏', '看到这个就想到你', '别问，收下'],
  apology: ['刚才我话说重了', '别生气了行不行', '我认错'],
  comfort: ['看你今天不太好', '去买点想吃的', '别一个人扛'],
};

function pick<T>(list: T[], rng: () => number): T {
  return list[Math.floor(rng() * list.length)];
}

/** Ladder rung by generosity, jittered one step either way. */
export function amountFor(reason: GiftReason, generosity: number, rng: () => number): number {
  const ladder = LADDER[reason];
  const base = Math.floor(generosity * ladder.length);
  const step = rng() < 0.35 ? -1 : rng() < 0.6 ? 1 : 0;
  const i = Math.min(Math.max(base + step, 0), ladder.length - 1);
  return ladder[i];
}

/* --------------------------- the decision --------------------------- */

/**
 * Walk `t` forward to the persona's next waking hour.
 *
 * Money that lands at 04:00 is money sent by a scheduler. Reuses the heartbeat
 * module's window logic so "when is she awake" has one answer in this codebase.
 */
function alignToActive(persona: PersonaVM, t: number): number {
  let out = t;
  for (let i = 0; i < 48 && !isActiveAt(persona, out); i++) out += HOUR;
  return out;
}

/** The reasons that may ignore the cooldown. Both are once-in-a-while events. */
const COOLDOWN_EXEMPT = new Set<GiftReason>(['birthday', 'apology']);

/**
 * Would she send something right now? `null` on almost every call — that is the
 * design, not a bug.
 */
export function planGift(ctx: GiftContext): GiftPlan | null {
  const { persona, now, affinity, occasions, recent } = ctx;
  const generosity = generosityOf(persona);
  if (generosity <= 0.02) return null;

  // A conversation nobody is having gets no gifts.
  const lastMsgAt = recent.length ? recent[recent.length - 1].createdAt : undefined;
  if (lastMsgAt == null || now - lastMsgAt > GIFT_LIVENESS_MS) return null;

  const birthdayToday = occasions.some((o) => o.kind === 'birthday' && o.inDays === 0);
  const festivalToday = occasions.some((o) => o.kind === 'festival' && o.inDays === 0);

  // Priority order. The first reason that clears every gate wins — she sends
  // one thing, for one reason, not a stack of them.
  const candidates: GiftReason[] = [];
  if (birthdayToday) candidates.push('birthday');
  if (conflictRecently(recent, now)) candidates.push('apology');
  if (userNeedsCheeringUp(recent, now)) candidates.push('comfort');
  if (festivalToday) candidates.push('festival');
  candidates.push('treat');

  const dayBucket = Math.floor(now / DAY);
  for (const reason of candidates) {
    if (affinity < AFFINITY_FLOOR[reason]) continue;
    if (
      !COOLDOWN_EXEMPT.has(reason) &&
      ctx.lastGiftAt != null &&
      now - ctx.lastGiftAt < GIFT_COOLDOWN_MS
    ) {
      continue;
    }
    // Even the exempt reasons get a floor: two apologies in one day is not
    // remorse, it is a malfunction.
    if (ctx.lastGiftAt != null && now - ctx.lastGiftAt < DAY) continue;

    // Seeded on (who, which day, which reason): re-running the planner in the
    // same day cannot re-roll a "no" into a "yes", so a foreground pass that
    // happens to run five times does not become five chances at a gift.
    const rng = seededRng(`gift:${persona.contactId}:${dayBucket}:${reason}`);
    const odds = BASE_ODDS[reason] * (0.4 + generosity);
    if (rng() > odds) continue;

    // Apology and comfort are reactions — they arrive within the hour, not
    // tomorrow morning. Dates can wait for her to be awake.
    const reactive = reason === 'apology' || reason === 'comfort';
    const delay = reactive ? (8 + rng() * 40) * MIN : (20 + rng() * 200) * MIN;
    return {
      kind: KIND_OF[reason],
      reason,
      amountFen: amountFor(reason, generosity, rng),
      note: pick(NOTES[reason], rng),
      line: pick(LINES[reason], rng),
      fireAt: Math.round(alignToActive(persona, now + delay)),
    };
  }
  return null;
}

/**
 * The group version: a festival packet, from one member, for everyone.
 *
 * Only festivals. A group red packet is a public gesture — an apology or a
 * "you seem sad" packet in front of eight people is a different, worse thing.
 */
export function planGroupGift(ctx: {
  now: number;
  convId: string;
  members: Array<{ contactId: string; persona: PersonaVM }>;
  occasions: Occasion[];
  lastMsgAt?: number;
  lastGiftAt?: number;
}): (GiftPlan & { contactId: string; count: number }) | null {
  if (!ctx.occasions.some((o) => o.kind === 'festival' && o.inDays === 0)) return null;
  if (ctx.members.length === 0) return null;
  if (ctx.lastMsgAt == null || ctx.now - ctx.lastMsgAt > GIFT_LIVENESS_MS) return null;
  if (ctx.lastGiftAt != null && ctx.now - ctx.lastGiftAt < GIFT_COOLDOWN_MS) return null;

  const dayBucket = Math.floor(ctx.now / DAY);
  const rng = seededRng(`groupgift:${ctx.convId}:${dayBucket}`);
  // One roll for the group, then one member draws the short straw — otherwise
  // a twelve-person group gets twelve packets on New Year's Day.
  const sender = ctx.members[Math.floor(rng() * ctx.members.length)];
  const generosity = generosityOf(sender.persona);
  if (rng() > BASE_ODDS.festival * (0.4 + generosity)) return null;

  const perHead = amountFor('festival', generosity, rng);
  return {
    contactId: sender.contactId,
    kind: 'rp',
    reason: 'festival',
    // Split among everyone present, so each share stays a festival share
    // rather than the whole packet going to whoever taps first.
    amountFen: perHead * (ctx.members.length + 1),
    count: ctx.members.length + 1,
    note: pick(NOTES.festival, rng),
    line: pick(LINES.festival, rng),
    fireAt: Math.round(ctx.now + (10 + rng() * 120) * MIN),
  };
}
