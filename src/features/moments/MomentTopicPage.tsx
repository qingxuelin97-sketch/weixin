/**
 * 话题聚合页 (M-I15): every post carrying `#tag#`, newest first.
 *
 * Matching uses the real topic parser (`hasTopic`), not a substring test — a
 * post that merely MENTIONS the words without the `#` marks is prose, not a
 * contribution to the topic. Reads a bounded page from the Repo: topics are a
 * recency surface, and "every post ever" is the shape that gets slower forever.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { SubNav } from '../../components/SubNav';
import { useMedia } from '../../components/useMedia';
import { useAppStore } from '../../store/appStore';
import { MomentCard } from './MomentCard';
import { showPrompt } from '../../components/dialog';
import { useNow } from '../../lib/useNow';
import { repo } from '../../db/repo';
import { hasTopic } from '../../lib/topics';
import type { MomentVM, MomentLikeVM, MomentCommentVM } from '../../data/types';
import './moments.css';

/** How far back the topic page looks. A page of feed, not an archive crawl. */
const TOPIC_SCAN_LIMIT = 200;

export function MomentTopicPage() {
  const navigate = useNavigate();
  const { tag: rawTag = '' } = useParams();
  const tag = decodeURIComponent(rawTag);
  const now = useNow();

  const contacts = useAppStore((s) => s.contacts);
  const toggleLike = useAppStore((s) => s.toggleLike);
  const addComment = useAppStore((s) => s.addComment);

  const [rows, setRows] = useState<MomentVM[]>([]);
  const [social, setSocial] = useState<{
    likes: Record<string, MomentLikeVM[]>;
    comments: Record<string, MomentCommentVM[]>;
  }>({ likes: {}, comments: {} });

  const reload = useCallback(async () => {
    const page = await repo.getMoments({ limit: TOPIC_SCAN_LIMIT });
    const hits = page.filter((m) => hasTopic(m.text, tag));
    setRows(hits);
    setSocial(await repo.getMomentSocial(hits.map((m) => m.id)));
  }, [tag]);

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

  useMedia(useMemo(() => rows.slice(0, 30).flatMap((m) => m.imageRefs ?? []), [rows]));

  const commentVia = async (m: MomentVM) => {
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
      <SubNav title={`#${tag}#`} />
      <div className="page-body moments__album">
        <div className="moments__topic-head">
          <span className="moments__topic-tag">#{tag}#</span>
          <span className="moments__topic-count">{rows.length} 条动态</span>
        </div>
        {rows.length === 0 ? (
          <p className="moments__empty">这个话题下还没有动态。</p>
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
                  // Already ON this tag's page; other tags still navigate.
                  onTopicTap={(t) =>
                    t !== tag && navigate(`/moments/topic/${encodeURIComponent(t)}`)
                  }
                  onAuthorTap={() => navigate(`/moments/album/${m.authorId}`)}
                />
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}
