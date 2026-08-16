/**
 * AI sticker taste (M-I15, 表情包 v2).
 *
 * The user can now import their own sticker images (`media` kind 'sticker',
 * refs `idb:<id>`). Agents should FEEL those stickers propagate: a sticker you
 * use at her often enough starts showing up in her own replies — she
 * "collected" it, the way real chat partners absorb each other's packs.
 *
 * Three pieces, all deterministic (constitution rule #4):
 *
 *  - a ledger of stickers the user has actually SENT (settings KV, bounded).
 *    Only sent stickers can be collected — importing a pack she never saw
 *    teaches her nothing;
 *  - a per-agent taste filter: each agent likes roughly half the ledger, and
 *    which half is seeded on (agent, ref) so it never changes between opens;
 *  - a per-turn usage gate: when the model already decided to send a sticker,
 *    a seeded minority of those turns swaps the vocab glyph for a collected
 *    custom one. Piggybacking on the model's own sticker decision keeps the
 *    emotional timing right without spending a token on it.
 */
import { seededRng } from '../lib/money';
import { STICKER_RATE_BASELINE } from '../data/persona-defaults';
import { repo } from '../db/repo';

/**
 * 表情使用率 → a multiplier on every seeded sticker gate (M-I19).
 *
 * Until now "how often does she send stickers" was two module constants shared
 * by every character in the app, so the 话痨 who spams 斗图 and the 高冷 one who
 * has never sent a sticker in her life behaved identically. `stickerRate` is a
 * persona field now (like `likeRate`), and this is the one place it turns into
 * a number the gates can multiply by.
 *
 * The baseline maps to exactly 1.0, so an unset persona behaves byte-for-byte
 * as it did before. Capped at 2× — a rate of 1.0 should make her reach for a
 * sticker at nearly every opportunity, not break the probability's shape.
 *
 * `undefined` reads as the baseline rather than as 0: a persona row written
 * before this field existed must degrade to "normal", never to the silent
 * "never sends stickers" that the constitution's makePersona trap warns about.
 */
export function stickerScale(rate: number | undefined): number {
  const r = typeof rate === 'number' && Number.isFinite(rate) && rate >= 0 ? rate : STICKER_RATE_BASELINE;
  return Math.min(2, r / STICKER_RATE_BASELINE);
}

/** Settings row holding the refs the user has sent, most recent last. */
export const USER_STICKER_KEY = 'stickerSent';

/** Ledger cap. Taste is about favorites, not an archive. */
export const USER_STICKER_MAX = 30;

/** Fold one send into the ledger. Pure; re-sending moves the ref to the tail. */
export function foldUserSticker(ledger: readonly string[], ref: string): string[] {
  if (!ref.startsWith('idb:')) return [...ledger]; // vocab glyphs are not collectible
  const next = ledger.filter((r) => r !== ref);
  next.push(ref);
  return next.slice(-USER_STICKER_MAX);
}

/** Record that the user sent a custom sticker. Fire-and-forget bookkeeping. */
export async function recordUserSticker(ref: string): Promise<void> {
  if (!ref.startsWith('idb:')) return;
  const cur = (await repo.getSetting<string[]>(USER_STICKER_KEY)) ?? [];
  await repo.putSetting(USER_STICKER_KEY, foldUserSticker(Array.isArray(cur) ? cur : [], ref));
}

/**
 * Which of the sent stickers THIS agent has taken a liking to. Seeded per
 * (agent, ref): stable forever, different per agent — two friends never share
 * the exact same taste, which is precisely what makes it read as taste.
 */
export function collectedStickers(contactId: string, ledger: readonly string[]): string[] {
  return ledger.filter((ref) => seededRng(`stkfav:${contactId}:${ref}`)() < 0.55);
}

/** How often a sticker turn reaches for a collected custom sticker, at baseline rate. */
export const AGENT_STICKER_SWAP_RATE = 0.3;

/**
 * When the engine is about to play a sticker bubble: keep the vocab glyph, or
 * swap in one of the agent's collected customs? Returns the ref to send, or
 * null to keep the original content. Seeded per turn so replays agree.
 *
 * `rate` is the persona's 表情使用率 (M-I19): someone who lives in her sticker
 * drawer reaches for a collected one far more readily than someone who sends
 * three a month. Omitted = baseline = the pre-M-I19 constant, unchanged.
 */
export function maybeAgentSticker(
  pool: readonly string[],
  seed: string,
  rate?: number,
): string | null {
  if (pool.length === 0) return null;
  const rng = seededRng(`stkswap:${seed}`);
  if (rng() >= Math.min(1, AGENT_STICKER_SWAP_RATE * stickerScale(rate))) return null;
  return pool[Math.floor(rng() * pool.length)];
}

/**
 * The agent's current custom-sticker pool: ledger → taste filter. One storage
 * read; callers cache it for the turn. `verify` (optional) drops refs whose
 * media item has since been deleted — a collected sticker that no longer
 * exists must degrade to "not collected", never to a broken image.
 */
export async function agentStickerPool(
  contactId: string,
  verify?: (ref: string) => boolean,
): Promise<string[]> {
  const cur = (await repo.getSetting<string[]>(USER_STICKER_KEY)) ?? [];
  const ledger = Array.isArray(cur) ? cur.filter((r): r is string => typeof r === 'string') : [];
  const collected = collectedStickers(contactId, ledger);
  return verify ? collected.filter(verify) : collected;
}
