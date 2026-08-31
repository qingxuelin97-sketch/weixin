/**
 * 朋友圈转发/引用 (M-I15).
 *
 * A repost is a NEW moment that quotes another one: the reposter's own words on
 * top, a compact grey card underneath naming the original author and an
 * excerpt of what they wrote. Chains always collapse to the ROOT: reposting a
 * repost quotes the original, never the middleman — exactly how forwarding a
 * forward behaves in chat.
 *
 * THE LEAK RULE (the reason this file exists as a choke point):
 *
 * A repost's quoted content may come from EXACTLY ONE place — a moment row
 * that is already in the public feed. Hidden AI↔AI conversations must never
 * surface through a quote chain, so `buildRepost` takes a `MomentVM` (not a
 * string) and derives the excerpt itself from `source.text`; there is no
 * parameter through which a caller could inject arbitrary text into the quote
 * card. The service wrapper (`repostMoment`) re-reads the source from storage
 * by id, so even a fabricated in-memory "moment" object cannot smuggle content
 * that never entered the feed. Same shape as `canForwardFrom` in
 * agent-forward.ts: plan-time AND publish-time checks, because the screen is
 * the side that cannot be un-shown.
 */
import type { MomentVM } from '../data/types';

/** Quote-card excerpt cap. Long originals are elided, never scrolled. */
export const REPOST_EXCERPT_MAX = 60;

/**
 * The excerpt a repost card shows. Derived from the source moment ONLY —
 * text first, else an image placeholder line. Never from caller input.
 */
export function repostExcerpt(source: Pick<MomentVM, 'text' | 'imageRefs'>): string {
  const t = (source.text ?? '').replace(/\s+/g, ' ').trim();
  if (t) return t.length > REPOST_EXCERPT_MAX ? `${t.slice(0, REPOST_EXCERPT_MAX)}…` : t;
  return source.imageRefs.length > 0 ? '[图片]' : '[动态]';
}

/**
 * May this moment be quoted at all?
 *
 * A repostable source is a plain feed row: it has an id, an author, and it is
 * not NSFW-flagged (the quote card would republish the content onto a surface
 * the constitution pins SFW). `isNsfw` is never set today, but the guard costs
 * nothing and outlives whoever forgets that.
 */
export function canRepost(source: MomentVM | undefined | null): source is MomentVM {
  if (!source) return false;
  if (!source.id || !source.authorId) return false;
  if (source.isNsfw) return false;
  return true;
}

/**
 * Build the repost row. Pure — storage and id-existence checks live in the
 * service wrapper below; this function's contract is that the quote fields can
 * only ever be derived from the `source` moment object.
 *
 * Chain collapse: when `source` is itself a repost, the new row inherits the
 * source's ROOT pointer and snapshot — the middle hop's own commentary is
 * dropped, as WeChat does. The snapshot (`repostAuthorId`/`repostExcerpt`) is
 * stored denormalized so a later deletion of the original degrades the card to
 * its last known content instead of a broken lookup.
 */
export function buildRepost(
  source: MomentVM,
  opts: { authorId: string; text: string; now: number },
): MomentVM | null {
  if (!canRepost(source)) return null;
  const rootId = source.repostOf ?? source.id;
  const rootAuthorId = source.repostOf ? (source.repostAuthorId ?? source.authorId) : source.authorId;
  const excerpt = source.repostOf ? (source.repostExcerpt ?? repostExcerpt(source)) : repostExcerpt(source);
  // Reposting your own root post is a no-op gesture WeChat doesn't offer.
  if (rootAuthorId === opts.authorId) return null;
  return {
    id: `mo_${opts.authorId}_rp_${opts.now}`,
    authorId: opts.authorId,
    text: opts.text.trim() || undefined,
    imageRefs: [], // the quote card carries the visual weight; no own grid
    isNsfw: false,
    createdAt: opts.now,
    repostOf: rootId,
    repostAuthorId: rootAuthorId,
    repostExcerpt: excerpt,
  };
}

/** What the service needs — narrow so tests use fakes, and the store the real repo. */
export interface RepostDeps {
  /** Read a moment by id from STORAGE — the feed of record, not caller memory. */
  getMoment: (id: string) => Promise<MomentVM | undefined>;
  addMoment: (m: MomentVM) => Promise<void>;
}

/**
 * Publish a repost of `sourceId` with the user's (or an agent's) own text.
 *
 * The source is re-read from storage by id: content that never entered the
 * public feed CANNOT be quoted, whatever object the caller holds. Returns the
 * stored row, or null when the source is missing/refused — a silent no rather
 * than a thrown error, because "原动态已删除" is an ordinary outcome.
 */
export async function repostMoment(
  sourceId: string,
  opts: { authorId: string; text: string; now: number },
  deps: RepostDeps,
): Promise<MomentVM | null> {
  const source = await deps.getMoment(sourceId);
  if (!canRepost(source ?? null)) return null;
  const row = buildRepost(source as MomentVM, opts);
  if (!row) return null;
  await deps.addMoment(row);
  return row;
}
