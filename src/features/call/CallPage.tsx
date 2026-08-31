/**
 * Voice-call shell (M5-D2, M-I10, M-I16). Phases: incoming → active → ended, or
 * dialing → active → ended.
 *
 * M5 shipped pure theater — a timer between 接通 and 挂断. M-I16 fills the
 * middle: once connected a CallSession (src/ai/call-script.ts) generates her
 * opening line and per-utterance replies, spoken via TTS when configured and
 * shown as subtitles always (subtitle-only when TTS is absent or the NSFW full
 * tier forbids speech). You answer by holding 按住说话 (I9's ASR) or, without
 * ASR, through a text bar. Hanging up leaves ONE type:'call' record whose meta
 * carries duration + a one-line summary; promises made on the phone land in
 * conv-state so later chats can refer to them. Call turns themselves are never
 * chat messages — WeChat calls leave no transcript.
 *
 * M-I10's INCOMING side stays as was: the native full-screen call notification
 * deep links here as /call/:convId?incoming=1 (ringing, 接听/拒绝) or &accept=1.
 */
import { useEffect, useRef, useState } from 'react';
import type * as React from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { Avatar } from '../../components/Avatar';
import { useAppStore } from '../../store/appStore';
import { startRingback, resumeAudio } from '../../lib/sound';
import { logError } from '../../lib/errlog';
import { cancelNotify } from '../../native/bridge';
import { callNotifId } from '../../native/background-notify';
import { repo } from '../../db/repo';
import { type CallTurn } from '../../ai/call-script';
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
import type { MessageVM, NsfwTierVM } from '../../data/types';
import './call.css';

type Phase = 'incoming' | 'dialing' | 'active' | 'ended';

/** Presses shorter than this are accidental taps, same floor as hold-to-talk. */
const MIN_TALK_MS = 500;

/** Stable empty subtitle list (the zustand-selector lesson, applied here). */
const NO_SUBS: readonly CallTurn[] = [];

