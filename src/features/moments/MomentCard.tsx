/**
 * One post in the Moments feed: author, text, image grid, timestamp, and the
 * like/comment block that appears only when someone has actually reacted.
 *
 * The "··" button toggles a small dark capsule with 赞 / 评论 — WeChat slides it
 * out from the right of the button, anchored to the timestamp row.
 *
 * M-I15 additions:
 *  - #话题# runs render as tappable links into the topic page;
 *  - a repost renders the ROOT original as a grey quote card (snapshot fields,
 *    so a deleted original degrades gracefully instead of breaking);
 *  - the author name is tappable (→ 个人相册页) when the parent wires it;
 *  - the capsule gains 转发 on posts the parent allows reposting.
 */
import { useState } from 'react';
import { Avatar } from '../../components/Avatar';
import { ImageViewer } from '../../components/ImageViewer';
import { resolveImageRef } from '../../data/moments-images';
import { momentTimestamp } from '../../lib/time';
import { topicSegments } from '../../lib/topics';
import type { MomentVM, MomentLikeVM, MomentCommentVM, ContactVM } from '../../data/types';

interface Props {
  moment: MomentVM;
  author: ContactVM | undefined;
  likes: MomentLikeVM[];
  comments: MomentCommentVM[];
  /** Resolve a contact id to its display name (remark wins over name). */
  nameOf: (id: string) => string;
  selfLiked: boolean;
  /** Injected so the feed's relative times are stable in tests/screenshots. */
  now: number;
  onToggleLike: () => void;
  onComment: () => void;
  /** Tap someone ELSE's comment → reply to it (M-I6). */
  onReplyComment?: (c: MomentCommentVM) => void;
  /** Tap one's OWN comment → offer deletion (M-I6). */
  onDeleteComment?: (c: MomentCommentVM) => void;
  /** 删除 link on one's own post (M-I6). Absent on others' posts. */
  onDelete?: () => void;
  /** 转发 in the capsule (M-I15). Absent = not repostable from this surface. */
  onRepost?: () => void;
  /** Tap a #话题# run (M-I15). Absent = topics render as plain text. */
  onTopicTap?: (tag: string) => void;
  /** Tap the author's name (M-I15 → 个人相册页). */
  onAuthorTap?: () => void;
}

/**
 * WeChat's grid: one image renders large and alone, four images use a 2×2 block,
 * everything else is a 3-across grid. Nine is the maximum a post can hold.
 */
function gridClass(n: number): string {
  if (n === 1) return 'moment__images moment__images--single';
  if (n === 4) return 'moment__images moment__images--quad';
  return 'moment__images moment__images--grid';
}

/** Post text with #话题# runs linked. Lossless for the prose in between. */
function MomentText({ text, onTopicTap }: { text: string; onTopicTap?: (tag: string) => void }) {
  const segs = topicSegments(text);
  return (
    <p className="moment__text">
      {segs.map((s, i) =>
        s.kind === 'topic' ? (
          <span
            key={i}
            className="moment__topic"
            role={onTopicTap ? 'link' : undefined}
            onClick={
              onTopicTap
                ? (e) => {
                    e.stopPropagation();
                    onTopicTap(s.value);
                  }
                : undefined
            }
          >
            #{s.value}#
          </span>
        ) : (
          <span key={i}>{s.value}</span>
        ),
      )}
    </p>
  );
}

