import { useState } from 'react';
import { Avatar } from '../../components/Avatar';
import { useLongPress } from '../../components/useLongPress';
import { stickerGlyph } from '../../data/stickers';
import { fenToYuan } from '../../lib/money';
import { playVoice } from '../../lib/voice';
import { canReEdit } from '../../lib/recall';
import { resolveImageRef } from '../../data/moments-images';
import { RPS_GLYPHS, diceResult, rpsResult } from '../../lib/game';
import { humanSize } from '../../ai/bubble-materialize';
import type { MessageVM, ContactVM } from '../../data/types';

interface Props {
  msg: MessageVM;
  sender?: ContactVM;
  isSelf: boolean;
  /** Group chats show the sender's nickname above the bubble for others' messages. */
  showNickname?: boolean;
  /** Tapping a red-packet / transfer bubble. */
  onMoneyTap?: (msg: MessageVM) => void;
  /** Tapping an image bubble — the page opens the full-screen viewer. */
  onImageTap?: (msg: MessageVM) => void;
  /** Tapping a 合并转发 card — the page opens the record viewer (M-I6). */
  onMergedTap?: (msg: MessageVM) => void;
  /** Tapping a 名片 card — the page navigates to /contact/:id (M-I13). */
  onContactTap?: (msg: MessageVM) => void;
  /** Long-press (or right-click) on the row — opens the recall/copy menu. */
  onLongPress?: (msg: MessageVM, x: number, y: number) => void;
  /** 重新编辑 on a recalled text message: refill the composer with the original. */
  onReEdit?: (msg: MessageVM) => void;
  /** Re-send a message whose delivery failed. */
  onRetry?: (msg: MessageVM) => void;
}

