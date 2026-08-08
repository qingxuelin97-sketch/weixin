/**
 * Compose a Moments post: text plus an optional picture selection.
 *
 * Publishing immediately queues the AI reactions (see moments-service), so the
 * likes and comments trickle in over the following hours rather than appearing
 * all at once the moment you hit 发表.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SubNav } from '../../components/SubNav';
import { useAppStore } from '../../store/appStore';
import { availableRefs, resolveImageRef } from '../../data/moments-images';
import { scheduleReactionsFor } from '../../ai/moments-service';
import type { MomentVM } from '../../data/types';
import './moments.css';

const MAX_IMAGES = 9;

export function MomentPublishPage() {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  const addMoment = useAppStore((s) => s.addMoment);
  const contacts = useAppStore((s) => s.contacts);
  const personaFor = useAppStore((s) => s.personaFor);

  const pool = availableRefs();
  const canPost = (text.trim().length > 0 || picked.length > 0) && !busy;

  const toggle = (ref: string) =>
    setPicked((cur) =>
      cur.includes(ref)
        ? cur.filter((r) => r !== ref)
        : cur.length >= MAX_IMAGES
          ? cur
          : [...cur, ref],
    );

  const publish = async () => {
    if (!canPost) return;
    setBusy(true);
    const now = Date.now();
    const moment: MomentVM = {
      id: `mo_self_${now}`,
      authorId: 'self',
      text: text.trim() || undefined,
      imageRefs: picked,
      isNsfw: false,
      createdAt: now,
    };
    await addMoment(moment);
    // Queue who reacts and when. Failure here must not lose the post itself.
    try {
      await scheduleReactionsFor(moment, contacts, personaFor, now);
    } catch {
      /* the post stands; it just won't draw reactions this run */
    }
    navigate('/moments', { replace: true });
  };

  return (
    <div className="page publish">
      <SubNav
        title="发表"
        right={
          <button className="publish__send" disabled={!canPost} onClick={() => void publish()}>
            发表
          </button>
        }
      />
      <textarea
        className="publish__text"
        autoFocus
        placeholder="这一刻的想法…"
        value={text}
        maxLength={200}
        onChange={(e) => setText(e.target.value)}
      />

      <div className="publish__picker-label">
        选择图片（{picked.length}/{MAX_IMAGES}）
      </div>
      <div className="publish__picker">
        {pool.map((ref) => {
          const { url, background } = resolveImageRef(ref);
          const idx = picked.indexOf(ref);
          return (
            <button
              key={ref}
              className={`publish__thumb${idx >= 0 ? ' publish__thumb--on' : ''}`}
              style={background ? { background } : undefined}
              aria-pressed={idx >= 0}
              onClick={() => toggle(ref)}
            >
              {url && <img src={url} alt="" loading="lazy" />}
              {idx >= 0 && <span className="publish__badge">{idx + 1}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
