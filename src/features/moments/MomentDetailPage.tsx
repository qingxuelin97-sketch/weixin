/**
 * 朋友圈单条详情页 (M-J12) — /moments/:momentId.
 *
 * The full card with the comment thread opened out and like/comment usable in
 * place — where a search hit, a feed text tap or a stale deep link lands. The
 * feed store only holds the newest page, so this page reads its row from the
 * Repo directly (an old post must still open); interactions go THROUGH the
 * store, the album page's exact discipline, so an open feed underneath stays
 * consistent — the local slice is re-pulled afterwards.
 *
 * A momentId that resolves to nothing (deleted post, forged URL, an audience
 * the viewer is not in — `repo.getMoment` gates visibility in the driver)
 * renders a graceful empty state, never a crash: on a phone, a notification
 * tapped a week late IS this path.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { SubNav } from '../../components/SubNav';
import { useMedia } from '../../components/useMedia';
import { useAppStore } from '../../store/appStore';
import { MomentCard } from './MomentCard';
import { showConfirm } from '../../components/dialog';
import { useNow } from '../../lib/useNow';
import { repo } from '../../db/repo';
import { logError } from '../../lib/errlog';
import type { MomentVM, MomentLikeVM, MomentCommentVM } from '../../data/types';
import './moments.css';

export function MomentDetailPage() {
  const navigate = useNavigate();
  const { momentId = '' } = useParams();
  const now = useNow();

  const contacts = useAppStore((s) => s.contacts);
  const toggleLike = useAppStore((s) => s.toggleLike);
  const addComment = useAppStore((s) => s.addComment);
  const deleteMoment = useAppStore((s) => s.deleteMoment);
  const deleteComment = useAppStore((s) => s.deleteComment);

  const [moment, setMoment] = useState<MomentVM | null>(null);
  const [likes, setLikes] = useState<MomentLikeVM[]>([]);
  const [comments, setComments] = useState<MomentCommentVM[]>([]);
  const [loaded, setLoaded] = useState(false);

  // 就地评论 composer — the feed's inline composer, not a prompt dialog.
  const [composing, setComposing] = useState(false);
  const [replyTo, setReplyTo] = useState<MomentCommentVM | null>(null);
  const [draft, setDraft] = useState('');

  const reload = useCallback(async () => {
    // getMoment applies the audience gate IN THE DRIVER (M-J12): missing and
    // not-for-your-eyes are the same undefined here — the rule never lives in
    // a page (tests/unit/moment-visibility.test.ts holds that).
    const m = await repo.getMoment(momentId);
    if (!m) {
      setMoment(null);
      setLoaded(true);
      return;
    }
    setMoment(m);
    setLikes(await repo.getLikes(m.id));
    setComments(await repo.getComments(m.id));
    setLoaded(true);
  }, [momentId]);

  useEffect(() => {
    setLoaded(false);
    void reload().catch((e) => {
      logError('momentDetail.load', e);
      setLoaded(true);
    });
  }, [reload]);

  const self = contacts.find((c) => c.type === 'self');
  const byId = useMemo(() => new Map(contacts.map((c) => [c.id, c])), [contacts]);
  const nameOf = (id: string) => {
    if (id === 'self') return self ? (self.remark ?? self.name) : '我';
    const c = byId.get(id);
    return c ? (c.remark ?? c.name) : id;
  };

  useMedia(useMemo(() => moment?.imageRefs ?? [], [moment]));

  const submitComment = async () => {
    const text = draft.trim();
    if (!text || !moment) return;
    await addComment({
      id: `mc_${moment.id}_${Date.now()}`,
      momentId: moment.id,
      authorId: 'self',
      text,
      ...(replyTo ? { replyToCommentId: replyTo.id } : {}),
      createdAt: Date.now(),
    });
    setDraft('');
    setComposing(false);
    setReplyTo(null);
    await reload();
  };

  return (
    <>
      <SubNav title="详情" />
      <div className="page-body moment-detail">
        {!loaded ? null : !moment ? (
          <div className="moment-detail__empty">
            <p>这条动态不存在了</p>
            <p className="moment-detail__empty-sub">可能已被删除，或链接已过期</p>
          </div>
        ) : (
          <div className="moments__list moments__list--album">
            <MomentCard
              moment={moment}
              author={moment.authorId === 'self' ? self : byId.get(moment.authorId)}
              likes={likes}
              comments={comments}
              nameOf={nameOf}
              now={now}
              selfLiked={likes.some((l) => l.contactId === 'self')}
              onToggleLike={() =>
                void toggleLike(moment.id, 'self', Date.now()).then(() => reload())
              }
              onComment={() => {
                setReplyTo(null);
                setComposing(true);
              }}
              onReplyComment={(c) => {
                setReplyTo(c);
                setComposing(true);
              }}
              onDeleteComment={(c) => {
                void showConfirm({
                  title: '删除评论',
                  body: c.text.slice(0, 40),
                  confirmText: '删除',
                  danger: true,
                }).then((ok) => {
                  if (ok) void deleteComment(moment.id, c.id).then(() => reload());
                });
              }}
              onRepost={
                moment.authorId !== 'self'
                  ? () => navigate(`/moments/repost/${moment.id}`)
                  : undefined
              }
              onTopicTap={(tag) => navigate(`/moments/topic/${encodeURIComponent(tag)}`)}
              onAuthorTap={() => navigate(`/moments/album/${moment.authorId}`)}
              onDelete={
                moment.authorId === 'self'
                  ? () => {
                      void showConfirm({
                        title: '删除该条朋友圈',
                        body: '删除后无法恢复。',
                        confirmText: '删除',
                        danger: true,
                      }).then((ok) => {
                        if (ok) void deleteMoment(moment.id).then(() => navigate(-1));
                      });
                    }
                  : undefined
              }
            />
            {composing && (
              <div className="moments__composer">
                <input
                  autoFocus
                  value={draft}
                  placeholder={replyTo ? `回复${nameOf(replyTo.authorId)}` : '评论'}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void submitComment()}
                />
                <button onClick={() => void submitComment()}>发送</button>
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
