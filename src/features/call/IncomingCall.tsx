/**
 * She is calling you (M-H1).
 *
 * The call shell has only ever worked outward — you dial, the peer answers.
 * `render-msg` has been able to describe an INCOMING call since M-E1 and
 * nothing produced one, so that branch was unreachable for two milestones.
 *
 * Lives in the app shell rather than on a route, because that is the whole
 * difference between a call and a screen: it has to appear over whatever you
 * were doing. Everything is driven by one store field, so the scheduler's
 * handler can raise it from anywhere without knowing where the user is.
 */
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Avatar } from '../../components/Avatar';
import { useAppStore } from '../../store/appStore';
import { startRingback } from '../../lib/sound';
import { logError } from '../../lib/errlog';
import './call.css';

/** How long she waits before giving up. WeChat rings for about this long. */
const RING_MS = 30_000;

export function IncomingCall() {
  const call = useAppStore((s) => s.incomingCall);
  const setIncomingCall = useAppStore((s) => s.setIncomingCall);
  const contactById = useAppStore((s) => s.contactById);
  const appendMessage = useAppStore((s) => s.appendMessage);
  const navigate = useNavigate();
  // One-shot guard: ring-out and a tap can race, and two records for one call
  // is worse than none.
  const done = useRef(false);

  const convId = call?.convId ?? '';
  const peer = call ? contactById(call.contactId) : undefined;

  useEffect(() => {
    if (!call) return;
    done.current = false;
    const stopRing = startRingback();
    const timer = setTimeout(() => void finish('missed'), RING_MS);
    return () => {
      stopRing();
      clearTimeout(timer);
    };
    // `finish` is stable enough for this effect's purpose: it only reads the
    // call being rung right now, which is exactly what this effect is about.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call?.at]);

  const finish = async (how: 'missed' | 'declined' | 'answered') => {
    if (done.current || !call) return;
    done.current = true;
    setIncomingCall(null);
    if (how === 'answered') {
      // The shell takes it from here; the record is written when it hangs up.
      navigate(`/call/${convId}?in=1`);
      return;
    }
    try {
      await appendMessage({
        convId,
        senderId: call.contactId,
        type: 'call',
        content: how === 'declined' ? '已拒绝' : '对方已取消',
        // The direction is what makes this a call FROM her in the transcript —
        // and the reason the model can refer to it later.
        meta: { direction: 'in' },
        status: 'sent',
        createdAt: Date.now(),
      });
    } catch (e) {
      logError('call.incoming.record', e);
    }
  };

  if (!call) return null;

  return (
    <div className="call-page call-page--incoming" role="dialog" aria-label="来电">
      <div className="call-page__id">
        <Avatar
          color={peer?.avatarColor ?? 'var(--color-brand)'}
          text={peer?.avatarText ?? '?'}
          imageRef={peer?.avatarRef}
          size={96}
        />
        <div className="call-page__name">{peer?.remark ?? peer?.name ?? ''}</div>
        <div className="call-page__status">邀请你语音通话</div>
      </div>
      <div className="call-page__row">
        <div className="call-page__controls">
          <button
            className="call-page__btn call-page__btn--hangup"
            onClick={() => void finish('declined')}
            aria-label="拒绝"
          >
            <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden>
              <path d="M9 9l14 14M23 9L9 23" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
            </svg>
          </button>
          <span className="call-page__hint">拒绝</span>
        </div>
        <div className="call-page__controls">
          <button
            className="call-page__btn call-page__btn--accept"
            onClick={() => void finish('answered')}
            aria-label="接听"
          >
            <svg viewBox="0 0 32 32" width="28" height="28" aria-hidden>
              <path
                d="M11 6c1 0 1.8.6 2.1 1.5l1.2 3a2 2 0 0 1-.5 2.2l-1.4 1.3a13 13 0 0 0 5.6 5.6l1.3-1.4a2 2 0 0 1 2.2-.5l3 1.2c.9.3 1.5 1.1 1.5 2.1v3a2 2 0 0 1-2.2 2A21 21 0 0 1 6 8.2 2 2 0 0 1 8 6h3z"
                fill="currentColor"
              />
            </svg>
          </button>
          <span className="call-page__hint">接听</span>
        </div>
      </div>
    </div>
  );
}
