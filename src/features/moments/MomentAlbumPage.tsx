/**
 * 个人相册页 (M-I15, closing the I6 leftover): one person's whole Moments
 * timeline — theirs or your own — reachable by tapping an author name in the
 * feed or from a profile.
 *
 * The feed store only holds the newest page, so this page reads its rows from
 * the Repo directly and keeps its own social-rows slice. Interactions still go
 * THROUGH the store (toggleLike / addComment / deleteMoment), so an open feed
 * behind this page stays consistent; the local slice is re-pulled afterwards.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { SubNav } from '../../components/SubNav';
import { useMedia } from '../../components/useMedia';
import { useAppStore } from '../../store/appStore';
import { MomentCard } from './MomentCard';
import { showConfirm, showPrompt } from '../../components/dialog';
import { useNow } from '../../lib/useNow';
import { repo } from '../../db/repo';
import type { MomentVM, MomentLikeVM, MomentCommentVM } from '../../data/types';
import './moments.css';

type Social = {
  likes: Record<string, MomentLikeVM[]>;
  comments: Record<string, MomentCommentVM[]>;
};

export function MomentAlbumPage() {
  const navigate = useNavigate();
  const { contactId = '' } = useParams();
  const now = useNow();

  const contacts = useAppStore((s) => s.contacts);
  const toggleLike = useAppStore((s) => s.toggleLike);
  const addComment = useAppStore((s) => s.addComment);
  const deleteMoment = useAppStore((s) => s.deleteMoment);
  const deleteComment = useAppStore((s) => s.deleteComment);

  const [rows, setRows] = useState<MomentVM[]>([]);
  const [social, setSocial] = useState<Social>({ likes: {}, comments: {} });

  const reload = useCallback(async () => {
    const ms = await repo.getMomentsByAuthor(contactId);
    setRows(ms);
    setSocial(await repo.getMomentSocial(ms.map((m) => m.id)));
  }, [contactId]);

  useEffect(() => {
    void reload().catch(() => {});
  }, [reload]);

  const self = contacts.find((c) => c.type === 'self');
  const byId = useMemo(() => new Map(contacts.map((c) => [c.id, c])), [contacts]);
  const nameOf = (id: string) => {
    if (id === 'self') return self ? (self.remark ?? self.name) : '我';
    const c = byId.get(id);
    return c ? (c.remark ?? c.name) : id;
  };
  const owner = contactId === 'self' ? self : byId.get(contactId);

  useMedia(useMemo(() => rows.slice(0, 30).flatMap((m) => m.imageRefs ?? []), [rows]));

  const commentVia = async (m: MomentVM) => {
    // The imperative prompt keeps this page free of a second composer clone.
    const text = await showPrompt({ title: '评论', placeholder: '说点什么…' });
    if (!text?.trim()) return;
    await addComment({
      id: `mc_${m.id}_${Date.now()}`,
      momentId: m.id,
      authorId: 'self',
      text: text.trim(),
      createdAt: Date.now(),
    });
    await reload();
  };

  return (
    <>
      <SubNav title={owner ? `${owner.remark ?? owner.name}的朋友圈` : '朋友圈'} />
      <div className="page-body moments__album">
        {rows.length === 0 ? (
          <p className="moments__empty">
            {contactId === 'self' ? '你还没发过朋友圈。' : 'TA 还没发过朋友圈。'}
          </p>
        ) : (
          <div className="moments__list moments__list--album">
            {rows.map((m) => {
              const likes = social.likes[m.id] ?? [];
              return (
                <MomentCard
                  key={m.id}
                  moment={m}
                  author={m.authorId === 'self' ? self : byId.get(m.authorId)}
                  likes={likes}
                  comments={social.comments[m.id] ?? []}
                  nameOf={nameOf}
                  now={now}
                  selfLiked={likes.some((l) => l.contactId === 'self')}
                  onToggleLike={() =>
                    void toggleLike(m.id, 'self', Date.now()).then(() => reload())
                  }
                  onComment={() => void commentVia(m)}
                  onDeleteComment={(c) => {
                    void showConfirm({
                      title: '删除评论',
                      body: c.text.slice(0, 40),
                      confirmText: '删除',
                      danger: true,
                    }).then((ok) => {
                      if (ok) void deleteComment(m.id, c.id).then(() => reload());
                    });
                  }}
                  onRepost={
                    m.authorId !== 'self'
                      ? () => navigate(`/moments/repost/${m.id}`)
                      : undefined
                  }
                  onTopicTap={(tag) => navigate(`/moments/topic/${encodeURIComponent(tag)}`)}
                  onDelete={
                    m.authorId === 'self'
                      ? () => {
                          void showConfirm({
                            title: '删除该条朋友圈',
                            body: '删除后无法恢复。',
                            confirmText: '删除',
                            danger: true,
                          }).then((ok) => {
                            if (ok) void deleteMoment(m.id).then(() => reload());
                          });
                        }
                      : undefined
                  }
                />
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
