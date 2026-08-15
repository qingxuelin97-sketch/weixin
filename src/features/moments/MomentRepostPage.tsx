/**
 * 转发动态 (M-I15): your words on top, the quoted original underneath.
 *
 * The quote preview here and the stored snapshot are BOTH derived from the
 * moment row as read from storage — the page never accepts quote text from
 * navigation state or props, so there is no route by which content that never
 * entered the public feed (hidden AI↔AI conversations above all) could ride a
 * repost onto it. See src/ai/moment-repost.ts for the full leak rule.
 */
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { SubNav } from '../../components/SubNav';
import { useAppStore } from '../../store/appStore';
import { repo } from '../../db/repo';
import { repostMoment, repostExcerpt, canRepost } from '../../ai/moment-repost';
import { scheduleReactionsFor } from '../../ai/moments-service';
import { logError } from '../../lib/errlog';
import type { MomentVM } from '../../data/types';
import './moments.css';

export function MomentRepostPage() {
  const navigate = useNavigate();
  const { momentId = '' } = useParams();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<MomentVM | null | 'loading'>('loading');

  const addMoment = useAppStore((s) => s.addMoment);
  const showToast = useAppStore((s) => s.showToast);
  const contacts = useAppStore((s) => s.contacts);
  const contactById = useAppStore((s) => s.contactById);
  const personaFor = useAppStore((s) => s.personaFor);

  // From storage, by id — the same read the publisher will repeat.
  useEffect(() => {
    void repo
      .getMoment(momentId)
      .then((m) => setSource(canRepost(m ?? null) ? (m as MomentVM) : null))
      .catch(() => setSource(null));
  }, [momentId]);

  const rootAuthorId =
    source && source !== 'loading' ? (source.repostOf ? source.repostAuthorId : source.authorId) : undefined;
  const rootAuthor = rootAuthorId ? contactById(rootAuthorId) : undefined;
  const excerpt =
    source && source !== 'loading'
      ? source.repostOf
        ? (source.repostExcerpt ?? '[动态]')
        : repostExcerpt(source)
      : '';

  const canPost = source != null && source !== 'loading' && !busy;

  const publish = async () => {
    if (!canPost) return;
    setBusy(true);
    const now = Date.now();
    let posted: MomentVM | null = null;
    try {
      // The service re-reads the source by id: a post deleted while this page
      // was open publishes nothing rather than quoting a ghost.
      posted = await repostMoment(
        momentId,
        { authorId: 'self', text, now },
        { getMoment: (id) => repo.getMoment(id), addMoment },
      );
    } catch (e) {
      logError('moment.repost', e);
    }
    if (!posted) {
      showToast('转发失败，原动态可能已删除');
      setBusy(false);
      return;
    }
    // Reposts draw reactions like any other post. Failure must not lose it.
    try {
      await scheduleReactionsFor(posted, contacts, personaFor, now);
    } catch (e) {
      logError('moment.repost.reactions', e);
    }
    navigate('/moments', { replace: true });
  };

  return (
    <div className="page publish">
      <SubNav
        title="转发"
        right={
          <button className="publish__send" disabled={!canPost} onClick={() => void publish()}>
            发表
          </button>
        }
      />
      <textarea
        className="publish__text"
        autoFocus
        placeholder="说点什么…（可以留空）"
        value={text}
        maxLength={200}
        onChange={(e) => setText(e.target.value)}
      />
      {source === 'loading' ? null : source ? (
        <div className="moment__repost publish__repost-preview">
          <span className="moment__repost-author">
            {rootAuthor ? (rootAuthor.remark ?? rootAuthor.name) : '朋友'}
          </span>
          <span>：{excerpt}</span>
        </div>
      ) : (
        <p className="moments__empty">原动态不存在或已删除，无法转发。</p>
      )}
    </div>
  );
}
