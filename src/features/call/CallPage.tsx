/**
 * Voice-call shell (M5-D2, M-I10). Phases: incoming → active → ended, or
 * dialing → active → ended.
 *
 * There is no real audio underneath — the theater is the point: the peer
 * "answers" after a few seconds, a timer runs, and hanging up drops a call
 * record bubble into the conversation (duration for answered, 已取消/未接听 for
 * aborted), which is exactly the trace a real call leaves in WeChat.
 *
 * M-I10 adds the INCOMING side: the native full-screen call notification deep
 * links here as /call/:convId?incoming=1 (ringing, 接听/拒绝) or &accept=1
 * (the notification's 接听 action — straight to active). Declining leaves the
 * missed-call record whose projection ('[对方打来语音通话，未接通]') existed
 * since M5 with zero producers.
 */
import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { Avatar } from '../../components/Avatar';
import { useAppStore } from '../../store/appStore';
import { startRingback } from '../../lib/sound';
import { logError } from '../../lib/errlog';
import { cancelNotify } from '../../native/bridge';
import { callNotifId } from '../../native/background-notify';
import './call.css';

type Phase = 'incoming' | 'dialing' | 'active' | 'ended';

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
  const appendMessage = useAppStore((s) => s.appendMessage);
  const peer = conv?.peerId ? contactById(conv.peerId) : undefined;

  const [phase, setPhase] = useState<Phase>(() =>
    incoming ? (autoAccept ? 'active' : 'incoming') : 'dialing',
  );
  const [seconds, setSeconds] = useState(0);
  const connectedAt = useRef<number | null>(autoAccept ? Date.now() : null);
  const finished = useRef(false);

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

  /** Persist the call record. Incoming records sit on the peer's side. */
  const recordCall = async (durationMs: number | undefined, missedLabel: string) => {
    try {
      await appendMessage({
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
    const durationMs = connectedAt.current ? Date.now() - connectedAt.current : undefined;
    await recordCall(durationMs, incoming ? '未接听' : '已取消');
    setTimeout(() => navigate(-1), 400);
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
          <button className="call-page__btn call-page__btn--hangup" aria-label="挂断" onClick={() => void hangUp()}>
            <HandsetIcon />
          </button>
          <span className="call-page__hint">{phase === 'dialing' ? '取消' : '挂断'}</span>
        </div>
      )}
    </div>
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
