/**
 * Moments feed (朋友圈).
 *
 * The nav bar starts transparent over the cover photo and fades to a solid bar
 * as the cover scrolls away — that transition is one of the most recognizable
 * things about this screen, so it is driven by real scroll position rather than
 * a fixed threshold guess.
 *
 * M-I15: the cover can be a photo from the media library (settings KV
 * `momentsCoverRef`), a seeded low-frequency「XX 刚看过你的朋友圈」hint row
 * appears under the cover, entering the page clears the Discover-tab news
 * badge, and cards gain 转发 / #话题# / author-album navigation.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useMedia } from '../../components/useMedia';
import { useAppStore } from '../../store/appStore';
import { Avatar } from '../../components/Avatar';
import { Sheet } from '../../components/Sheet';
import { IconBack } from '../../components/icons';
import { MomentCard } from './MomentCard';
import { showConfirm } from '../../components/dialog';
import { recentlyActive } from '../../ai/presence';
import { useNow } from '../../lib/useNow';
import { repo } from '../../db/repo';
import { listRegisteredMedia } from '../../data/media-registry';
import { resolveImageRef } from '../../data/moments-images';
import { recentVisitor, visitorLine } from '../../ai/moments-visitors';
import { usePullRefresh } from '../../components/usePullRefresh';
import { PullRefresh } from '../../components/PullRefresh';
import { useStagger } from '../../lib/useStagger';
import type { MomentCommentVM } from '../../data/types';
import './moments.css';

/** Cover height in px; the nav is fully opaque once this much has scrolled by. */
const COVER_H = 260;
/** Cards mounted up front, and the step added on each scroll toward the end. */
const INITIAL_CARDS = 12;

/** Settings row holding the cover's media ref (`idb:<id>`). Absent = gradient. */
export const COVER_SETTING_KEY = 'momentsCoverRef';

