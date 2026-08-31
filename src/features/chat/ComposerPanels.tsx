import type { ComposerMode } from './useComposerPanel';
import type { GameKind } from '../../lib/game';

// A small emoji set stands in for WeChat's yellow-face pack (V1 uses emoji mapping).
const EMOJIS = [
  '😊', '😂', '😍', '😭', '😅', '😳', '😘', '🤔',
  '👍', '🙏', '👌', '💪', '🎉', '❤️', '🔥', '🌹',
  '😴', '🤣', '😎', '😏', '😢', '😡', '🥰', '😋',
];

const PLUS_ITEMS = [
  { key: 'album', label: '相册', color: 'var(--color-brand)' },
  { key: 'camera', label: '拍摄', color: 'var(--color-link)' },
  { key: 'call', label: '视频通话', color: 'var(--wx-gold)' },
  { key: 'location', label: '位置', color: 'var(--color-brand)' },
  { key: 'redpacket', label: '红包', color: 'var(--color-rp-envelope)' },
  { key: 'transfer', label: '转账', color: 'var(--wx-gold)' },
  // 群收款/AA (M-J8) — greyed outside group chats, like transfer inside them.
  { key: 'groupbill', label: '群收款', color: 'var(--color-brand)' },
  { key: 'voiceinput', label: '语音输入', color: 'var(--color-link)' },
  { key: 'fav', label: '收藏', color: 'var(--color-brand)' },
];

/** A custom sticker tile the「我的表情」strip renders. */
export interface CustomStickerVM {
  /** Media-library id; sending uses the `idb:<id>` ref. */
  id: string;
  /** Live object URL, or '' while the blob is still materializing. */
  url: string;
}

/**
 * The emoji / + panel. Its height is locked to the measured keyboard height by
 * the composer hook so swapping keyboard⇄panel never shifts the layout.
 *
 * M-I15: the emoji page grows a「我的表情」section — user-imported sticker
 * images that SEND on tap (they are messages, not draft characters, which is
 * why they take a separate callback from `onEmoji`).
 */
export function ComposerPanels({
  mode,
  height,
  onAction,
  onEmoji,
  onEmojiDelete,
  onGame,
  disabledKeys,
  stickers,
  onSticker,
  onManageStickers,
}: {
  mode: ComposerMode;
  height: number;
  /** Fired when a + panel tile is tapped (e.g. 'redpacket' | 'transfer'). */
  onAction?: (key: string) => void;
  /** Emoji tapped — the caller appends it to the draft. */
  onEmoji?: (emoji: string) => void;
  /** Backspace key on the emoji panel. */
  onEmojiDelete?: () => void;
  /** 表情游戏 (M-I13): a dice / rock-paper-scissors send from the emoji panel. */
  onGame?: (game: GameKind) => void;
  /** + panel tiles rendered greyed-out (e.g. 'transfer' in a group chat). */
  disabledKeys?: string[];
  /** 我的表情 (M-I15): custom stickers from the media library. */
  stickers?: CustomStickerVM[];
  /** A custom sticker tapped — sends immediately as a sticker message. */
  onSticker?: (ref: string) => void;
  /** The「+」tile at the strip's end — jumps to the media library to import. */
  onManageStickers?: () => void;
}) {
  if (mode !== 'emoji' && mode !== 'plus') return null;
  return (
    <div className="composer-panel" style={{ height }}>
      {mode === 'emoji' ? (
        <div className="emoji-panel-scroll">
          <div className="emoji-grid">
            {EMOJIS.map((e, i) => (
              <button key={i} className="emoji-grid__item" onClick={() => onEmoji?.(e)}>
                {e}
              </button>
            ))}
            <button className="emoji-grid__item emoji-grid__del" aria-label="删除" onClick={() => onEmojiDelete?.()}>
              ⌫
            </button>
          </div>
          {/* 表情游戏 (M-I13): the dice / 猜拳 "dynamic stickers". Tapping one
              SENDS immediately — like WeChat, there is no draft state for a
              throw, and the seeded result is fixed the moment it lands. */}
          {onGame && (
            <div className="emoji-games">
              <button className="emoji-games__item" onClick={() => onGame('dice')}>
                <span className="emoji-games__glyph" aria-hidden>
                  🎲
                </span>
                掷骰子
              </button>
              <button className="emoji-games__item" onClick={() => onGame('rps')}>
                <span className="emoji-games__glyph" aria-hidden>
                  ✊
                </span>
                猜拳
              </button>
            </div>
          )}
          {onSticker && (
            <>
              <div className="sticker-strip__label">我的表情</div>
              <div className="sticker-strip">
                {(stickers ?? []).map((s) => (
                  <button
                    key={s.id}
                    className="sticker-strip__item"
                    aria-label="发送表情"
                    onClick={() => onSticker(`idb:${s.id}`)}
                  >
                    {s.url && <img src={s.url} alt="" loading="lazy" />}
                  </button>
                ))}
                {onManageStickers && (
                  <button
                    className="sticker-strip__item sticker-strip__add"
                    aria-label="添加表情"
                    onClick={onManageStickers}
                  >
                    ＋
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      ) : (
        <div className="plus-grid">
          {PLUS_ITEMS.map((it) => {
            const disabled = disabledKeys?.includes(it.key);
            return (
              <div
                key={it.key}
                className={`plus-grid__item${disabled ? ' plus-grid__item--disabled' : ''}`}
                onClick={() => !disabled && onAction?.(it.key)}
              >
                <div className="plus-grid__icon" style={{ background: it.color }} />
                <span className="plus-grid__label">{it.label}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
