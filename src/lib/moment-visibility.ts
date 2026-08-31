/**
 * 朋友圈可见范围 (M-I18) — who is allowed to see one post.
 *
 * WeChat has four audiences: 公开 / 私密（仅自己）/ 部分可见（白名单）/
 * 不给谁看（黑名单）. The rules themselves are three lines; everything
 * interesting about this module is WHERE it gets called.
 *
 * The filter is applied in the DATA layer — inside the Repo drivers' moment
 * reads and inside `planReactions`/`planRepost` — following the precedent set
 * by `search()` filtering hidden conversations internally (CLAUDE.md §3.5). A
 * visibility check that lives in the feed component is a check that the next
 * read path forgets, and the failure mode here is the worst one this app has:
 * 「她评论了一条你设置成不给她看的动态」 is instant, irreversible穿帮.
 *
 * Pure: no storage, no clock, no randomness.
 */
import type { ContactVM, MomentVisibility, MomentVM } from '../data/types';

/** The default every row without an explicit audience carries. */
export const PUBLIC_VISIBILITY: MomentVisibility = { mode: 'public', ids: [] };

/** The subset of a post the audience rules actually read. */
export type AudienceRow = Pick<MomentVM, 'authorId' | 'visibility'>;

/**
 * May `viewerId` see this post?
 *
 * The author always can — a 私密 post is still visible to the person who wrote
 * it, which is exactly what makes 私密 usable as a diary rather than a
 * write-only hole. Everyone else is judged by the mode.
 *
 * An unknown/garbage mode falls through to `false`: an unreadable audience must
 * fail CLOSED, because the alternative is publishing something the user meant
 * to restrict.
 */
export function canSeeMoment(m: AudienceRow, viewerId: string): boolean {
  if (viewerId === m.authorId) return true;
  const v = m.visibility;
  if (!v) return true; // no audience recorded = 公开 (every pre-M-I18 row)
  switch (v.mode) {
    case 'public':
      return true;
    case 'private':
      return false;
    case 'include':
      return v.ids.includes(viewerId);
    case 'exclude':
      return !v.ids.includes(viewerId);
    default:
      return false;
  }
}

/**
 * Narrow a list of posts to what one viewer may see.
 *
 * Always a SUBSET of the input — this function can only ever remove rows. That
 * property is unit-locked, because the one way a visibility filter turns into a
 * leak is by growing into a fetcher that reaches for more rows than it was given.
 */
export function visibleMoments<T extends AudienceRow>(rows: readonly T[], viewerId: string): T[] {
  return rows.filter((m) => canSeeMoment(m, viewerId));
}

/**
 * Normalize what the editor produced into a row-shaped audience.
 *
 * `include` with an empty list collapses to 私密 (a whitelist of nobody IS
 * "only me"), `exclude` with an empty list collapses to 公开, and both list
 * modes drop 'self' and duplicates — the author is not a member of their own
 * audience, and a duplicated id would render as two names in the summary.
 */
export function normalizeVisibility(v: MomentVisibility | undefined): MomentVisibility | undefined {
  if (!v || v.mode === 'public') return undefined; // 公开 is the absent state
  if (v.mode === 'private') return { mode: 'private', ids: [] };
  const ids = [...new Set(v.ids)].filter((id) => id && id !== 'self');
  if (v.mode === 'include') return ids.length ? { mode: 'include', ids } : { mode: 'private', ids: [] };
  return ids.length ? { mode: 'exclude', ids } : undefined;
}

/**
 * Drop a contact from every audience list, for `deleteContactCascade`.
 *
 * Returns null when nothing changed, so the cascade only rewrites rows it
 * actually touched. Note that a whitelist emptied by the deletion becomes 私密
 * rather than 公开: losing the last person you shared with must not silently
 * publish the post to everyone (normalizeVisibility owns that rule).
 */
export function withoutContact(m: MomentVM, contactId: string): MomentVM | null {
  const v = m.visibility;
  if (!v || !v.ids.includes(contactId)) return null;
  const next = normalizeVisibility({ mode: v.mode, ids: v.ids.filter((id) => id !== contactId) });
  if (next) return { ...m, visibility: next };
  const { visibility: _drop, ...rest } = m;
  return rest;
}

/**
 * Who the audience picker may offer.
 *
 * AI contacts only — 'self' is the author and 'group' rows are not people. This
 * is deliberately derived from CONTACTS and never from conversations: building
 * a person-picker out of conversation rows is precisely how a hidden AI↔AI DM
 * thread ends up on a user-visible surface (CLAUDE.md §3.5).
 */
export function audienceCandidates(contacts: readonly ContactVM[]): ContactVM[] {
  return contacts.filter((c) => c.type === 'ai');
}

/** Short label for the publish page's row and the card's tag. */
export function audienceLabel(v: MomentVisibility | undefined): string {
  switch (v?.mode) {
    case 'private':
      return '私密';
    case 'include':
      return '部分可见';
    case 'exclude':
      return '不给谁看';
    default:
      return '公开';
  }
}
