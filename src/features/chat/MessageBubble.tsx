import { useRef, useState } from 'react';
import { Avatar } from '../../components/Avatar';
import { fenToYuan } from '../../lib/money';
import { playVoice } from '../../lib/voice';
import { canReEdit } from '../../lib/recall';
import type { MessageVM, ContactVM } from '../../data/types';

interface Props {
  msg: MessageVM;
  sender?: ContactVM;
  isSelf: boolean;
  /** Group chats show the sender's nickname above the bubble for others' messages. */
  showNickname?: boolean;
  /** Tapping a red-packet / transfer bubble. */
  onMoneyTap?: (msg: MessageVM) => void;
  /** Long-press (or right-click) on the row — opens the recall/copy menu. */
  onLongPress?: (msg: MessageVM, x: number, y: number) => void;
  /** 重新编辑 on a recalled text message: refill the composer with the original. */
  onReEdit?: (msg: MessageVM) => void;
}

const LONG_PRESS_MS = 500;

/** Renders one message row: system lines centered; otherwise avatar + bubble. */
export function MessageBubble({ msg, sender, isSelf, showNickname, onMoneyTap, onLongPress, onReEdit }: Props) {
  // Long-press: pointer down starts a timer; any movement or release cancels it.
  // touch-action stays default so scrolling still cancels naturally via pointerleave.
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };
  const pressHandlers = onLongPress
    ? {
        onPointerDown: (e: React.PointerEvent) => {
          const { clientX, clientY } = e;
          cancelPress();
          pressTimer.current = setTimeout(() => onLongPress(msg, clientX, clientY), LONG_PRESS_MS);
        },
        onPointerUp: cancelPress,
        onPointerLeave: cancelPress,
        onPointerMove: cancelPress,
        // Desktop right-click opens the same menu immediately.
        onContextMenu: (e: React.MouseEvent) => {
          e.preventDefault();
          cancelPress();
          onLongPress(msg, e.clientX, e.clientY);
        },
      }
    : {};

  if (msg.type === 'system' || msg.isRecalled) {
    const text = msg.isRecalled
      ? isSelf
        ? '你撤回了一条消息'
        : `"${sender?.remark ?? sender?.name ?? '对方'}" 撤回了一条消息`
      : (msg.content ?? '');
    return (
      <div className="msg-system">
        {text}
        {canReEdit(msg) && onReEdit && (
          <button className="msg-system__reedit" onClick={() => onReEdit(msg)}>
            重新编辑
          </button>
        )}
      </div>
    );
  }

  // Only a message that JUST arrived pops in; rendering history stays still.
  // Live now() is fine here: it's presentation-only and never persisted.
  const fresh = Date.now() - msg.createdAt < 3_000;

  return (
    <div
      className={`msg-row${isSelf ? ' msg-row--self' : ''}${fresh ? ' msg--enter' : ''}`}
      style={fresh ? ({ '--msg-origin': isSelf ? 'right bottom' : 'left bottom' } as React.CSSProperties) : undefined}
      {...pressHandlers}
    >
      {!isSelf && (
        <div className="msg-row__avatar">
          <Avatar color={sender?.avatarColor ?? 'var(--color-brand)'} text={sender?.avatarText ?? '?'} size={40} />
        </div>
      )}
      <div className="msg-row__col">
        {showNickname && !isSelf && (
          <div className="msg-row__nick">{sender?.remark ?? sender?.name ?? ''}</div>
        )}
        <div
          className="msg-row__body"
          onClick={
            msg.type === 'rp' || msg.type === 'transfer' ? () => onMoneyTap?.(msg) : undefined
          }
        >
          <BubbleContent msg={msg} isSelf={isSelf} />
        </div>
        {msg.meta?.quote != null && (
          <div className="msg-quote">{String(msg.meta.quote)}</div>
        )}
      </div>
      {isSelf && (
        <div className="msg-row__avatar">
          <Avatar color={sender?.avatarColor ?? 'var(--color-brand)'} text={sender?.avatarText ?? '我'} size={40} />
        </div>
      )}
    </div>
  );
}

/**
 * Voice bubble: width tracks the real audio duration, tap plays it, the unread
 * red dot clears on first play, and long-press-style "转文字" reveals the text
 * (free and exact, since we synthesized the audio from that text).
 */