/** Renders one message row: system lines centered; otherwise avatar + bubble. */
export function MessageBubble({ msg, sender, isSelf, showNickname, onMoneyTap, onImageTap, onMergedTap, onContactTap, onLongPress, onReEdit, onRetry }: Props) {
  // Shared long-press physics (M-I0): this copy used to cancel on ANY pointer
  // movement and had no fired guard, so releasing a long press on an image
  // ALSO opened the viewer. The hook fixes both.
  const lp = useLongPress((x, y) => onLongPress?.(msg, x, y));
  const pressHandlers = onLongPress ? lp.handlers : {};

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
          <Avatar color={sender?.avatarColor ?? 'var(--color-brand)'} text={sender?.avatarText ?? '?'} imageRef={sender?.avatarRef} size={40} />
        </div>
      )}
      {/* Undelivered, and the retry control in one. `status: 'failed'` has been
          in the schema since M1 with no producer, so a send that failed looked
          exactly like one that worked. Row-level and BEFORE the column so it
          sits to the left of your own bubble, where WeChat puts it. */}
      {isSelf && msg.status === 'failed' && (
        <button
          className="msg-failed"
          aria-label="重发"
          title="重发"
          onClick={(e) => {
            e.stopPropagation();
            onRetry?.(msg);
          }}
        >
          !
        </button>
      )}
      <div className="msg-row__col">
        {showNickname && !isSelf && (
          <div className="msg-row__nick">{sender?.remark ?? sender?.name ?? ''}</div>
        )}
        <div
          className="msg-row__body"
          onClick={
            msg.type === 'rp' || msg.type === 'transfer'
              ? () => {
                  if (lp.fired()) return; // release tap after a long press
                  onMoneyTap?.(msg);
                }
              : msg.type === 'image'
                ? () => {
                    if (lp.fired()) return;
                    onImageTap?.(msg);
                  }
                : msg.type === 'merged'
                  ? () => {
                      if (lp.fired()) return;
                      onMergedTap?.(msg);
                    }
                  : msg.type === 'contact_card'
                    ? () => {
                        if (lp.fired()) return;
                        onContactTap?.(msg);
                      }
                    : undefined
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
          <Avatar color={sender?.avatarColor ?? 'var(--color-brand)'} text={sender?.avatarText ?? '我'} imageRef={sender?.avatarRef} size={40} />
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
      // Through the vocabulary: `content` is a semantic label, and printing it
      // raw rendered words like 「开心」 at 64px where a sticker should be.
      return <div className="msg-sticker">{stickerGlyph(msg.content)}</div>;

    case 'image': {
      // content is an image ref (idb:/img:/ph:) — schema had the type since M1,
      // but nothing rendered it until M-C2 (it fell through to the text bubble).
      const { url, background } = resolveImageRef(msg.content ?? '');
      return url ? (
        <img className="msg-image" src={url} alt="" loading="lazy" />
      ) : (
        <div className="msg-image msg-image--ph" style={{ background }} />
      );
    }

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

    case 'merged': {
      // 合并转发 card (M-I6): identity + up to three preview lines, tap-through
      // to the full record page (the page reads the same meta).
      const items = Array.isArray(msg.meta?.items)
        ? (msg.meta!.items as Array<{ name?: string; body?: string }>)
        : [];
      const title = (msg.meta?.title as string) || '聊天记录';
      return (
        <div className={`bubble bubble--${side} merged-card`}>
          <div className="merged-card__title">{title}</div>
          {items.slice(0, 3).map((it, i) => (
            <div key={i} className="merged-card__line">
              {it.name}: {String(it.body ?? '').slice(0, 24)}
            </div>
          ))}
          <div className="merged-card__footer">聊天记录 · 共 {items.length} 条</div>
        </div>
      );
    }

    case 'location': {
      // 位置卡片 (M-I13): place name + a STATIC SVG mini-map. No network tiles
      // — the map is a drawing, which also keeps it deterministic for goldens.
      const name = msg.content ?? (msg.meta?.name as string | undefined) ?? '位置';
      const address = msg.meta?.address as string | undefined;
      return (
        <div className={`bubble bubble--${side} loc-card`}>
          <div className="loc-card__name">{name}</div>
          <div className="loc-card__addr">{address ?? name}</div>
          <div className="loc-card__map">
            <MiniMap />
          </div>
        </div>
      );
    }

    case 'contact_card': {
      // 名片 (M-I13): tap-through to the contact's profile (the page owns the
      // navigation). Avatar identity is SNAPSHOTTED in meta at send time, so
      // the card still renders if the contact is later renamed or deleted.
      const name = (msg.meta?.name as string | undefined) ?? msg.content ?? '';
      const wxid = msg.meta?.wxid as string | undefined;
      return (
        <div className={`bubble bubble--${side} contact-card`}>
          <div className="contact-card__main">
            <Avatar
              color={(msg.meta?.avatarColor as string | undefined) ?? 'var(--color-brand)'}
              text={(msg.meta?.avatarText as string | undefined) ?? name.slice(0, 1)}
              size={40}
            />
            <div className="contact-card__lines">
              <div className="contact-card__name">{name}</div>
              {wxid && <div className="contact-card__wxid">微信号：{wxid}</div>}
            </div>
          </div>
          <div className="contact-card__footer">个人名片</div>
        </div>
      );
    }

    case 'file': {
      // 假文件卡片 (M-I13): a prop, not a download — name / size / doc icon.
      const fileName = (msg.meta?.fileName as string | undefined) ?? msg.content ?? '文件';
      const sizeBytes = msg.meta?.sizeBytes as number | undefined;
      const ext = ((msg.meta?.ext as string | undefined) ?? '').toUpperCase().slice(0, 4);
      return (
        <div className={`bubble bubble--${side} file-card`}>
          <div className="file-card__main">
            <div className="file-card__lines">
              <div className="file-card__name">{fileName}</div>
              {sizeBytes != null && <div className="file-card__size">{humanSize(sizeBytes)}</div>}
            </div>
            <div className="file-card__icon" aria-hidden>
              <svg viewBox="0 0 30 36" width="30" height="36">
                <path
                  d="M4 2h15l7 7v25a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"
                  fill="var(--color-cell-bg)"
                  stroke="var(--color-hairline)"
                  strokeWidth="1"
                />
                <path d="M19 2v7h7z" fill="var(--color-hairline)" />
              </svg>
              {ext && <span className="file-card__ext">{ext}</span>}
            </div>
          </div>
          <div className="file-card__footer">微信文件</div>
        </div>
      );
    }

    case 'link': {
      // 链接分享卡 (M-I13): title + summary + a placeholder thumb. The link is
      // fictional — nothing to open, so the card is inert by design.
      const title = (msg.meta?.title as string | undefined) ?? msg.content ?? '';
      const summary = msg.meta?.summary as string | undefined;
      return (
        <div className={`bubble bubble--${side} link-card`}>
          <div className="link-card__title">{title}</div>
          <div className="link-card__row">
            <div className="link-card__summary">{summary ?? title}</div>
            <div className="link-card__thumb" aria-hidden>
              <svg viewBox="0 0 20 20" width="18" height="18">
                <path
                  d="M8.5 11.5 11.5 8.5M7 13l-1.8 1.8a2.6 2.6 0 0 1-3.7-3.7L4.6 8a2.6 2.6 0 0 1 3.7 0M13 7l1.8-1.8a2.6 2.6 0 0 1 3.7 3.7L15.4 12a2.6 2.6 0 0 1-3.7 0"
                  fill="none"
                  stroke="var(--color-text-secondary)"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
            </div>
          </div>
        </div>
      );
    }

    case 'game': {
      // 表情游戏 (M-I13): renders BARE like a sticker. The face shown is the
      // stored seeded result — never re-rolled at render time.
      if (msg.meta?.game === 'rps') {
        return <div className="msg-game">{RPS_GLYPHS[rpsResult(msg.meta?.result)]}</div>;
      }
      return (
        <div className="msg-game">
          <DiceFace n={diceResult(msg.meta?.result)} />
        </div>
      );
    }

    default:
      return <div className={`bubble bubble--${side}`}>{msg.content ?? `[${msg.type}]`}</div>;
  }
}

