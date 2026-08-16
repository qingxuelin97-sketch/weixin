/**
 * Compose a Moments post: text, an optional picture selection, and 可见范围.
 *
 * Publishing immediately queues the AI reactions (see moments-service), so the
 * likes and comments trickle in over the following hours rather than appearing
 * all at once the moment you hit 发表.
 *
 * 可见范围 (M-I18) is chosen here but ENFORCED elsewhere — the row carries the
 * audience and `src/lib/moment-visibility.ts` is applied inside the Repo
 * drivers and the reaction planner. This page only has to record the intent
 * correctly; it is structurally incapable of being the thing that leaks.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SubNav } from '../../components/SubNav';
import { Sheet } from '../../components/Sheet';
import { Avatar } from '../../components/Avatar';
import { showActionSheet } from '../../components/dialog';
import { useAppStore } from '../../store/appStore';
import { availableRefs, resolveImageRef } from '../../data/moments-images';
import { scheduleReactionsFor } from '../../ai/moments-service';
import {
  audienceCandidates,
  audienceLabel,
  normalizeVisibility,
} from '../../lib/moment-visibility';
import { logError } from '../../lib/errlog';
import type { MomentAudience, MomentVM, MomentVisibility } from '../../data/types';
import '../settings/settings.css';
import './moments.css';

const MAX_IMAGES = 9;

/** Sheet order == WeChat's own order in 谁可以看. */
const AUDIENCE_MODES: Array<{ mode: MomentAudience; hint: string }> = [
  { mode: 'public', hint: '所有朋友都能看到' },
  { mode: 'private', hint: '仅自己可见' },
  { mode: 'include', hint: '只有选中的朋友能看到' },
  { mode: 'exclude', hint: '选中的朋友看不到' },
];

export function MomentPublishPage() {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [audience, setAudience] = useState<MomentVisibility>({ mode: 'public', ids: [] });
  const [pickingWho, setPickingWho] = useState(false);

  const addMoment = useAppStore((s) => s.addMoment);
  const showToast = useAppStore((s) => s.showToast);
  const contacts = useAppStore((s) => s.contacts);
  const personaFor = useAppStore((s) => s.personaFor);

  const pool = availableRefs();
  const canPost = (text.trim().length > 0 || picked.length > 0) && !busy;
  // Derived in the component, never in the selector — a selector returning a
  // fresh array re-renders forever (CLAUDE.md §3.5).
  const people = audienceCandidates(contacts);

  const toggle = (ref: string) =>
    setPicked((cur) =>
      cur.includes(ref)
        ? cur.filter((r) => r !== ref)
        : cur.length >= MAX_IMAGES
          ? cur
          : [...cur, ref],
    );

  const togglePerson = (id: string) =>
    setAudience((cur) => ({
      ...cur,
      ids: cur.ids.includes(id) ? cur.ids.filter((x) => x !== id) : [...cur.ids, id],
    }));

  /** 谁可以看 → mode; the two list modes then open the person picker. */
  const chooseAudience = async () => {
    const idx = await showActionSheet({
      title: '谁可以看',
      actions: AUDIENCE_MODES.map((a) => audienceLabel({ mode: a.mode, ids: [] })),
    });
    if (idx == null) return;
    const mode = AUDIENCE_MODES[idx].mode;
    // Switching between 部分可见 and 不给谁看 keeps the names already ticked —
    // "actually, hide it from these two instead" is one tap, not a re-pick.
    setAudience((cur) => ({ mode, ids: mode === 'include' || mode === 'exclude' ? cur.ids : [] }));
    if (mode === 'include' || mode === 'exclude') setPickingWho(true);
  };

  const audienceSummary = (): string => {
    if (audience.mode === 'include' || audience.mode === 'exclude') {
      const names = audience.ids
        .map((id) => contacts.find((c) => c.id === id))
        .filter((c): c is NonNullable<typeof c> => Boolean(c))
        .map((c) => c.remark ?? c.name);
      if (names.length === 0) return `${audienceLabel(audience)}（未选）`;
      const shown = names.slice(0, 2).join('、');
      return `${audienceLabel(audience)}·${shown}${names.length > 2 ? ` 等${names.length}人` : ''}`;
    }
    return audienceLabel(audience);
  };

  const publish = async () => {
    if (!canPost) return;
    setBusy(true);
    const now = Date.now();
    // Normalized on the way in, so the stored row has exactly one shape and an
    // empty whitelist can never mean 公开.
    const visibility = normalizeVisibility(audience);
    const moment: MomentVM = {
      id: `mo_self_${now}`,
      authorId: 'self',
      text: text.trim() || undefined,
      imageRefs: picked,
      isNsfw: false,
      createdAt: now,
      ...(visibility ? { visibility } : {}),
    };
    try {
      await addMoment(moment);
    } catch (e) {
      // Unguarded, a failed write left the 发表 button disabled with the text
      // still on screen and no explanation — the post looked like it was
      // mid-flight forever.
      logError('moment.publish', e);
      showToast('发表失败，请重试');
      setBusy(false);
      return;
    }
    // Queue who reacts and when. Failure here must not lose the post itself.
    try {
      await scheduleReactionsFor(moment, contacts, personaFor, now);
    } catch (e) {
      logError('moment.scheduleReactions', e); // the post stands; it just won't draw reactions
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

      <div className="settings__group publish__audience">
        <div className="settings__row" role="button" onClick={() => void chooseAudience()}>
          <span className="settings__label">谁可以看</span>
          <span className="settings__value">{audienceSummary()}</span>
          <span className="settings__chevron">›</span>
        </div>
        {audience.mode !== 'public' && (
          <div className="field">
            <span className="field__hint">
              {AUDIENCE_MODES.find((a) => a.mode === audience.mode)?.hint}
              ——她们也不会点赞或评论看不到的动态。
            </span>
          </div>
        )}
      </div>

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

      {/* The person picker is a plain Sheet (I0) rather than another hand-rolled
          overlay, so the back button closes it like every other sheet. Its rows
          come from `audienceCandidates(contacts)` — contacts, never
          conversations, which is what keeps hidden AI↔AI threads out of it. */}
      <Sheet
        open={pickingWho}
        onClose={() => setPickingWho(false)}
        title={audience.mode === 'include' ? '选择可以看的朋友' : '选择不给谁看'}
      >
        {people.length === 0 && (
          <div className="field">
            <span className="field__hint">还没有可选的朋友</span>
          </div>
        )}
        {people.map((c) => (
          <div
            key={c.id}
            className="settings__row settings__row--divided"
            role="button"
            aria-pressed={audience.ids.includes(c.id)}
            onClick={() => togglePerson(c.id)}
          >
            <span
              className={`publish__pick${audience.ids.includes(c.id) ? ' publish__pick--on' : ''}`}
            >
              {audience.ids.includes(c.id) ? '✓' : ''}
            </span>
            <Avatar color={c.avatarColor} text={c.avatarText} imageRef={c.avatarRef} size={32} />
            <span className="settings__label" style={{ marginLeft: 10 }}>
              {c.remark ?? c.name}
            </span>
          </div>
        ))}
        <button className="btn-primary" onClick={() => setPickingWho(false)}>
          完成
        </button>
      </Sheet>
    </div>
  );
}
