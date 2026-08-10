/**
 * Voice-call shell (M5-D2). Three states: dialing → active → ended.
 *
 * There is no real audio underneath — the theater is the point: the peer
 * "answers" after a few seconds, a timer runs, and hanging up drops a call
 * record bubble into the conversation (duration for answered, 已取消 for
 * aborted dials), which is exactly the trace a real call leaves in WeChat.
 */
import { useEffect, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Avatar } from '../../components/Avatar';
import { useAppStore } from '../../store/appStore';
import { startRingback } from '../../lib/sound';
import { logError } from '../../lib/errlog';
import './call.css';

type Phase = 'dialing' | 'active' | 'ended';

export function CallPage() {
  const { convId = '' } = useParams();
  const navigate = useNavigate();
  const conv = useAppStore((s) => s.conversationById(convId));
  const contactById = useAppStore((s) => s.contactById);
  const appendMessage = useAppStore((s) => s.appendMessage);
  const peer = conv?.peerId ? contactById(conv.peerId) : undefined;

  const [phase, setPhase] = useState<Phase>('dialing');
  const [seconds, setSeconds] = useState(0);
  const connectedAt = useRef<number | null>(null);
  const finished = useRef(false);

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

  useEffect(() => {
    if (phase !== 'active') return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  const hangUp = async () => {
    if (finished.current) return;
    finished.current = true;
    setPhase('ended');
    const durationMs = connectedAt.current ? Date.now() - connectedAt.current : undefined;
    try {
      await appendMessage({
        convId,
        senderId: 'self',
        type: 'call',
        content: durationMs == null ? '已取消' : undefined,
        meta: durationMs == null ? { direction: 'out' } : { direction: 'out', durationMs },
        status: 'sent',
        createdAt: Date.now(),
      });
    } catch (e) {
      // Losing the call record is bad; being unable to leave a full-screen call
      // is worse. Hanging up must always end with the user off this screen.
      logError('call.hangUp', e);
    }
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

  return (
    <div className="call-page">
      <div className="call-page__id">
        <Avatar color={peer.avatarColor} text={peer.avatarText} imageRef={peer.avatarRef} size={88} />
        <div className="call-page__name">{peer.remark ?? peer.name}</div>
        <div className="call-page__status">
          {phase === 'dialing' ? '正在等待对方接受邀请…' : phase === 'active' ? mmss : '通话已结束'}
        </div>
      </div>
      <div className="call-page__controls">
        <button className="call-page__btn call-page__btn--hangup" aria-label="挂断" onClick={() => void hangUp()}>
          <svg viewBox="0 0 32 32" width="30" height="30" aria-hidden>
            <path
              d="M16 13c-4.5 0-8.6 1.5-11.6 4a2.5 2.5 0 0 0-.4 3.4l1.5 2c.7.9 2 1.1 3 .5l3-1.9c.7-.5 1.1-1.3 1-2.1l-.2-1.8a17 17 0 0 1 7.4 0l-.2 1.8c-.1.8.3 1.6 1 2.1l3 1.9c1 .6 2.3.4 3-.5l1.5-2a2.5 2.5 0 0 0-.4-3.4c-3-2.5-7.1-4-11.6-4z"
              fill="currentColor"
            />
          </svg>
        </button>
        <span className="call-page__hint">{phase === 'dialing' ? '取消' : '挂断'}</span>
      </div>
    </div>
  );
}