/** Pip layout per face, on a 3×3 grid (coordinates in a 48×48 viewBox). */
const PIPS: Record<number, Array<[number, number]>> = {
  1: [[24, 24]],
  2: [
    [14, 14],
    [34, 34],
  ],
  3: [
    [13, 13],
    [24, 24],
    [35, 35],
  ],
  4: [
    [14, 14],
    [34, 14],
    [14, 34],
    [34, 34],
  ],
  5: [
    [13, 13],
    [35, 13],
    [24, 24],
    [13, 35],
    [35, 35],
  ],
  6: [
    [14, 12],
    [34, 12],
    [14, 24],
    [34, 24],
    [14, 36],
    [34, 36],
  ],
};

/** A crisp SVG die face — emoji die glyphs render hairline-thin at 56px. */
function DiceFace({ n }: { n: number }) {
  const pips = PIPS[n] ?? PIPS[1];
  return (
    <svg viewBox="0 0 48 48" width="52" height="52" aria-label={`骰子 ${n} 点`}>
      <rect
        x="2"
        y="2"
        width="44"
        height="44"
        rx="9"
        fill="var(--color-cell-bg)"
        stroke="var(--color-hairline)"
        strokeWidth="1.5"
      />
      {pips.map(([cx, cy], i) => (
        <circle key={i} cx={cx} cy={cy} r="4.4" fill="var(--color-badge)" />
      ))}
    </svg>
  );
}

/**
 * The location card's static map: a hand-drawn block of "streets" with a pin.
 * All strokes ride tokens, so it follows the theme like every other drawing.
 */
function MiniMap() {
  return (
    <svg viewBox="0 0 220 90" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" aria-hidden>
      <rect x="0" y="0" width="220" height="90" fill="var(--color-page-bg)" />
      {/* park block */}
      <rect x="150" y="8" width="62" height="30" rx="4" fill="var(--color-brand)" opacity="0.18" />
      {/* main roads */}
      <path d="M0 30 H220 M0 66 H220 M46 0 V90 M118 0 V90 M178 0 V90" stroke="var(--color-cell-bg)" strokeWidth="8" fill="none" />
      {/* minor roads */}
      <path d="M0 48 H220 M84 0 V90 M148 30 V90" stroke="var(--color-cell-bg)" strokeWidth="3.5" fill="none" />
      {/* road edges */}
      <path d="M0 30 H220 M0 66 H220" stroke="var(--color-hairline)" strokeWidth="0.6" fill="none" />
      {/* the pin, centered */}
      <g transform="translate(110 28)">
        <path
          d="M0 26C0 26 -11 12.5 -11 5.5A11 11 0 0 1 11 5.5C11 12.5 0 26 0 26Z"
          fill="var(--color-badge)"
        />
        <circle cx="0" cy="6" r="4.4" fill="var(--color-cell-bg)" />
      </g>
    </svg>
  );
}
