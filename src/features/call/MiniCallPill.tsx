/**
 * The minimized call (M-J6) — WeChat's green "通话中" pill.
 *
 * Rendered in the app shell (next to IncomingCall) whenever call-host owns a
 * live session AND the user is not looking at the call page itself. Tapping
 * returns to the call; the small handset hangs up right here — both buttons
 * drive the SAME host functions the full page uses, so there is exactly one
 * hangup code path and one call record.
 *
 * The ticking clock is a UI timer over host `connectedAt` — presentation only,
 * never persisted, so the scheduler rule (#5) does not apply; frozen-clock
 * screenshots never show the pill (no live call in any golden's seed state).
 */
import { useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useActiveCall, hangupActiveCall } from './call-host';
import './call.css';

const mmss = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

export function MiniCallPill() {
  const call = useActiveCall();
  const location = useLocation();
  const navigate = useNavigate();
  const [, tick] = useState(0);

  const onCallPage = location.pathname.startsWith('/call/');
  const visible = Boolean(call) && !onCallPage;

  useEffect(() => {
    if (!visible) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [visible]);

  if (!call || !visible) return null;

  return (
    <div className="call-pill" role="status">
      <button
        className="call-pill__body"
        onClick={() =>
          navigate(
            call.group
              ? `/group-call/${call.convId}`
              : `/call/${call.convId}?in=1${call.video ? '&video=1' : ''}`,
          )
        }
        aria-label={`返回与${call.peerName}的通话`}
      >
        <span className="call-pill__wave" aria-hidden>
          <i /> <i /> <i />
        </span>
        <span className="call-pill__name">{call.peerName}</span>
        <span className="call-pill__time">{mmss(Date.now() - call.connectedAt)}</span>
      </button>
      <button
        className="call-pill__hangup"
        aria-label="挂断"
        onClick={() => void hangupActiveCall()}
      >
        <svg viewBox="0 0 32 32" width="18" height="18" aria-hidden>
          <path
            d="M16 13c-4.5 0-8.6 1.5-11.6 4a2.5 2.5 0 0 0-.4 3.4l1.5 2c.7.9 2 1.1 3 .5l3-1.9c.7-.5 1.1-1.3 1-2.1l-.2-1.8a17 17 0 0 1 7.4 0l-.2 1.8c-.1.8.3 1.6 1 2.1l3 1.9c1 .6 2.3.4 3-.5l1.5-2a2.5 2.5 0 0 0-.4-3.4c-3-2.5-7.1-4-11.6-4z"
            fill="currentColor"
          />
        </svg>
      </button>
    </div>
  );
}
