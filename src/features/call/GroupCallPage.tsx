/**
 * 群语音通话 (M-J6c)。
 *
 * The single-call shell's group sibling: an avatar grid (self + up to
 * GROUP_CALL_MAX_MEMBERS AI members) with a speaking highlight, name-prefixed
 * subtitles, and the same hold-to-talk / typed-line inputs. The session is a
 * GroupCallSession owned by call-host — leaving the page keeps the call alive
 * behind MiniCallPill, and 挂断 here and on the pill are the same code path.
 *
 * Group calls are OUTGOING ONLY in this version: nobody schedules a group call
 * at you (no scheduled kind exists — adding one would need the ledger), so
 * there is no incoming/ring phase. The dial phase is a short theater beat
 * ("正在呼叫成员…"), then everyone who answers is just… there, which is how a
 * WeChat group call feels when you are the caller.
 */
import { useEffect, useRef, useState } from 'react';
import type * as React from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Avatar } from '../../components/Avatar';
import { useAppStore } from '../../store/appStore';
import { startRingback, resumeAudio } from '../../lib/sound';
import { logError } from '../../lib/errlog';
import { repo } from '../../db/repo';
import { type CallTurn } from '../../ai/call-script';
import { GroupCallSession, GROUP_CALL_MAX_MEMBERS, type GroupCallMember } from '../../ai/group-call';
import {
  adoptCall,
  useActiveCall,
  getActiveCall,
  hangupActiveCall,
  setCallMuted,
} from './call-host';
import { isAsrReady, transcribe, friendlyAsrError, AsrError } from '../../llm/asr';
import {
  isRecordingSupported,
  startRecording,
  RecorderError,
  type RecordingHandle,
} from '../../lib/recorder';
import type { NsfwTierVM } from '../../data/types';
import './call.css';

type Phase = 'dialing' | 'active' | 'ended';

const MIN_TALK_MS = 500;
const NO_SUBS: readonly CallTurn[] = [];

