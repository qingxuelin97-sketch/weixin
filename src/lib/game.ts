/**
 * 表情游戏 (M-I13): the dice and rock-paper-scissors "dynamic stickers".
 *
 * WeChat's originals animate and then LAND on a result. Ours land the same
 * way, with one constitutional constraint (rule #4): the result comes from
 * `seededRng`, never `Math.random`, and the seed is built from the message's
 * own deterministic attributes (convId + createdAt + a per-turn salt). That
 * makes every throw:
 *
 *   - fixed at send time and stored in `meta.result` — re-rendering, backup
 *     round-trips and offline backfill can never re-roll it;
 *   - reproducible in tests without mocking anything.
 *
 * Pure module: no storage, no clock, no DOM. `lib/` per the dependency rules.
 */
import { seededRng } from './money';

export type GameKind = 'dice' | 'rps';

/** 石头剪刀布 result index → label. Order is the seed contract; never reorder. */
export const RPS_LABELS = ['石头', '剪刀', '布'] as const;

/** Result index → hand glyph, same order as RPS_LABELS. */
export const RPS_GLYPHS = ['✊', '✌️', '🖐️'] as const;

/**
 * The seed for one throw. `salt` distinguishes two throws in the same turn
 * (bubble index) — without it an AI sending two dice in one reply would be
 * condemned to doubles forever.
 */
export function gameSeed(convId: string, at: number, salt: string | number = 0): string {
  return `game:${convId}:${at}:${salt}`;
}

/** Roll a die: 1..6. `seededRng` yields [0,1), so 6 maps cleanly. */
export function rollDice(seed: string): number {
  return 1 + Math.floor(seededRng(seed)() * 6);
}

/** Throw a hand: 0=石头 1=剪刀 2=布. */
export function rollRps(seed: string): number {
  return Math.floor(seededRng(seed)() * 3);
}

/** Clamp a stored result back into range — a tampered row must not crash a render. */
export function diceResult(raw: unknown): number {
  const n = typeof raw === 'number' ? Math.trunc(raw) : NaN;
  return n >= 1 && n <= 6 ? n : 1;
}

export function rpsResult(raw: unknown): number {
  const n = typeof raw === 'number' ? Math.trunc(raw) : NaN;
  return n >= 0 && n <= 2 ? n : 0;
}

/**
 * Who beat whom, for the AI's gloating rights (and the projection layer).
 * @returns 1 if `a` beats `b`, -1 if `b` beats `a`, 0 for a draw.
 */
export function rpsCompare(a: number, b: number): -1 | 0 | 1 {
  if (a === b) return 0;
  // 石头(0) beats 剪刀(1), 剪刀(1) beats 布(2), 布(2) beats 石头(0).
  return (b - a + 3) % 3 === 1 ? 1 : -1;
}

/** One human line describing a throw — shared by the projection layer and previews. */
export function describeGame(game: GameKind, result: number): string {
  return game === 'dice'
    ? `掷出了骰子，点数是 ${diceResult(result)} 点`
    : `猜拳出了「${RPS_LABELS[rpsResult(result)]}」`;
}
