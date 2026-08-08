/**
 * One post in the Moments feed: author, text, image grid, timestamp, and the
 * like/comment block that appears only when someone has actually reacted.
 *
 * The "··" button toggles a small dark capsule with 赞 / 评论 — WeChat slides it
 * out from the right of the button, anchored to the timestamp row.
 */
import { useState } from 'react';
import { Avatar } from '../../components/Avatar';
import { resolveImageRef } from '../../data/moments-images';
import { momentTimestamp } from '../../lib/time';
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
}: Props) {
  const [actionsOpen, setActionsOpen] = useState(false);
  const imgs = moment.imageRefs.slice(0, 9);
  const hasReactions = likes.length > 0 || comments.length > 0;

  return (
    <article className="moment">
      <Avatar
        text={author?.avatarText ?? '?'}
        color={author?.avatarColor ?? 'var(--color-text-placeholder)'}
        size={40}
      />
      <div className="moment__body">
        <div className="moment__author">{author ? (author.remark ?? author.name) : '未知'}</div>

        {moment.text && <p className="moment__text">{moment.text}</p>}

        {imgs.length > 0 && (
          <div className={gridClass(imgs.length)}>
            {imgs.map((ref, i) => {
              const { url, background } = resolveImageRef(ref);
              return (
                <div
                  key={`${ref}-${i}`}
                  className="moment__image"
                  style={background ? { background } : undefined}
                >
                  {url && <img src={url} alt="" loading="lazy" />}
                </div>
              );
            })}
          </div>
        )}

        <div className="moment__meta">
          <span className="moment__time">{momentTimestamp(moment.createdAt, now)}</span>
          <div className="moment__actions">
            {actionsOpen && (
              <div className="moment__capsule" role="group">
                <button
                  onClick={() => {
                    onToggleLike();
                    setActionsOpen(false);
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
              <div className="moment__likes">
                <span className="moment__heart" aria-hidden="true">
                  ♥
                </span>
                {likes.map((l) => nameOf(l.contactId)).join('，')}
              </div>
            )}
            {likes.length > 0 && comments.length > 0 && <div className="moment__reaction-div" />}
            {comments.map((c) => (
              <div key={c.id} className="moment__comment">
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
