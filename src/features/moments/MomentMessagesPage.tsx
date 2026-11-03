/**
 * 朋友圈「消息」列表 (M-K7): who liked, commented on or reposted which of
 * YOUR posts — the page the「N条新消息」capsule under the cover opens.
 *
 * Derived, never stored: the rows come from `collectMomentsNews` over the
 * loaded feed page with a zero watermark, the same pure function that drives
 * the Discover badge and the capsule's count. Three surfaces, one source — so
 * the badge, the capsule and this list cannot disagree about what happened.
 *
 * `?n=<count>` (from the capsule) shows just the new ones first, with WeChat's
 * 「查看更早的消息」below; opened without it, the page lists everything.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { SubNav } from '../../components/SubNav';
import { Avatar } from '../../components/Avatar';
import { IconHeart } from '../../components/icons';
import { useMedia } from '../../components/useMedia';
import { useAppStore } from '../../store/appStore';
import { collectMomentsNews, type MomentsNewsItem } from '../../ai/moments-news';
import { resolveImageRef } from '../../data/moments-images';
import { momentTimestamp } from '../../lib/time';
import { useNow } from '../../lib/useNow';
import type { MomentVM } from '../../data/types';
import './moment-messages.css';

/** What a row says happened: the comment itself, a heart, or the repost line. */
function Action({ item, text }: { item: MomentsNewsItem; text: string | undefined }) {
  if (item.kind === 'like') {
    return (
      <span className="mmsg__heart" aria-label="赞了你">
        <IconHeart size={16} />
      </span>
    );
  }
  if (item.kind === 'repost') return <>转发了你的朋友圈</>;
  // The item and the text come from the same comments map in the same render,
  // so a comment row always has its text here.
  return <>{text}</>;
}

/** The post a row is about: its first photo, else the start of its text. */
function PostPreview({ post }: { post: MomentVM | undefined }) {
  if (!post) return <div className="mmsg__post mmsg__post--text">原动态已删除</div>;
  const first = post.imageRefs[0];
  if (first) {
    const { url, background } = resolveImageRef(first);
    return (
      <div className="mmsg__post" style={background ? { background } : undefined}>
        {url && <img src={url} alt="" />}
      </div>
    );
  }
  // The clamp lives on an inner span: on the fixed-height square itself,
  // -webkit-line-clamp adds the ellipsis but still paints the next line.
  return (
    <div className="mmsg__post mmsg__post--text">
      <span>{post.text ?? ''}</span>
    </div>
  );
}

export function MomentMessagesPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const fresh = Math.max(0, Number(params.get('n')) || 0);
  const [showAll, setShowAll] = useState(fresh === 0);
  const now = useNow();

  const moments = useAppStore((s) => s.moments);
  const momentLikes = useAppStore((s) => s.momentLikes);
  const momentComments = useAppStore((s) => s.momentComments);
  const contacts = useAppStore((s) => s.contacts);
  const loadMoments = useAppStore((s) => s.loadMoments);
  useEffect(() => {
    void loadMoments();
  }, [loadMoments]);

  const all = useMemo(
    () => collectMomentsNews(moments, momentLikes, momentComments, 0).items,
    [moments, momentLikes, momentComments],
  );
  const items = showAll ? all : all.slice(0, fresh);

  const byId = useMemo(() => new Map(contacts.map((c) => [c.id, c])), [contacts]);
  const postById = useMemo(() => new Map(moments.map((m) => [m.id, m])), [moments]);
  const nameOf = (id: string) => {
    const c = byId.get(id);
    return c ? (c.remark ?? c.name) : id;
  };
  const commentText = (it: MomentsNewsItem) =>
    momentComments[it.momentId]?.find((c) => c.id === it.commentId)?.text;

  // Only the thumbnails this list actually draws.
  useMedia(
    useMemo(
      () => items.map((it) => postById.get(it.momentId)?.imageRefs[0]),
      [items, postById],
    ),
  );

  return (
    <>
      <SubNav title="消息" />
      <div className="page-body mmsg">
        {all.length === 0 ? (
          <p className="mmsg__empty">暂无消息</p>
        ) : (
          <div className="mmsg__list">
            {items.map((it) => {
              const who = byId.get(it.actorId);
              return (
                <button
                  key={`${it.kind}:${it.actorId}:${it.momentId}:${it.at}`}
                  className="mmsg__row"
                  onClick={() => navigate(`/moments/${it.momentId}`)}
                >
                  <Avatar
                    text={who?.avatarText ?? '?'}
                    color={who?.avatarColor ?? 'var(--color-text-placeholder)'}
                    imageRef={who?.avatarRef}
                    size={40}
                  />
                  <div className="mmsg__main">
                    <div className="mmsg__name">{nameOf(it.actorId)}</div>
                    <div className="mmsg__what">
                      <Action item={it} text={commentText(it)} />
                    </div>
                    <div className="mmsg__time">{momentTimestamp(it.at, now)}</div>
                  </div>
                  <PostPreview post={postById.get(it.momentId)} />
                </button>
              );
            })}
            {!showAll && all.length > items.length && (
              <button className="mmsg__more" onClick={() => setShowAll(true)}>
                查看更早的消息…
              </button>
            )}
          </div>
        )}
      </div>
    </>
  );
}
