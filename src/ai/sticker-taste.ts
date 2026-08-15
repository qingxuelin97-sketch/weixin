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
import { repo } from '../db/repo';

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

/** How often a sticker turn reaches for a collected custom sticker. */
export const AGENT_STICKER_SWAP_RATE = 0.3;

/**
 * When the engine is about to play a sticker bubble: keep the vocab glyph, or
 * swap in one of the agent's collected customs? Returns the ref to send, or
 * null to keep the original content. Seeded per turn so replays agree.
 */
export function maybeAgentSticker(pool: readonly string[], seed: string): string | null {
  if (pool.length === 0) return null;
  const rng = seededRng(`stkswap:${seed}`);
  if (rng() >= AGENT_STICKER_SWAP_RATE) return null;
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
