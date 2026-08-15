/**
 * Moments feed (朋友圈).
 *
 * The nav bar starts transparent over the cover photo and fades to a solid bar
 * as the cover scrolls away — that transition is one of the most recognizable
 * things about this screen, so it is driven by real scroll position rather than
 * a fixed threshold guess.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMedia } from '../../components/useMedia';
import { useAppStore } from '../../store/appStore';
import { Avatar } from '../../components/Avatar';
import { IconBack } from '../../components/icons';
import { MomentCard } from './MomentCard';
import { showConfirm } from '../../components/dialog';
import { useNow } from '../../lib/useNow';
import type { MomentCommentVM } from '../../data/types';
import './moments.css';

/** Cover height in px; the nav is fully opaque once this much has scrolled by. */
const COVER_H = 260;
/** Cards mounted up front, and the step added on each scroll toward the end. */
const INITIAL_CARDS = 12;

export function MomentsPage() {
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [navAlpha, setNavAlpha] = useState(0);
  const [composingOn, setComposingOn] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const moments = useAppStore((s) => s.moments);
  const contacts = useAppStore((s) => s.contacts);
  const loadMoments = useAppStore((s) => s.loadMoments);
  const likesFor = useAppStore((s) => s.likesFor);
  const commentsFor = useAppStore((s) => s.commentsFor);
  const toggleLike = useAppStore((s) => s.toggleLike);

  // Photos are materialized on demand (M-G1): ask for the ones this feed
  // draws, and re-render when they arrive. Priming the whole library here
  // would put back the memory problem the lazy registry exists to remove.
  const addComment = useAppStore((s) => s.addComment);

  const now = useNow();

  useEffect(() => {
    void loadMoments();
  }, [loadMoments]);

  const self = contacts.find((c) => c.type === 'self');
  // One index, not a linear scan per call. `nameOf` is invoked for every like
  // and every comment on every card, so `contacts.find` made drawing the feed
  // O(posts × interactions × contacts).
  const byId = useMemo(() => new Map(contacts.map((c) => [c.id, c])), [contacts]);
  const nameOf = (id: string) => {
    if (id === 'self') return self ? (self.remark ?? self.name) : '我';
    const c = byId.get(id);
    return c ? (c.remark ?? c.name) : id;
  };

  /**
   * Cards actually mounted, grown as the user scrolls.
   *
   * Not virtualization: `getMoments` already caps a page at 60 (M-G1), so the
   * list is bounded — what is not bounded is the MEDIA. Priming every image on
   * the page at once (9 per post × 60 posts) blows straight past the object-URL
   * cap and makes the registry evict what it just materialized. Revealing
   * progressively keeps the working set inside the cap.
   */
  const [shown, setShown] = useState(INITIAL_CARDS);
  const visible = useMemo(() => moments.slice(0, shown), [moments, shown]);

  // Only what is mounted: priming the whole page's images would exceed the
  // object-URL cap and make the registry evict what it just materialized.
  useMedia(useMemo(() => visible.flatMap((m) => m.imageRefs ?? []), [visible]));

  const onScroll = () => {
    const el = scrollRef.current;
    const y = el?.scrollTop ?? 0;
    setNavAlpha(Math.min(1, Math.max(0, y / COVER_H)));
    if (el && el.scrollHeight - y - el.clientHeight < 600) {
      setShown((n) => (n >= moments.length ? n : n + INITIAL_CARDS));
    }
  };

  // 回复某人 (M-I6): replyToCommentId had render logic since M4 and no writer
  // — tapping a friend's comment now targets the composer at it.
  const [replyTo, setReplyTo] = useState<MomentCommentVM | null>(null);
  const deleteComment = useAppStore((s) => s.deleteComment);
  const deleteMoment = useAppStore((s) => s.deleteMoment);

  const submitComment = async (momentId: string) => {
    const text = draft.trim();
    if (!text) return;
    await addComment({
      id: `mc_${momentId}_${Date.now()}`,
      momentId,
      authorId: 'self',
      text,
      ...(replyTo && replyTo.momentId === momentId
        ? { replyToCommentId: replyTo.id }
        : {}),
      createdAt: Date.now(),
    } satisfies MomentCommentVM);
    setDraft('');
    setComposingOn(null);
    setReplyTo(null);
  };

  return (
    <div className="moments">
      <header
        className={`moments__nav${navAlpha > 0.5 ? ' moments__nav--solid' : ''}`}
        style={{ '--nav-alpha': navAlpha } as React.CSSProperties}
      >
        <button className="moments__nav-btn" aria-label="返回" onClick={() => navigate(-1)}>
          <IconBack />
        </button>
        <div className="moments__nav-title">朋友圈</div>
        <button
          className="moments__nav-btn"
          aria-label="发表"
          onClick={() => navigate('/moments/publish')}
        >
          <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor">
            <rect x="3" y="6" width="18" height="14" rx="2.5" strokeWidth="1.7" />
            <circle cx="12" cy="13" r="3.6" strokeWidth="1.7" />
            <path d="M8.5 6l1.3-2h4.4L15.5 6" strokeWidth="1.7" strokeLinejoin="round" />
          </svg>
        </button>
      </header>

      <div className="moments__scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="moments__cover">
          <div className="moments__self">
            <span className="moments__self-name">{self ? (self.remark ?? self.name) : '我'}</span>
            <Avatar text={self?.avatarText ?? '我'} color={self?.avatarColor ?? 'var(--color-text-secondary)'} imageRef={self?.avatarRef} size={64} />
          </div>
        </div>

        {moments.length === 0 ? (
          <p className="moments__empty">还没有动态。点右上角相机发一条吧。</p>
        ) : (
          <div className="moments__list">
            {visible.map((m) => {
              const likes = likesFor(m.id);
              return (
                <div key={m.id}>
                  <MomentCard
                    moment={m}
                    author={m.authorId === 'self' ? self : byId.get(m.authorId)}
                    likes={likes}
                    comments={commentsFor(m.id)}
                    nameOf={nameOf}
                    now={now}
                    selfLiked={likes.some((l) => l.contactId === 'self')}
                    onToggleLike={() => void toggleLike(m.id, 'self', Date.now())}
                    onComment={() => {
                      setReplyTo(null);
                      setComposingOn(m.id);
                    }}
                    onReplyComment={(c) => {
                      setReplyTo(c);
                      setComposingOn(m.id);
                    }}
                    onDeleteComment={(c) => {
                      void showConfirm({
                        title: '删除评论',
                        body: c.text.slice(0, 40),
                        confirmText: '删除',
                        danger: true,
                      }).then((ok) => {
                        if (ok) void deleteComment(m.id, c.id);
                      });
                    }}
                    onDelete={
                      m.authorId === 'self'
                        ? () => {
                            void showConfirm({
                              title: '删除该条朋友圈',
                              body: '删除后无法恢复。',
                              confirmText: '删除',
                              danger: true,
                            }).then((ok) => {
                              if (ok) void deleteMoment(m.id);
                            });
                          }
                        : undefined
                    }
                  />
                  {composingOn === m.id && (
                    <div className="moments__composer">
                      <input
                        autoFocus
                        value={draft}
                        placeholder={replyTo ? `回复${nameOf(replyTo.authorId)}` : '评论'}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => e.key === 'Enter' && void submitComment(m.id)}
                      />
                      <button onClick={() => void submitComment(m.id)}>发送</button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