export function MomentsPage() {
  const navigate = useNavigate();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [navAlpha, setNavAlpha] = useState(0);
  const [composingOn, setComposingOn] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const moments = useAppStore((s) => s.moments);
  const contacts = useAppStore((s) => s.contacts);
  const personaFor = useAppStore((s) => s.personaFor);
  const loadMoments = useAppStore((s) => s.loadMoments);
  const likesFor = useAppStore((s) => s.likesFor);
  const commentsFor = useAppStore((s) => s.commentsFor);
  const toggleLike = useAppStore((s) => s.toggleLike);
  const markMomentsSeen = useAppStore((s) => s.markMomentsSeen);

  // Photos are materialized on demand (M-G1): ask for the ones this feed
  // draws, and re-render when they arrive. Priming the whole library here
  // would put back the memory problem the lazy registry exists to remove.
  const addComment = useAppStore((s) => s.addComment);

  const now = useNow();

  useEffect(() => {
    void loadMoments();
  }, [loadMoments]);

  // Looking at the feed consumes the news badge (M-I15). On mount, not on
  // every render — the watermark is "when you last opened the page".
  useEffect(() => {
    void markMomentsSeen(Date.now()).catch(() => {});
  }, [markMomentsSeen]);

  // 封面 (M-I15): user-chosen library photo behind the name/avatar corner.
  const [coverRef, setCoverRef] = useState<string | undefined>();
  const [coverPicker, setCoverPicker] = useState(false);
  useEffect(() => {
    void repo
      .getSetting<string>(COVER_SETTING_KEY)
      .then((r) => setCoverRef(r || undefined))
      .catch(() => {});
  }, []);
  const pickCover = async (ref: string | undefined) => {
    setCoverPicker(false);
    setCoverRef(ref);
    await repo.putSetting(COVER_SETTING_KEY, ref ?? '');
  };

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

  // 模拟访客感 (M-I15): seeded, low-frequency, minute-tick driven — pure of
  // the wall clock (constitution #4), so the same hour names the same visitor.
  const visitor = useMemo(() => {
    const ids = contacts
      .filter((c) => c.type === 'ai')
      .map((c) => c.id)
      .sort();
    return recentVisitor(ids, now);
  }, [contacts, now]);

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

  // Only what is mounted (+ the cover): priming the whole page's images would
  // exceed the object-URL cap and make the registry evict what it just made.
  useMedia(
    useMemo(() => [coverRef, ...visible.flatMap((m) => m.imageRefs ?? [])], [coverRef, visible]),
  );
  const coverUrl = coverRef ? resolveImageRef(coverRef).url : undefined;

  /**
   * 通知/深链锚定 (M-I18): `?at=<momentId>` — scroll that post into view and
   * flash it once, the same convention (and the same one-pulse treatment) the
   * chat page uses for a search hit.
   *
   * The feed mounts `INITIAL_CARDS` at a time, so a post further down is not in
   * the DOM yet; `shown` is grown to cover the target's index before looking
   * for the node. Keyed so a re-render does not re-run the jump, while a NEW
   * notification for a different post does.
   */
  const [searchParams] = useSearchParams();
  const atParam = searchParams.get('at');
  const [flashId, setFlashId] = useState<string | null>(null);
  const anchoredKey = useRef<string | null>(null);
  useEffect(() => {
    if (!atParam || anchoredKey.current === atParam) return;
    const idx = moments.findIndex((m) => m.id === atParam);
    // Not in this page of the feed (deleted, or older than the 60-row cap):
    // leave the user at the top rather than scrolling to nothing.
    if (idx < 0) return;
    anchoredKey.current = atParam;
    if (idx >= shown) setShown(idx + INITIAL_CARDS);
    // One frame for the newly-mounted cards to land.
    requestAnimationFrame(() => {
      const el = scrollRef.current?.querySelector(`[data-moment-id="${CSS.escape(atParam)}"]`);
      if (!el) return;
      (el as HTMLElement).scrollIntoView({ block: 'center' });
      setFlashId(atParam);
    });
  }, [atParam, moments, shown]);

  const onScroll = () => {
    const el = scrollRef.current;
    const y = el?.scrollTop ?? 0;
    setNavAlpha(Math.min(1, Math.max(0, y / COVER_H)));
    if (el && el.scrollHeight - y - el.clientHeight < 600) {
      setShown((n) => (n >= moments.length ? n : n + INITIAL_CARDS));
    }
  };

  /**
   * 下拉刷新 (M-I8).
   *
   * Reuses the force path `loadMoments` already had: the feed was frozen for
   * the life of the process before that flag existed, and this is the gesture
   * that finally asks for it. Also re-reads the 新消息 badge, because a like
   * that arrived while the feed was open is exactly what the pull is for.
   */
  const pullRef = useRef<HTMLDivElement>(null);
  const refreshMomentsNews = useAppStore((s) => s.refreshMomentsNews);
  const pull = usePullRefresh({
    ref: pullRef,
    scroller: () => scrollRef.current,
    onRefresh: async () => {
      await loadMoments(true);
      await refreshMomentsNews().catch(() => {});
    },
  });
  // First paint only: cards revealed by scrolling (INITIAL_CARDS at a time)
  // must not animate — the effect belongs to arriving at the feed.
  const stagger = useStagger();

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

  const coverChoices = listRegisteredMedia('photo');
  // Prime the picker grid only while it is open — the sheet shows the whole
  // photo library, which must not ride along on every ordinary feed visit.
  useMedia(
    useMemo(
      () => (coverPicker ? coverChoices.map((c) => `idb:${c.id}`) : []),
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [coverPicker, coverChoices.length],
    ),
  );

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

      {/* The clip does not move; the host inside it is what the pull
          translates (see pull-refresh.css). */}
      <div className="pull-clip moments__pull">
        <div className="pull-host" ref={pullRef} {...pull.handlers}>
          <PullRefresh phase={pull.phase} progress={pull.progress} />
          <div className="moments__scroll" ref={scrollRef} onScroll={onScroll}>
        <div
          className="moments__cover"
          role="button"
          aria-label="更换封面"
          onClick={() => setCoverPicker(true)}
        >
          {coverUrl && <img className="moments__cover-img" src={coverUrl} alt="" />}
          <div className="moments__self">
            <span className="moments__self-name">{self ? (self.remark ?? self.name) : '我'}</span>
            <Avatar text={self?.avatarText ?? '我'} color={self?.avatarColor ?? 'var(--color-text-secondary)'} imageRef={self?.avatarRef} size={64} />
          </div>
        </div>

        {visitor && (
          <div className="moments__visitor">
            <span className="moments__visitor-eye" aria-hidden>
              👀
            </span>
            {visitorLine(nameOf(visitor.contactId))}
          </div>
        )}

        {moments.length === 0 ? (
          <p className="moments__empty">还没有动态。点右上角相机发一条吧。</p>
        ) : (
          <div className="moments__list">
            {visible.map((m, cardIdx) => {
              const likes = likesFor(m.id);
              const enter = stagger(cardIdx);
              return (
                <div
                  key={m.id}
                  data-moment-id={m.id}
                  className={[enter?.className, flashId === m.id && 'moment-anchor-flash']
                    .filter(Boolean)
                    .join(' ')}
                  style={enter?.style}
                  // Cleared on animation end so a later notification for the
                  // same post can flash it again (chat.tsx does the same).
                  onAnimationEnd={(e) =>
                    e.animationName === 'moment-anchor-flash' && setFlashId(null)
                  }
                >
                  <MomentCard
                    moment={m}
                    author={m.authorId === 'self' ? self : byId.get(m.authorId)}
                    // 「刚刚活跃」绿点 (M-I16): pure projection of activeHours +
                    // a seeded half-hour roll — no timer, no stored state.
                    activeDot={
                      m.authorId !== 'self' && recentlyActive(personaFor(m.authorId), m.authorId, now)
                    }
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
                    // 转发 (M-I15): others' posts only — reposting your own is
                    // a gesture WeChat doesn't offer, and the builder refuses
                    // it anyway. The page re-reads the source from storage.
                    onRepost={
                      m.authorId !== 'self'
                        ? () => navigate(`/moments/repost/${m.id}`)
                        : undefined
                    }
                    onTopicTap={(tag) => navigate(`/moments/topic/${encodeURIComponent(tag)}`)}
                    onAuthorTap={() => navigate(`/moments/album/${m.authorId}`)}
                    // 正文 → 单条详情页 (M-J12).
                    onTextTap={() => navigate(`/moments/${m.id}`)}
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
      </div>

      {/* 封面选择 (M-I15): the photo library, plus a reset row. */}
      {coverPicker && (
        <Sheet open onClose={() => setCoverPicker(false)} title="更换朋友圈封面">
          {coverChoices.length === 0 ? (
            <p className="moments__cover-empty">
              素材库还没有照片。到 设置 → 素材库 导入后再来选。
            </p>
          ) : (
            <div className="moments__cover-grid">
              {coverChoices.map((c) => (
                <button
                  key={c.id}
                  className={`moments__cover-choice${coverRef === `idb:${c.id}` ? ' moments__cover-choice--on' : ''}`}
                  onClick={() => void pickCover(`idb:${c.id}`)}
                >
                  {c.url && <img src={c.url} alt="" loading="lazy" />}
                </button>
              ))}
            </div>
          )}
          {coverRef && (
            <button className="moments__cover-reset" onClick={() => void pickCover(undefined)}>
              恢复默认封面
            </button>
          )}
        </Sheet>
      )}
    </div>
  );
}