export function MomentCard({
  moment,
  author,
  likes,
  comments,
  nameOf,
  selfLiked,
  now,
  onToggleLike,
  onComment,
  onReplyComment,
  onDeleteComment,
  onDelete,
  onRepost,
  onTopicTap,
  onAuthorTap,
}: Props) {
  const [actionsOpen, setActionsOpen] = useState(false);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  // Bumped on every like so the burst REPLAYS; a class that is merely present
  // animates once and then never again, which is the commonest way a
  // micro-interaction ships broken (M-H3).
  const [likeBeat, setLikeBeat] = useState(0);
  const imgs = moment.imageRefs.slice(0, 9);
  const hasReactions = likes.length > 0 || comments.length > 0;

  return (
    <article className="moment">
      <Avatar
        text={author?.avatarText ?? '?'}
        color={author?.avatarColor ?? 'var(--color-text-placeholder)'}
        imageRef={author?.avatarRef}
        size={40}
      />
      <div className="moment__body">
        <div
          className="moment__author"
          role={onAuthorTap ? 'link' : undefined}
          onClick={onAuthorTap}
        >
          {author ? (author.remark ?? author.name) : '未知'}
        </div>

        {moment.text && <MomentText text={moment.text} onTopicTap={onTopicTap} />}

        {/* 转发卡片 (M-I15): the quoted ROOT original. Rendered from the row's
            own snapshot fields — never from any conversation — so the card
            keeps working after the original is deleted, and no hidden-surface
            content can reach it (see moment-repost.ts). */}
        {moment.repostOf && (
          <div className="moment__repost">
            {moment.repostAuthorId ? (
              <>
                <span className="moment__repost-author">{nameOf(moment.repostAuthorId)}</span>
                <span>：{moment.repostExcerpt ?? '[动态]'}</span>
              </>
            ) : (
              // Original author deleted — the cascade scrubbed the snapshot.
              <span>{moment.repostExcerpt ?? '原内容已删除'}</span>
            )}
          </div>
        )}

        {imgs.length > 0 && (
          <div className={gridClass(imgs.length)}>
            {imgs.map((ref, i) => {
              const { url, background } = resolveImageRef(ref);
              return (
                <div
                  key={`${ref}-${i}`}
                  className="moment__image"
                  style={background ? { background } : undefined}
                  onClick={() => setViewerIndex(i)}
                  role="button"
                >
                  {url && <img src={url} alt="" loading="lazy" />}
                </div>
              );
            })}
          </div>
        )}
        {viewerIndex != null && (
          <ImageViewer refs={imgs} index={viewerIndex} onClose={() => setViewerIndex(null)} />
        )}

        <div className="moment__meta">
          <span className="moment__time">
            {momentTimestamp(moment.createdAt, now)}
            {onDelete && (
              <button className="moment__delete" onClick={onDelete}>
                删除
              </button>
            )}
          </span>
          <div className="moment__actions">
            {actionsOpen && (
              <div className="moment__capsule" role="group">
                <button
                  onClick={() => {
                    onToggleLike();
                    setActionsOpen(false);
                    setLikeBeat((n) => n + 1);
                  }}
                >
                  {selfLiked ? '取消' : '赞'}
                </button>
                <span className="moment__capsule-div" />
                <button
                  onClick={() => {
                    onComment();
                    setActionsOpen(false);
                  }}
                >
                  评论
                </button>
                {onRepost && (
                  <>
                    <span className="moment__capsule-div" />
                    <button
                      onClick={() => {
                        onRepost();
                        setActionsOpen(false);
                      }}
                    >
                      转发
                    </button>
                  </>
                )}
              </div>
            )}
            <button
              className="moment__dots"
              aria-label="赞或评论"
              aria-expanded={actionsOpen}
              onClick={() => setActionsOpen((v) => !v)}
            >
              <span />
              <span />
            </button>
          </div>
        </div>

        {hasReactions && (
          <div className="moment__reactions">
            {likes.length > 0 && (
              <div
                className={`moment__likes${likeBeat > 0 ? ' like-burst' : ''}`}
                key={`likes-${likeBeat}`}
              >
                <span className="moment__heart" aria-hidden="true">
                  ♥
                </span>
                {likes.map((l) => nameOf(l.contactId)).join('，')}
              </div>
            )}
            {likes.length > 0 && comments.length > 0 && <div className="moment__reaction-div" />}
            {comments.map((c) => (
              <div
                key={c.id}
                className="moment__comment"
                role="button"
                // Own comment → delete; someone else's → reply. Same tap, the
                // ownership decides — exactly the device behavior.
                onClick={() =>
                  c.authorId === 'self' ? onDeleteComment?.(c) : onReplyComment?.(c)
                }
              >
                <span className="moment__comment-author">{nameOf(c.authorId)}</span>
                {c.replyToCommentId && (
                  <>
                    <span className="moment__comment-reply">回复</span>
                    <span className="moment__comment-author">
                      {nameOf(
                        comments.find((x) => x.id === c.replyToCommentId)?.authorId ?? c.authorId,
                      )}
                    </span>
                  </>
                )}
                <span>：{c.text}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}