export function CallPage() {
  const { convId = '' } = useParams();
  const [params] = useSearchParams();
  // Two producers, one shell: the in-app ring overlay navigates `?in=1` after
  // the user already tapped 接听 (M-H1, opens connected), while the native
  // full-screen notification deep-links `?incoming=1[&accept=1]` (M-I10,
  // opens on the ring phase unless the notification's 接听 was tapped).
  const answeredInApp = params.get('in') === '1';
  const incoming = answeredInApp || params.get('incoming') === '1';
  const autoAccept = answeredInApp || params.get('accept') === '1';
  const navigate = useNavigate();
  const conv = useAppStore((s) => s.conversationById(convId));
  const contactById = useAppStore((s) => s.contactById);
  const personaFor = useAppStore((s) => s.personaFor);
  const appendMessage = useAppStore((s) => s.appendMessage);
  const showToast = useAppStore((s) => s.showToast);
  const peer = conv?.peerId ? contactById(conv.peerId) : undefined;
  const persona = conv?.peerId ? personaFor(conv.peerId) : undefined;

  // Returning from the pill (M-J6): the call kept running while this page was
  // gone, so mounting over a live call for THIS conversation opens connected —
  // no re-ring, no re-dial, and above all no second session.
  const resumed = getActiveCall()?.convId === convId;
  const [phase, setPhase] = useState<Phase>(() =>
    resumed ? 'active' : incoming ? (autoAccept ? 'active' : 'incoming') : 'dialing',
  );
  const [seconds, setSeconds] = useState(() =>
    resumed ? Math.max(0, Math.floor((Date.now() - getActiveCall()!.connectedAt) / 1000)) : 0,
  );
  const connectedAt = useRef<number | null>(
    resumed ? getActiveCall()!.connectedAt : autoAccept ? Date.now() : null,
  );
  const finished = useRef(false);

  // ---- 通话中对话 (M-I16 → M-J6: the session lives in call-host now) ----
  const live = useActiveCall();
  // Module-level constant, not [] inline: the subtitle autoscroll effect keys
  // on `subs`, and a fresh empty array every render would re-fire it forever.
  const subs: readonly CallTurn[] = live?.convId === convId ? live.subs : NO_SUBS;
  const speaking = live?.convId === convId ? live.speaking : false;
  const voiceOn: boolean | null = live?.convId === convId ? live.voiceOn : null;
  const muted = live?.convId === convId ? live.muted : false;
  const [asrOk, setAsrOk] = useState<boolean | null>(null);
  const [talkHeld, setTalkHeld] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [textDraft, setTextDraft] = useState('');
  const subsRef = useRef<HTMLDivElement>(null);

  // Whatever brought us here, the shade's call notification is now redundant.
  useEffect(() => {
    if (incoming) void cancelNotify(callNotifId(convId));
  }, [incoming, convId]);

  // The peer answers after 3–6s of ringing. UI-side timers, not world state —
  // nothing here persists or replays, so the scheduler rule doesn't apply.
  useEffect(() => {
    if (phase !== 'dialing') return;
    // A silent dial reads as broken — ringback runs exactly while dialing.
    const stopRing = startRingback();
    const t = setTimeout(() => {
      connectedAt.current = Date.now();
      setPhase('active');
    }, 3000 + Math.random() * 3000);
    return () => {
      stopRing();
      clearTimeout(t);
    };
  }, [phase]);

  // Incoming ring: same tone, but SHE is waiting on YOU — no auto-answer.
  useEffect(() => {
    if (phase !== 'incoming') return;
    const stopRing = startRingback();
    return stopRing;
  }, [phase]);

  useEffect(() => {
    if (phase !== 'active') return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  // Connected → spin up the dialogue session. Cleanup ends it (leaving the
  // page IS hanging up — a call must never keep talking to an empty room).
  useEffect(() => {
    if (phase !== 'active' || !conv || !peer || !persona) return;
    let dead = false;
    // AudioContext trap: Android re-suspends it on every background stint and
    // resume() is async — re-arm before any playback window is scheduled.
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
        // Already owned (returned from the pill) → nothing to create.
        if (getActiveCall()?.convId === convId) return;
        const globalTier = (await repo.getSetting<NsfwTierVM>('nsfwGlobalTier')) ?? 'off';
        const recent = await repo.getMessages(convId, { limit: 20 });
        if (dead) return;
        adoptCall({
          convId,
          peerId: peer.id,
          peerName: peer.remark ?? peer.name,
          direction: incoming ? 'in' : 'out',
          sessionOpts: {
            convId,
            peer,
            persona,
            globalTier,
            direction: incoming ? 'in' : 'out',
            recent,
            now: () => Date.now(),
          },
        });
      } catch (e) {
        logError('call.session', e);
      }
    })();
    return () => {
      // Leaving the page is NOT hanging up any more (M-J6): the session lives
      // in call-host and keeps talking; MiniCallPill represents it until 挂断.
      dead = true;
    };
    // Session identity is the CALL, not the render: peer/persona are stable for
    // a mounted call page, and restarting the session on a re-render would
    // interrupt her mid-sentence.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // Subtitles stay pinned to the newest line.
  useEffect(() => {
    const el = subsRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [subs, speaking]);

  /** Persist the call record. Incoming records sit on the peer's side. */
  const recordCall = async (
    durationMs: number | undefined,
    missedLabel: string,
  ): Promise<MessageVM | null> => {
    try {
      return await appendMessage({
        convId,
        senderId: incoming ? (conv?.peerId ?? 'self') : 'self',
        type: 'call',
        content: durationMs == null ? missedLabel : undefined,
        meta:
          durationMs == null
            ? { direction: incoming ? 'in' : 'out' }
            : { direction: incoming ? 'in' : 'out', durationMs },
        status: 'sent',
        createdAt: Date.now(),
      });
    } catch (e) {
      // Losing the call record is bad; being unable to leave a full-screen call
      // is worse. Ending must always end with the user off this screen.
      logError('call.record', e);
      return null;
    }
  };

  const accept = () => {
    connectedAt.current = Date.now();
    setPhase('active');
  };

  const decline = async () => {
    if (finished.current) return;
    finished.current = true;
    setPhase('ended');
    await recordCall(undefined, '未接听');
    setTimeout(() => navigate(-1), 400);
  };

  const hangUp = async () => {
    if (finished.current) return;
    finished.current = true;
    setPhase('ended');
    if (getActiveCall()?.convId === convId) {
      // The host writes the call record + summary stamp — the pill's 挂断 and
      // this button are the SAME code path (M-J6), so the record is once-only.
      void hangupActiveCall();
    } else {
      // Never connected (dialing was abandoned before the session existed).
      await recordCall(undefined, incoming ? '未接听' : '已取消');
    }
    setTimeout(() => navigate(-1), 400);
  };

  /* ---- 按住说话 (hold-to-talk over I9's ASR) ---- */
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
    if (!handle) return; // lifted before the mic opened — a tap
    if (Date.now() - p.startedAt < MIN_TALK_MS) {
      handle.cancel();
      showToast('说话时间太短');
      return;
    }
    setTranscribing(true);
    try {
      const clip = await handle.stop();
      // 铁律 6 入站面 (M-I18): this call's tier decides whether the user's
      // own speech may be uploaded at all. Full tier + an endpoint the user
      // has not marked permissive → refuse, and the toast says to type.
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
    // Barge-in (M-J6): she shuts up the INSTANT your finger lands — not after
    // you release, wait out an ASR round-trip and userSaid finally aborts her.
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
    // The system stole the gesture — a mic nobody can release must not stay hot.
    p.done = true;
    p.handle?.cancel();
    holdRef.current = null;
    setTalkHeld(false);
  };

  /** No-ASR fallback: type a line into the call. */
  const sendTypedLine = () => {
    const t = textDraft.trim();
    if (!t) return;
    setTextDraft('');
    void getActiveCall()?.session.userSaid(t).catch(() => {});
  };

  const mmss = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

  if (!conv || !peer) {
    return (
      <div className="call-page">
        <div className="call-page__status">会话不存在</div>
      </div>
    );
  }

  const statusLine =
    phase === 'incoming'
      ? '邀请你语音通话…'
      : phase === 'dialing'
        ? '正在等待对方接受邀请…'
        : phase === 'active'
          ? mmss
          : '通话已结束';

  return (
    <div className="call-page">
      <div className="call-page__id">
        <Avatar color={peer.avatarColor} text={peer.avatarText} imageRef={peer.avatarRef} size={88} />
        <div className="call-page__name">{peer.remark ?? peer.name}</div>
        <div className="call-page__status">{statusLine}</div>
      </div>

      {phase === 'active' && persona && (
        <div className="call-live">
          {voiceOn === false && <div className="call-live__mode">字幕模式 · 未配置语音或当前分级不出声</div>}
          <div className="call-subs" ref={subsRef} aria-live="polite">
            {subs.map((t, i) => (
              <div
                key={`${t.at}-${i}`}
                className={`call-subs__line${t.speaker === 'self' ? ' call-subs__line--self' : ''}`}
              >
                {t.text}
              </div>
            ))}
            {speaking && (
              <div className="call-subs__line call-subs__line--speaking" aria-label="对方正在说话">
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

      {phase === 'incoming' ? (
        <div className="call-page__controls call-page__controls--incoming">
          <div className="call-page__ctrl">
            <button
              className="call-page__btn call-page__btn--hangup"
              aria-label="拒绝"
              onClick={() => void decline()}
            >
              <HandsetIcon />
            </button>
            <span className="call-page__hint">拒绝</span>
          </div>
          <div className="call-page__ctrl">
            <button className="call-page__btn call-page__btn--accept" aria-label="接听" onClick={accept}>
              <HandsetIcon />
            </button>
            <span className="call-page__hint">接听</span>
          </div>
        </div>
      ) : (
        <div className="call-page__controls">
          {phase === 'active' && voiceOn && (
            <div className="call-page__ctrl">
              <button
                className={`call-page__btn call-page__btn--mute${muted ? ' call-page__btn--mute-on' : ''}`}
                aria-label={muted ? '取消静音' : '静音'}
                onClick={() => setCallMuted(!muted)}
              >
                <MuteIcon on={muted} />
              </button>
              <span className="call-page__hint">{muted ? '已静音' : '静音'}</span>
            </div>
          )}
          <div className="call-page__ctrl">
            <button className="call-page__btn call-page__btn--hangup" aria-label="挂断" onClick={() => void hangUp()}>
              <HandsetIcon />
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
                <MinimizeIcon />
              </button>
              <span className="call-page__hint">收起</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MuteIcon({ on }: { on: boolean }) {
  // Simple hand-drawn speaker glyph; the slash appears when muted. Zero PNG.
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
        <path
          d="M5 27 27 5"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.6"
          strokeLinecap="round"
        />
      )}
    </svg>
  );
}

function MinimizeIcon() {
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

function HandsetIcon() {
  return (
    <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden>
      <path
        d="M16 13c-4.5 0-8.6 1.5-11.6 4a2.5 2.5 0 0 0-.4 3.4l1.5 2c.7.9 2 1.1 3 .5l3-1.9c.7-.5 1.1-1.3 1-2.1l-.2-1.8a17 17 0 0 1 7.4 0l-.2 1.8c-.1.8.3 1.6 1 2.1l3 1.9c1 .6 2.3.4 3-.5l1.5-2a2.5 2.5 0 0 0-.4-3.4c-3-2.5-7.1-4-11.6-4z"
        fill="currentColor"
      />
    </svg>
  );
}
