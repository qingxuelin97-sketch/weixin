import { Avatar } from '../../components/Avatar';
import { fenToYuan } from '../../lib/money';
import type { MessageVM, ContactVM } from '../../data/types';

interface Props {
  msg: MessageVM;
  sender?: ContactVM;
  isSelf: boolean;
}

/** Renders one message row: system lines centered; otherwise avatar + bubble. */
export function MessageBubble({ msg, sender, isSelf }: Props) {
  if (msg.type === 'system' || msg.isRecalled) {
    const text = msg.isRecalled
      ? isSelf
        ? '你撤回了一条消息'
        : `${sender?.name ?? '对方'}撤回了一条消息`
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
      <div className="msg-row__body">
        <BubbleContent msg={msg} isSelf={isSelf} />
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
    case 'voice': {
      const dur = Math.round(((msg.meta?.durationMs as number) ?? 2000) / 1000);
      const width = Math.min(40 + dur * 8, 160);
      return (
        <div className={`bubble bubble--${side} bubble--voice`} style={{ width }}>
          <span className="voice-waves" aria-hidden>
            <i /> <i /> <i />
          </span>
          <span className="voice-dur">{dur}″</span>
          {!msg.meta?.played && !isSelf && <span className="voice-unplayed" />}
        </div>
      );
    }
    case 'rp': {
      const opened = Boolean(msg.meta?.opened);
      return (
        <div className={`rp-bubble${opened ? ' rp-bubble--opened' : ''}`}>
          <div className="rp-bubble__icon" aria-hidden>
            開
          </div>
          <div className="rp-bubble__text">
            <div className="rp-bubble__greeting">{(msg.meta?.greeting as string) ?? '恭喜发财，大吉大利'}</div>
            <div className="rp-bubble__footer">微信红包</div>
          </div>
        </div>
      );
    }
    case 'transfer': {
      const amount = fenToYuan((msg.meta?.amountFen as number) ?? 0);
      return (
        <div className="transfer-bubble">
          <div className="transfer-bubble__icon" aria-hidden>
            ↑
          </div>
          <div className="transfer-bubble__text">
            <div className="transfer-bubble__amount">￥{amount}</div>
            <div className="transfer-bubble__note">{(msg.meta?.note as string) ?? '转账'}</div>
          </div>
          <div className="transfer-bubble__footer">微信转账</div>
        </div>
      );
    }
    default:
      return <div className={`bubble bubble--${side}`}>{msg.content ?? `[${msg.type}]`}</div>;
  }
}
