import { useRef, useState, type ComponentType } from 'react';
import { EMOJI_SET, loadRecent, pushRecent, saveRecent } from './emoji-set';
import { IconBackspace, IconEmoji, IconHeart } from '../../components/icons';
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
  onSend,
  canSend = false,
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
  /** 表情面板右下角的「发送」(M-K2)：发出当前草稿，键盘不必再升起来。 */
  onSend?: () => void;
  /** 草稿非空时「发送」才是绿的、才可点。 */
  canSend?: boolean;
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
        <EmojiPane
          onEmoji={onEmoji}
          onEmojiDelete={onEmojiDelete}
          onSend={onSend}
          canSend={canSend}
          onGame={onGame}
          stickers={stickers}
          onSticker={onSticker}
          onManageStickers={onManageStickers}
        />
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

/**
 * 表情面板 (M-K2)：微信 8.0 的结构——
 *   - 😊 页：「最近使用」一行（用过才出现）+「所有表情」8 列网格，右下角浮着
 *     退格与「发送」；
 *   - ♡ 页（收藏的表情）：＋（去素材库导入）、猜拳、骰子，然后是「我的表情」。
 *     骰子与猜拳在微信里就住在这一页，而不是在黄脸网格里。
 * 底部是 tab 栏。面板整体高度仍由组合器锁定（键盘⇄面板零跳变），这里只在内部滚动。
 */
function EmojiPane({
  onEmoji,
  onEmojiDelete,
  onSend,
  canSend,
  onGame,
  stickers,
  onSticker,
  onManageStickers,
}: {
  onEmoji?: (emoji: string) => void;
  onEmojiDelete?: () => void;
  onSend?: () => void;
  canSend: boolean;
  onGame?: (game: GameKind) => void;
  stickers?: CustomStickerVM[];
  onSticker?: (ref: string) => void;
  onManageStickers?: () => void;
}) {
  const [tab, setTab] = useState<'emoji' | 'fav'>('emoji');
  const [recent, setRecent] = useState<string[]>(loadRecent);
  const hasFav = Boolean(onGame || onSticker || onManageStickers);

  const pick = (e: string) => {
    onEmoji?.(e);
    const next = pushRecent(recent, e);
    setRecent(next);
    saveRecent(next);
  };

  const grid = (list: readonly string[], keyPrefix: string) => (
    <div className="emoji-grid">
      {list.map((e) => (
        <button key={`${keyPrefix}${e}`} type="button" className="emoji-grid__item" onClick={() => pick(e)}>
          {e}
        </button>
      ))}
    </div>
  );

  return (
    <div className="emoji-panel">
      <div className={`emoji-panel__body${tab === 'emoji' ? ' emoji-panel__body--emoji' : ''}`}>
        {tab === 'emoji' ? (
          <>
            {recent.length > 0 && (
              <>
                <div className="emoji-panel__label">最近使用</div>
                {grid(recent, 'r')}
              </>
            )}
            <div className="emoji-panel__label">所有表情</div>
            {grid(EMOJI_SET, 'a')}
          </>
        ) : (
          <div className="emoji-fav">
            {onManageStickers && (
              <button
                type="button"
                className="emoji-fav__item emoji-fav__add"
                aria-label="添加表情"
                onClick={onManageStickers}
              >
                ＋
              </button>
            )}
            {/* 表情游戏 (M-I13)：点一下就发出去——像微信一样没有草稿态，结果落地即定。 */}
            {onGame && (
              <>
                <button type="button" className="emoji-fav__item emoji-fav__game" onClick={() => onGame('rps')}>
                  <span aria-hidden>✊</span>
                  <span className="emoji-fav__name">猜拳</span>
                </button>
                <button type="button" className="emoji-fav__item emoji-fav__game" onClick={() => onGame('dice')}>
                  <span aria-hidden>🎲</span>
                  <span className="emoji-fav__name">掷骰子</span>
                </button>
              </>
            )}
            {onSticker &&
              (stickers ?? []).map((st) => (
                <button
                  key={st.id}
                  type="button"
                  className="emoji-fav__item"
                  aria-label="发送表情"
                  onClick={() => onSticker(`idb:${st.id}`)}
                >
                  {st.url && <img src={st.url} alt="" loading="lazy" />}
                </button>
              ))}
          </div>
        )}
      </div>
      {tab === 'emoji' && (
        <div className="emoji-panel__actions">
          <button type="button" className="emoji-panel__del" aria-label="删除" onClick={() => onEmojiDelete?.()}>
            <IconBackspace />
          </button>
          <button
            type="button"
            className="emoji-panel__send"
            disabled={!canSend}
            onClick={() => canSend && onSend?.()}
          >
            发送
          </button>
        </div>
      )}
      <div className="emoji-panel__tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'emoji'}
          aria-label="表情"
          className={`emoji-panel__tab${tab === 'emoji' ? ' emoji-panel__tab--on' : ''}`}
          onClick={() => setTab('emoji')}
        >
          <IconEmoji size={24} />
        </button>
        {hasFav && (
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'fav'}
            aria-label="收藏的表情"
            className={`emoji-panel__tab${tab === 'fav' ? ' emoji-panel__tab--on' : ''}`}
            onClick={() => setTab('fav')}
          >
            <IconHeart />
          </button>
        )}
      </div>
    </div>
  );
}
