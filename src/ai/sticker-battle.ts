/**
 * 斗图 (M-I15): you send a sticker, she sometimes answers with one.
 *
 * Same design as voice-send.ts, and for the same reason: WHEN a person答图
 * rather than打字 is entirely situational, and the base rules cannot encode
 * it. The situations are well known to anyone who has been in a sticker war —
 *
 *   - a lone sticker sometimes gets a sticker back (the polite exchange);
 *   - two in a row is an INVITATION: the reply probability jumps, because now
 *     it's a game and dropping out loses;
 *   - the streak can't run forever — someone always types "行了行了" and the
 *     war ends, so the urge decays after a few rounds.
 *
 * Pure and seeded (constitution rule #4): the same message id always produces
 * the same decision, so replays and tests agree. Zero LLM cost — a sticker
 * answer is picked from her collected pool (sticker-taste) or the shared
 * vocab, not generated.
 */
import { seededRng } from '../lib/money';
import { STICKER_VOCAB } from '../data/stickers';
import { stickerScale } from './sticker-taste';

export interface BattleContext {
  /** Stable per-turn seed — use the persisted message id. */
  seed: string;
  /** How many consecutive sticker messages ended the transcript (yours+hers), ≥1. */
  streak: number;
  /**
   * The persona's 表情使用率 (M-I18), 0..1. Omitted = baseline, i.e. exactly the
   * curve this module shipped with. This is what stops 话痨爱斗图的 and 高冷的
   * from playing the same sticker war.
   */
  rate?: number;
}

/**
 * How likely she answers this sticker with a sticker, 0..1.
 *
 * One sticker: possible. A budding war (streak 2–4): likely — refusing to
 * play reads colder than playing. Past that the urge falls off; sticker wars
 * end because someone gets bored, and hers should too.
 *
 * `rate` (M-I18) scales the whole curve by the persona's 表情使用率, keeping its
 * SHAPE — the streak still invites, the war still decays — while moving how
 * readily this particular character joins one at all. A rate of 0 means she
 * never答图: the multiplication zeroes every branch, so there is no floor to
 * leak through.
 */
export function battleUrge(streak: number, rate?: number): number {
  if (streak <= 0) return 0;
  const base = streak === 1 ? 0.35 : streak <= 4 ? 0.65 : Math.max(0.1, 0.65 - (streak - 4) * 0.2);
  return Math.min(1, base * stickerScale(rate));
}

/*
 * There used to be a `wantsBattle(ctx)` here — the seeded gate, exported. It
 * had exactly one consumer: a test asserting it returns the same answer twice.
 * `battleReply` rolls the identical gate on its own first line (it has to: the
 * same rng stream then picks the sticker), so the export was a second name for
 * a decision nothing outside ever asked for separately. Deleted rather than
 * wired, because there is no capability behind it — a caller that wants to know
 * whether she plays asks for the move.
 */

export interface BattleReply {
  /** What she sends: a custom ref (`idb:…`) or a vocab label (「捂脸」…). */
  content: string;
  /** Human reaction delay — finding the right sticker takes a beat. */
  delayMs: number;
}

/**
 * Her move in the sticker war, or null if she lets this one pass.
 *
 * Prefers her collected customs (using YOUR sticker back is the best move in
 * any sticker war), falls back to the shared vocab. Never echoes the sticker
 * you just sent — replaying the same card is a misfire, not a comeback.
 */
export function battleReply(
  ctx: BattleContext,
  customPool: readonly string[],
  justSent?: string,
): BattleReply | null {
  const rng = seededRng(`stkbattle:${ctx.seed}`);
  if (rng() >= battleUrge(ctx.streak, ctx.rate)) return null;
  const customs = customPool.filter((r) => r !== justSent);
  const labels = Object.keys(STICKER_VOCAB).filter((l) => l !== justSent);
  // 70% reach for a custom when she has any — that's the whole point of
  // collecting them — otherwise the vocab carries the round.
  const useCustom = customs.length > 0 && (labels.length === 0 || rng() < 0.7);
  const pool = useCustom ? customs : labels;
  if (pool.length === 0) return null;
  const content = pool[Math.floor(rng() * pool.length)];
  return { content, delayMs: Math.round(800 + rng() * 1700) };
}

/**
 * Trailing sticker streak of a transcript (both sides count — a war is a
 * dialogue). Callers pass the tail message types, newest last.
 */
export function stickerStreak(tailTypes: readonly string[]): number {
  let n = 0;
  for (let i = tailTypes.length - 1; i >= 0; i--) {
    if (tailTypes[i] !== 'sticker') break;
    n++;
  }
  return n;
}
