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
import { useNow } from '../../lib/useNow';
import type { MomentCommentVM } from '../../data/types';
import './moments.css';

/** Cover height in px; the nav is fully opaque once this much has scrolled by. */
const COVER_H = 260;

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
  useMedia(useMemo(() => moments.flatMap((m) => m.imageRefs ?? []), [moments]));
  const addComment = useAppStore((s) => s.addComment);

  const now = useNow();

  useEffect(() => {
    void loadMoments();
  }, [loadMoments]);

  const self = contacts.find((c) => c.type === 'self');
  const nameOf = (id: string) => {
    if (id === 'self') return self ? (self.remark ?? self.name) : '我';
    const c = contacts.find((x) => x.id === id);
    return c ? (c.remark ?? c.name) : id;
  };

  const onScroll = () => {
    const y = scrollRef.current?.scrollTop ?? 0;
    setNavAlpha(Math.min(1, Math.max(0, y / COVER_H)));
  };

  const submitComment = async (momentId: string) => {
    const text = draft.trim();
    if (!text) return;
    await addComment({
      id: `mc_${momentId}_${Date.now()}`,
      momentId,
      authorId: 'self',
      text,
      createdAt: Date.now(),
    } satisfies MomentCommentVM);
    setDraft('');
    setComposingOn(null);
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
            {moments.map((m) => {
              const likes = likesFor(m.id);
              return (
                <div key={m.id}>
                  <MomentCard
                    moment={m}
                    author={m.authorId === 'self' ? self : contacts.find((c) => c.id === m.authorId)}
                    likes={likes}
                    comments={commentsFor(m.id)}
                    nameOf={nameOf}
                    now={now}
                    selfLiked={likes.some((l) => l.contactId === 'self')}
                    onToggleLike={() => void toggleLike(m.id, 'self', Date.now())}
                    onComment={() => setComposingOn(m.id)}
                  />
                  {composingOn === m.id && (
                    <div className="moments__composer">
                      <input
                        autoFocus
                        value={draft}
                        placeholder="评论"
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