function VoiceBubble({ msg, isSelf }: { msg: MessageVM; isSelf: boolean }) {
  const durMs = (msg.meta?.durationMs as number) ?? 2000;
  const audioKey = msg.meta?.audioKey as string | undefined;
  const dur = Math.max(1, Math.round(durMs / 1000));
  const width = Math.min(60 + dur * 8, 180);
  const [played, setPlayed] = useState(Boolean(msg.meta?.played));
  const [playing, setPlaying] = useState(false);
  const [showText, setShowText] = useState(false);

  const onTap = async () => {
    setPlayed(true);
    if (!audioKey) return; // no audio (TTS unconfigured) — bubble still behaves
    setPlaying(true);
    const ok = await playVoice(audioKey, () => setPlaying(false));
    if (!ok) setPlaying(false);
  };

  return (
    <div className="voice-wrap">
      <div
        className={`bubble bubble--${isSelf ? 'self' : 'other'} bubble--voice`}
        style={{ width }}
        onClick={onTap}
        onDoubleClick={() => setShowText((v) => !v)}
      >
        <span className={`voice-waves${playing ? ' voice-waves--playing' : ''}`} aria-hidden>
          <i /> <i /> <i />
        </span>
        <span className="voice-dur">{dur}″</span>
        {!played && !isSelf && <span className="voice-unplayed" />}
      </div>
      {showText && <div className="voice-text">{msg.content}</div>}
    </div>
  );
}

function BubbleContent({ msg, isSelf }: { msg: MessageVM; isSelf: boolean }) {
  const side = isSelf ? 'self' : 'other';
  switch (msg.type) {
    case 'text':
      return <div className={`bubble bubble--${side}`}>{msg.content}</div>;

    case 'sticker':
      // Stickers render bare (no bubble background), like real WeChat.
      return <div className="msg-sticker">{msg.content || '🙂'}</div>;

    case 'voice':
      return <VoiceBubble msg={msg} isSelf={isSelf} />;

    case 'rp': {
      // States: unopened (bright orange) / opened-by-me / fully-claimed (dim orange).
      const opened = Boolean(msg.meta?.opened);
      const statusText = (msg.meta?.statusText as string) ?? (opened ? '已被领完' : '');
      return (
        <div className={`money-bubble money-bubble--${side}${opened ? ' money-bubble--dim' : ''}`}>
          <div className="money-bubble__main">
            <div className="rp-envelope" aria-hidden>
              <div className="rp-envelope__flap" />
              <div className="rp-envelope__coin">¥</div>
            </div>
            <div className="money-bubble__lines">
              <div className="money-bubble__title">
                {(msg.meta?.greeting as string) ?? '恭喜发财，大吉大利'}
              </div>
              {statusText && <div className="money-bubble__status">{statusText}</div>}
            </div>
          </div>
          <div className="money-bubble__footer">微信红包</div>
        </div>
      );
    }

    case 'transfer': {
      const amount = fenToYuan((msg.meta?.amountFen as number) ?? 0);
      const status = (msg.meta?.status as string) ?? 'pending';
      const done = status === 'accepted';
      const statusText =
        (msg.meta?.statusText as string) ??
        (done ? (isSelf ? '已收款' : '已被接收') : isSelf ? '你发起了一笔转账' : '请收款');
      return (
        <div className={`money-bubble money-bubble--${side}${done ? ' money-bubble--dim' : ''}`}>
          <div className="money-bubble__main">
            <div className="transfer-icon" aria-hidden>
              {done ? (
                <svg viewBox="0 0 36 36" width="34" height="34">
                  <circle cx="18" cy="18" r="16" fill="none" stroke="currentColor" strokeWidth="2.4" />
                  <path
                    d="M10.5 18.5 16 24l10-11"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.6"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              ) : (
                <svg viewBox="0 0 36 36" width="34" height="34">
                  <circle cx="18" cy="18" r="16" fill="none" stroke="currentColor" strokeWidth="2.4" />
                  <path
                    d="M12 15h10l-3-3M24 21H14l3 3"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              )}
            </div>
            <div className="money-bubble__lines">
              <div className="money-bubble__amount">¥{amount}</div>
              <div className="money-bubble__status">{statusText}</div>
            </div>
          </div>
          <div className="money-bubble__footer">转账</div>
        </div>
      );
    }

    case 'call': {
      const durMs = msg.meta?.durationMs as number | undefined;
      const label =
        durMs != null
          ? `通话时长 ${String(Math.floor(durMs / 60000)).padStart(2, '0')}:${String(
              Math.floor((durMs % 60000) / 1000),
            ).padStart(2, '0')}`
          : (msg.content ?? '已取消');
      return (
        <div className={`bubble bubble--${side} call-bubble`}>
          <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden>
            <path
              d="M4 3.5 6.5 3 8 6 6.4 7.6a10 10 0 0 0 6 6L14 12l3 1.5-.5 2.5c-.3 1-1.3 1.6-2.3 1.4A14.5 14.5 0 0 1 2.6 5.8C2.4 4.8 3 3.8 4 3.5z"
              fill="currentColor"
            />
          </svg>
          <span>{label}</span>
        </div>
      );
    }

    default:
      return <div className={`bubble bubble--${side}`}>{msg.content ?? `[${msg.type}]`}</div>;
  }
}
