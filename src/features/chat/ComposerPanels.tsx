import { useRef, useState, type ComponentType } from 'react';
import type { ComposerMode } from './useComposerPanel';
import type { GameKind } from '../../lib/game';
import {
  PanelAlbum,
  PanelCamera,
  PanelContactCard,
  PanelFavorites,
  PanelFile,
  PanelGroupBill,
  PanelLocation,
  PanelRedPacket,
  PanelTransfer,
  PanelVideoCall,
  PanelVoiceCall,
  PanelVoiceInput,
} from '../../components/panel-icons';

// A small emoji set stands in for WeChat's yellow-face pack (V1 uses emoji mapping).
const EMOJIS = [
  '😊', '😂', '😍', '😭', '😅', '😳', '😘', '🤔',
  '👍', '🙏', '👌', '💪', '🎉', '❤️', '🔥', '🌹',
  '😴', '🤣', '😎', '😏', '😢', '😡', '🥰', '😋',
];

export interface PlusItem {
  key: string;
  label: string;
  Icon: ComponentType;
}

const ALBUM: PlusItem = { key: 'album', label: '相册', Icon: PanelAlbum };
const CAMERA: PlusItem = { key: 'camera', label: '拍摄', Icon: PanelCamera };
const VIDEO_CALL: PlusItem = { key: 'call', label: '视频通话', Icon: PanelVideoCall };
// 群里没有视频（M-J6c）：同一个 key，换成听筒与「语音通话」。
const VOICE_CALL: PlusItem = { key: 'call', label: '语音通话', Icon: PanelVoiceCall };
const LOCATION: PlusItem = { key: 'location', label: '位置', Icon: PanelLocation };
const RED_PACKET: PlusItem = { key: 'redpacket', label: '红包', Icon: PanelRedPacket };
const TRANSFER: PlusItem = { key: 'transfer', label: '转账', Icon: PanelTransfer };
// 群收款/AA (M-J8)：只在群里出现，占的正是单聊里「转账」那一格。
const GROUP_BILL: PlusItem = { key: 'groupbill', label: '群收款', Icon: PanelGroupBill };
const VOICE_INPUT: PlusItem = { key: 'voiceinput', label: '语音输入', Icon: PanelVoiceInput };
const FAVORITES: PlusItem = { key: 'fav', label: '收藏', Icon: PanelFavorites };
const CONTACT_CARD: PlusItem = { key: 'namecard', label: '个人名片', Icon: PanelContactCard };
const FILE: PlusItem = { key: 'file', label: '文件', Icon: PanelFile };

/**
 * 「＋」面板的分页 (M-K1)：微信 8.0 的 4×2 一页、左右滑翻页、底部分页点。
 *
 * 单聊与群聊各给一套，而不是把对方场景用不了的那格灰掉——一格灰着的「群收款」
 * 只会让人点一下、发现没反应。钱那一格按场景换：单聊是转账，群里是群收款。
 */
export function plusPages(isGroup: boolean): PlusItem[][] {
  return [
    [
      ALBUM,
      CAMERA,
      isGroup ? VOICE_CALL : VIDEO_CALL,
      LOCATION,
      RED_PACKET,
      isGroup ? GROUP_BILL : TRANSFER,
      VOICE_INPUT,
      FAVORITES,
    ],
    [CONTACT_CARD, FILE],
  ];
}

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
  isGroup = false,
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
  /** + panel tiles rendered greyed-out (a tile that exists but cannot act right now). */
  disabledKeys?: string[];
  /** 群聊：「＋」面板换群那一套（语音通话 / 群收款）。 */
  isGroup?: boolean;
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
        <PlusPager pages={plusPages(isGroup)} disabledKeys={disabledKeys} onAction={onAction} />
      )}
    </div>
  );
}

/**
 * 左右滑的分页容器：每页 100% 宽、scroll-snap 吸附，分页点跟着 scrollLeft 走。
 * 只有一页时不画分页点（微信同款）。
 */
function PlusPager({
  pages,
  disabledKeys,
  onAction,
}: {
  pages: PlusItem[][];
  disabledKeys?: string[];
  onAction?: (key: string) => void;
}) {
  const [page, setPage] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const onScroll = () => {
    const el = ref.current;
    if (!el || el.clientWidth === 0) return;
    setPage(Math.round(el.scrollLeft / el.clientWidth));
  };
  return (
    <div className="plus-panel">
      <div className="plus-pages" ref={ref} onScroll={onScroll}>
        {pages.map((items, i) => (
          <div className="plus-grid" key={i}>
            {items.map((it) => {
              const disabled = disabledKeys?.includes(it.key);
              return (
                <button
                  key={it.key}
                  type="button"
                  className={`plus-grid__item${disabled ? ' plus-grid__item--disabled' : ''}`}
                  aria-disabled={disabled || undefined}
                  onClick={() => !disabled && onAction?.(it.key)}
                >
                  <span className="plus-grid__tile">
                    <it.Icon />
                  </span>
                  <span className="plus-grid__label">{it.label}</span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
      {pages.length > 1 && (
        <div className="plus-dots" aria-hidden>
          {pages.map((_, i) => (
            <span key={i} className={`plus-dots__dot${i === page ? ' plus-dots__dot--on' : ''}`} />
          ))}
        </div>
      )}
    </div>
  );
}
