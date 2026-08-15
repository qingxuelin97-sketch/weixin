/**
 * 朋友圈赞评「新消息」(M-I15, closing an I6 leftover).
 *
 * When a friend likes or comments on one of YOUR posts, two things should
 * happen without you staring at the feed:
 *
 *   1. the Discover tab's 朋友圈 row grows the classic mini-avatar + red dot
 *      (the actor's face, not a number — that is the WeChat idiom);
 *   2. a lock-screen notification may fire (notify-service handles that side,
 *      with content grading).
 *
 * This module is the pure half of (1): given the feed page and its social
 * rows, what happened to the user's own posts since they last looked? The
 * store keeps `momentsSeenAt` (a settings row) and calls this to derive the
 * badge — deriving instead of counting in place means a restart, a backfill,
 * or a missed event can never make the badge lie.
 */
import type { MomentVM, MomentLikeVM, MomentCommentVM } from '../data/types';

export interface MomentsNewsItem {
  kind: 'like' | 'comment' | 'repost';
  /** Who reacted — never 'self'; your own taps are not news to you. */
  actorId: string;
  momentId: string;
  at: number;
}

export interface MomentsNews {
  count: number;
  /** Newest actor, for the mini-avatar. Undefined when count is 0. */
  actorId?: string;
  items: MomentsNewsItem[];
}

const NO_NEWS: MomentsNews = { count: 0, items: [] };

/**
 * Everything that happened to the user's own posts after `seenAt`, newest
 * first. Pure: same inputs, same badge, so the Discover row and any future
 * "消息列表" page can share it and never disagree.
 *
 * `moments` is the whole feed page, not just the user's rows: a friend's
 * REPOST of your post (M-I15) is a new moment authored by them whose
 * `repostOf` points at yours, and it counts as news exactly like a like does.
 */
export function collectMomentsNews(
  moments: readonly MomentVM[],
  likesByMoment: Record<string, MomentLikeVM[]>,
  commentsByMoment: Record<string, MomentCommentVM[]>,
  seenAt: number,
): MomentsNews {
  const mine = new Set(moments.filter((m) => m.authorId === 'self').map((m) => m.id));
  if (mine.size === 0) return NO_NEWS;

  const items: MomentsNewsItem[] = [];
  for (const id of mine) {
    for (const l of likesByMoment[id] ?? []) {
      if (l.contactId !== 'self' && l.createdAt > seenAt) {
        items.push({ kind: 'like', actorId: l.contactId, momentId: id, at: l.createdAt });
      }
    }
    for (const c of commentsByMoment[id] ?? []) {
      if (c.authorId !== 'self' && c.createdAt > seenAt) {
        items.push({ kind: 'comment', actorId: c.authorId, momentId: id, at: c.createdAt });
      }
    }
  }
  for (const m of moments) {
    if (m.authorId !== 'self' && m.repostOf && mine.has(m.repostOf) && m.createdAt > seenAt) {
      items.push({ kind: 'repost', actorId: m.authorId, momentId: m.repostOf, at: m.createdAt });
    }
  }
  if (items.length === 0) return NO_NEWS;
  items.sort((a, b) => b.at - a.at);
  return { count: items.length, actorId: items[0].actorId, items };
}