export function GroupCallPage() {
  const { convId = '' } = useParams();
  const navigate = useNavigate();
  const conv = useAppStore((s) => s.conversationById(convId));
  const contactById = useAppStore((s) => s.contactById);
  const personaFor = useAppStore((s) => s.personaFor);
  const appendMessage = useAppStore((s) => s.appendMessage);
  const showToast = useAppStore((s) => s.showToast);
  const me = contactById('self');

  // Same resume rule as CallPage: a live call for THIS conv means the page
  // remounted over it (back from the pill) — bind, don't re-dial.
  const resumed = getActiveCall()?.convId === convId;
  const [phase, setPhase] = useState<Phase>(() => (resumed ? 'active' : 'dialing'));
  const [seconds, setSeconds] = useState(() =>
    resumed ? Math.max(0, Math.floor((Date.now() - getActiveCall()!.connectedAt) / 1000)) : 0,
  );
  const finished = useRef(false);

  const live = useActiveCall();
  const subs: readonly CallTurn[] = live?.convId === convId ? live.subs : NO_SUBS;
  const speakingId = live?.convId === convId ? live.speakingId : null;
  const voiceOn: boolean | null = live?.convId === convId ? live.voiceOn : null;
  const muted = live?.convId === convId ? live.muted : false;
  const [asrOk, setAsrOk] = useState<boolean | null>(null);
  const [talkHeld, setTalkHeld] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [textDraft, setTextDraft] = useState('');
  const subsRef = useRef<HTMLDivElement>(null);

  // The AI members on the call (bounded). Personas can be missing for freshly
  // imported contacts — those members simply "didn't pick up".
  const members: GroupCallMember[] = (conv?.memberIds ?? [])
    .map((id) => {
      const contact = contactById(id);
      const persona = personaFor(id);
      return contact && persona ? { contact, persona } : null;
    })
    .filter((m): m is GroupCallMember => m !== null)
    .slice(0, GROUP_CALL_MAX_MEMBERS);

  // Short dial theater, then connected. UI timer, not world state.
  useEffect(() => {
    if (phase !== 'dialing') return;
    const stopRing = startRingback();
    const t = setTimeout(() => setPhase('active'), 1600 + Math.random() * 1200);
    return () => {
      stopRing();
      clearTimeout(t);
    };
  }, [phase]);

  useEffect(() => {
    if (phase !== 'active') return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  // Connected → adopt a GroupCallSession (unless the pill brought us back).
  useEffect(() => {
    if (phase !== 'active' || !conv || members.length === 0) return;
    let dead = false;
    resumeAudio();
    void isAsrReady()
      .then((ok) => {
        if (!dead) setAsrOk(ok && isRecordingSupported());
      })
      .catch(() => {
        if (!dead) setAsrOk(false);
      });
    void (async () => {
      try {
        if (getActiveCall()?.convId === convId) return;
        const globalTier = (await repo.getSetting<NsfwTierVM>('nsfwGlobalTier')) ?? 'off';
        const recent = await repo.getMessages(convId, { limit: 24 });
        if (dead) return;
        adoptCall({
          convId,
          peerId: '',
          peerName: conv.title,
          direction: 'out',
          group: true,
          now: () => Date.now(),
          makeSession: (ui) =>
            new GroupCallSession({
              convId,
              title: conv.title,
              members,
              globalTier,
              recent,
              now: () => Date.now(),
              ...ui,
            }),
        });
      } catch (e) {
        logError('groupcall.session', e);
      }
    })();
    return () => {
      dead = true;
    };
    // Session identity is the call, not the render (same rule as CallPage).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  useEffect(() => {
    const el = subsRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [subs, speakingId]);

  const hangUp = async () => {
    if (finished.current) return;
    finished.current = true;
    setPhase('ended');
    if (getActiveCall()?.convId === convId) {
      void hangupActiveCall();
    } else {
      // Abandoned during the dial beat — record the attempt like a missed call.
      try {
        await appendMessage({
          convId,
          senderId: 'self',
          type: 'call',
          content: '已取消',
          meta: { direction: 'out' },
          status: 'sent',
          createdAt: Date.now(),
        });
      } catch (e) {
        logError('groupcall.record', e);
      }
    }
    setTimeout(() => navigate(-1), 400);
  };

  /* ---- 按住说话（与 CallPage 同构；入站 ASR 闸用全场最严 tier） ---- */
  const holdRef = useRef<{
    id: number;
    handle: RecordingHandle | null;
    startedAt: number;
    done: boolean;
  } | null>(null);

  const finishTalk = async (p: NonNullable<typeof holdRef.current>) => {
    if (p.done) return;
    p.done = true;
    if (holdRef.current === p) holdRef.current = null;
    setTalkHeld(false);
    const handle = p.handle;
    if (!handle) return;
    if (Date.now() - p.startedAt < MIN_TALK_MS) {
      handle.cancel();
      showToast('说话时间太短');
      return;
    }
    setTranscribing(true);
    try {
      const clip = await handle.stop();
      const text = await transcribe(clip, { tier: getActiveCall()?.session.tier ?? 'off' });
      setTranscribing(false);
      if (text) void getActiveCall()?.session.userSaid(text).catch(() => {});
      else showToast('没有听清');
    } catch (err) {
      setTranscribing(false);
      if (!(err instanceof AsrError && err.kind === 'aborted')) showToast(friendlyAsrError(err));
    }
  };

  const onTalkDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (holdRef.current || transcribing) return;
    getActiveCall()?.session.holdFloor();
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort */
    }
    const p = {
      id: e.pointerId,
      handle: null as RecordingHandle | null,
      startedAt: Date.now(),
      done: false,
    };
    holdRef.current = p;
    setTalkHeld(true);
    void startRecording({ maxMs: 60_000, onAutoStop: () => void finishTalk(p) })
      .then((h) => {
        if (holdRef.current !== p || p.done) {
          h.cancel();
          return;
        }
        p.handle = h;
        p.startedAt = Date.now();
      })
      .catch((err) => {
        if (holdRef.current === p) {
          holdRef.current = null;
          setTalkHeld(false);
          p.done = true;
        }
        showToast(err instanceof RecorderError ? err.message : '录音启动失败');
      });
  };

  const onTalkUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const p = holdRef.current;
    if (p && e.pointerId === p.id) void finishTalk(p);
  };

  const onTalkCancel = (e: React.PointerEvent<HTMLButtonElement>) => {
    const p = holdRef.current;
    if (!p || e.pointerId !== p.id) return;
    p.done = true;
    p.handle?.cancel();
    holdRef.current = null;
    setTalkHeld(false);
  };

  const sendTypedLine = () => {
    const t = textDraft.trim();
    if (!t) return;
    setTextDraft('');
    void getActiveCall()?.session.userSaid(t).catch(() => {});
  };

  const mmss = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

  // 隐藏会话闸（台账 'filters'）：AI↔AI 私信都是 single 型，本来就进不来；
  // isHidden 再拦一道，哪天真出现隐藏群也漏不出去。
  if (!conv || conv.type !== 'group' || conv.isHidden) {
    return (
      <div className="call-page">
        <div className="call-page__status">群聊不存在</div>
      </div>
    );
  }

  const nameOf = (id?: string) =>
    id ? (contactById(id)?.remark ?? contactById(id)?.name ?? 'TA') : 'TA';

  return (
    <div className="call-page call-page--group">
      <div className="call-page__id">
        <div className="call-page__name">{conv.title}</div>
        <div className="call-page__status">
          {phase === 'dialing' ? '正在呼叫成员…' : phase === 'active' ? mmss : '通话已结束'}
        </div>
      </div>

      <div className="gcall-grid" role="list">
        {me && (
          <div className="gcall-cell" role="listitem">
            <Avatar color={me.avatarColor} text={me.avatarText} imageRef={me.avatarRef} size={64} />
            <span className="gcall-cell__name">我</span>
          </div>
        )}
        {members.map((m) => (
          <div
            key={m.contact.id}
            className={`gcall-cell${speakingId === m.contact.id ? ' gcall-cell--speaking' : ''}`}
            role="listitem"
          >
            <Avatar
              color={m.contact.avatarColor}
              text={m.contact.avatarText}
              imageRef={m.contact.avatarRef}
              size={64}
            />
            <span className="gcall-cell__name">{m.contact.remark ?? m.contact.name}</span>
          </div>
        ))}
      </div>

      {phase === 'active' && (
        <div className="call-live">
          {voiceOn === false && <div className="call-live__mode">字幕模式 · 未配置语音或当前分级不出声</div>}
          <div className="call-subs" ref={subsRef} aria-live="polite">
            {subs.map((t, i) => (
              <div
                key={`${t.at}-${i}`}
                className={`call-subs__line${t.speaker === 'self' ? ' call-subs__line--self' : ''}`}
              >
                {t.speaker === 'self' ? t.text : `${t.speakerName ?? nameOf(t.speakerId)}：${t.text}`}
              </div>
            ))}
            {speakingId && (
              <div className="call-subs__line call-subs__line--speaking" aria-label="有人正在说话">
                <span className="call-subs__dot" />
                <span className="call-subs__dot" />
                <span className="call-subs__dot" />
              </div>
            )}
          </div>
          {asrOk ? (
            <button
              className={`call-talk${talkHeld ? ' call-talk--held' : ''}`}
              disabled={transcribing}
              onPointerDown={onTalkDown}
              onPointerUp={onTalkUp}
              onPointerCancel={onTalkCancel}
              onContextMenu={(e) => e.preventDefault()}
            >
              {transcribing ? '识别中…' : talkHeld ? '松开 说完了' : '按住 说话'}
            </button>
          ) : (
            <div className="call-talk-input">
              <input
                value={textDraft}
                placeholder="打字说话…"
                onChange={(e) => setTextDraft(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && sendTypedLine()}
              />
              <button onClick={sendTypedLine} aria-label="说">
                说
              </button>
            </div>
          )}
        </div>
      )}

      <div className="call-page__controls">
        {phase === 'active' && voiceOn && (
          <div className="call-page__ctrl">
            <button
              className={`call-page__btn call-page__btn--mute${muted ? ' call-page__btn--mute-on' : ''}`}
              aria-label={muted ? '取消静音' : '静音'}
              onClick={() => setCallMuted(!muted)}
            >
              <GMuteIcon on={muted} />
            </button>
            <span className="call-page__hint">{muted ? '已静音' : '静音'}</span>
          </div>
        )}
        <div className="call-page__ctrl">
          <button
            className="call-page__btn call-page__btn--hangup"
            aria-label="挂断"
            onClick={() => void hangUp()}
          >
            <GHandsetIcon />
          </button>
          <span className="call-page__hint">{phase === 'dialing' ? '取消' : '挂断'}</span>
        </div>
        {phase === 'active' && (
          <div className="call-page__ctrl">
            <button
              className="call-page__btn call-page__btn--minimize"
              aria-label="最小化"
              onClick={() => navigate(-1)}
            >
              <GMinimizeIcon />
            </button>
            <span className="call-page__hint">收起</span>
          </div>
        )}
      </div>
    </div>
  );
}

function GMuteIcon({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden>
      <path
        d="M6 12h5l7-6v20l-7-6H6a1.5 1.5 0 0 1-1.5-1.5v-5A1.5 1.5 0 0 1 6 12z"
        fill="currentColor"
      />
      {!on && (
        <path
          d="M22 12a6 6 0 0 1 0 8M25 9a10 10 0 0 1 0 14"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
        />
      )}
      {on && (
        <path d="M5 27 27 5" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" />
      )}
    </svg>
  );
}

function GMinimizeIcon() {
  return (
    <svg viewBox="0 0 32 32" width="26" height="26" aria-hidden>
      <path
        d="M19 5h8v8M27 5 17 15M13 27H5v-8M5 27l10-10"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function GHandsetIcon() {
  return (
    <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden>
      <path
        d="M16 13c-4.5 0-8.6 1.5-11.6 4a2.5 2.5 0 0 0-.4 3.4l1.5 2c.7.9 2 1.1 3 .5l3-1.9c.7-.5 1.1-1.3 1-2.1l-.2-1.8a17 17 0 0 1 7.4 0l-.2 1.8c-.1.8.3 1.6 1 2.1l3 1.9c1 .6 2.3.4 3-.5l1.5-2a2.5 2.5 0 0 0-.4-3.4c-3-2.5-7.1-4-11.6-4z"
        fill="currentColor"
      />
    </svg>
  );
}
