import { Avatar } from '../../components/Avatar';
import { fenToYuan } from '../../lib/money';
import type { MessageVM, ContactVM } from '../../data/types';

interface Props {
  msg: MessageVM;
  sender?: ContactVM;
  isSelf: boolean;
  /** Group chats show the sender's nickname above the bubble for others' messages. */
  showNickname?: boolean;
  /** Tapping a red-packet / transfer bubble. */
  onMoneyTap?: (msg: MessageVM) => void;
}

/** Renders one message row: system lines centered; otherwise avatar + bubble. */
export function MessageBubble({ msg, sender, isSelf, showNickname, onMoneyTap }: Props) {
  if (msg.type === 'system' || msg.isRecalled) {
    const text = msg.isRecalled
      ? isSelf
        ? '你撤回了一条消息'
        : `"${sender?.remark ?? sender?.name ?? '对方'}" 撤回了一条消息`
      : (msg.content ?? '');
    return <div className="msg-system">{text}</div>;
  }

  return (
    <div className={`msg-row${isSelf ? ' msg-row--self' : ''}`}>
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

function BubbleContent({ msg, isSelf }: { msg: MessageVM; isSelf: boolean }) {
  const side = isSelf ? 'self' : 'other';
  switch (msg.type) {
    case 'text':
      return <div className={`bubble bubble--${side}`}>{msg.content}</div>;

    case 'sticker':
      // Stickers render bare (no bubble background), like real WeChat.
      return <div className="msg-sticker">{msg.content || '🙂'}</div>;

    case 'voice': {
      const dur = Math.round(((msg.meta?.durationMs as number) ?? 2000) / 1000);
      const width = Math.min(60 + dur * 8, 180);
      return (
        <div className={`bubble bubble--${side} bubble--voice`} style={{ width }}>
          <span className={`voice-waves${isSelf ? ' voice-waves--flip' : ''}`} aria-hidden>
            <i /> <i /> <i />
          </span>
          <span className="voice-dur">{dur}″</span>
          {!msg.meta?.played && !isSelf && <span className="voice-unplayed" />}
        </div>
      );
    }

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

    default:
      return <div className={`bubble bubble--${side}`}>{msg.content ?? `[${msg.type}]`}</div>;
  }
}
