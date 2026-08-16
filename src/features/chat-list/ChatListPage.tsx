import { useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Virtuoso } from 'react-virtuoso';
import { NavBar } from '../../components/NavBar';
import { Avatar } from '../../components/Avatar';
import { IconPlus, IconSearch } from '../../components/icons';
import { useAppStore } from '../../store/appStore';
import { listTimestamp } from '../../lib/time';
import type { ConversationVM } from '../../data/types';
import './chat-list.css';
import { useNow } from '../../lib/useNow';
import { useSwipeRow } from '../../components/useSwipeRow';
import { useLongPress } from '../../components/useLongPress';
import { useDismissable } from '../../app/useDismissable';
import { showConfirm } from '../../components/dialog';
import { usePullRefresh } from '../../components/usePullRefresh';
import { PullRefresh } from '../../components/PullRefresh';
import { RollingNumber } from '../../components/RollingNumber';
import { useStagger, type StaggerRowProps } from '../../lib/useStagger';

export function ChatListPage() {
  const all = useAppStore((s) => s.conversations);
  const showToast = useAppStore((s) => s.showToast);
  const patchConversation = useAppStore((s) => s.patchConversation);
  const deleteConversation = useAppStore((s) => s.deleteConversation);
  const refreshConversations = useAppStore((s) => s.refreshConversations);
  // Hidden (AI↔AI DM) conversations must never surface here.
  const conversations = useMemo(() => all.filter((c) => !c.isHidden), [all]);
  const navigate = useNavigate();
  const totalUnread = conversations.reduce((n, c) => n + (c.isMuted ? 0 : c.unreadCount), 0);

  /**
   * 下拉刷新 (M-I8).
   *
   * The list is virtualized, so the element the gesture translates is the host
   * around Virtuoso and the scroll position it consults is Virtuoso's own
   * scroller — handed over through `scrollerRef`, because Virtuoso owns that
   * node and there is no ref of ours on it.
   */
  const listRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLElement | null>(null);
  const pull = usePullRefresh({
    ref: listRef,
    scroller: () => scrollerRef.current,
    onRefresh: () => refreshConversations().catch(() => showToast('刷新失败')),
  });
  // First paint only: rows recycled by Virtuoso as you scroll must NOT replay
  // the entrance (see lib/stagger.ts).
  const stagger = useStagger();

  const [plusOpen, setPlusOpen] = useState(false);
  const [menu, setMenu] = useState<{ conv: ConversationVM; y: number } | null>(null);
  // Hardware back closes the ＋ dropdown / row menu before popping the page.
  useDismissable(plusOpen, () => setPlusOpen(false));
  useDismissable(!!menu, () => setMenu(null));

  const act = (fn: () => Promise<void>) => {
    setMenu(null);
    void fn().catch(() => showToast('操作失败'));
  };

  /** Deleting a thread destroys its history — the one list action that gets a confirm. */
  const confirmDelete = (conv: ConversationVM) => {
    setMenu(null);
    void showConfirm({
      title: '删除该聊天',
      body: `与「${conv.title}」的聊天记录将被删除，且无法恢复。`,
      confirmText: '删除',
      danger: true,
    }).then((ok) => {
      if (ok) void deleteConversation(conv.id).catch(() => showToast('操作失败'));
    });
  };

  return (
    <>
      <NavBar
        title={totalUnread > 0 ? `微信(${totalUnread})` : '微信'}
        right={
          <>
            <button className="navbar__btn" aria-label="搜索" onClick={() => navigate('/search')}>
              <IconSearch />
            </button>
            <button className="navbar__btn" aria-label="更多" onClick={() => setPlusOpen((v) => !v)}>
              <IconPlus />
            </button>
          </>
        }
      />
      {plusOpen && (
        <div className="chatlist-overlay" onClick={() => setPlusOpen(false)}>
          <div className="plus-menu" role="menu" onClick={(e) => e.stopPropagation()}>
            <button role="menuitem" onClick={() => { setPlusOpen(false); navigate('/group-new'); }}>
              发起群聊
            </button>
            <button role="menuitem" onClick={() => { setPlusOpen(false); navigate('/contact-new'); }}>
              添加朋友
            </button>
            <button role="menuitem" onClick={() => { setPlusOpen(false); showToast('扫一扫暂未开放'); }}>
              扫一扫
            </button>
            <button role="menuitem" onClick={() => { setPlusOpen(false); showToast('收付款暂未开放'); }}>
              收付款
            </button>
          </div>
        </div>
      )}
      <div className="page-body chat-list pull-clip">
        {/* The clip is the page body (which does not move); the host inside it
            is what the gesture translates. Swapping those two is the classic
            way to build a pull-to-refresh that never shows its indicator. */}
        <div className="pull-host" ref={listRef} {...pull.handlers}>
          <PullRefresh phase={pull.phase} progress={pull.progress} />
          <Virtuoso
            data={conversations}
            scrollerRef={(el) => {
              scrollerRef.current = el as HTMLElement | null;
            }}
            itemContent={(i, conv) => (
              <ConversationRow
                conv={conv}
                stagger={stagger(i)}
                onOpen={() => navigate(`/chat/${conv.id}`)}
                onLongPress={(y) => setMenu({ conv, y })}
                onRead={() =>
                  act(() =>
                    patchConversation(
                      conv.id,
                      conv.unreadCount > 0
                        ? { unreadCount: 0, mentionMe: false }
                        : { unreadCount: 1 },
                    ),
                  )
                }
                onDelete={() => confirmDelete(conv)}
              />
            )}
          />
        </div>
      </div>
      {menu && (
        <div className="chatlist-overlay" onClick={() => setMenu(null)}>
          <div
            className="conv-menu"
            role="menu"
            style={{ top: Math.min(menu.y, window.innerHeight - 230) }}
            onClick={(e) => e.stopPropagation()}
          >
            <button
              role="menuitem"
              onClick={() => act(() => patchConversation(menu.conv.id, { isPinned: !menu.conv.isPinned }))}
            >
              {menu.conv.isPinned ? '取消置顶' : '置顶'}
            </button>
            <button
              role="menuitem"
              onClick={() => act(() => patchConversation(menu.conv.id, { isMuted: !menu.conv.isMuted }))}
            >
              {menu.conv.isMuted ? '开启新消息通知' : '消息免打扰'}
            </button>
            <button
              role="menuitem"
              onClick={() =>
                act(() =>
                  patchConversation(
                    menu.conv.id,
                    menu.conv.unreadCount > 0
                      ? { unreadCount: 0, mentionMe: false }
                      : { unreadCount: 1 },
                  ),
                )
              }
            >
              {menu.conv.unreadCount > 0 ? '标为已读' : '标为未读'}
            </button>
            <button
              role="menuitem"
              className="conv-menu__danger"
              onClick={() => confirmDelete(menu.conv)}
            >
              删除该聊天
            </button>
          </div>
        </div>
      )}
    </>
  );
}

/** Width of the revealed action tray. Two buttons, WeChat's proportions. */
const TRAY_WIDTH = 150;

function ConversationRow({
  conv,
  stagger,
  onOpen,
  onLongPress,
  onRead,
  onDelete,
}: {
  conv: ConversationVM;
  /** First-paint entrance props, or undefined for a row arriving later (M-I8). */
  stagger?: StaggerRowProps;
  onOpen: () => void;
  onLongPress: (y: number) => void;
  onRead: () => void;
  onDelete: () => void;
}) {
  const NOW = useNow();
  const contactById = useAppStore((s) => s.contactById);
  const badge = conv.unreadCount > 0;
  // Muted conversations show a small red dot instead of a numeric badge (device behavior).
  const dotOnly = conv.isMuted;
  // Real avatars resolve through the live contact, not the denormalized conv
  // fields — assigning a new avatar updates every row without a data migration.
  const peerRef = conv.type === 'single' && conv.peerId ? contactById(conv.peerId)?.avatarRef : undefined;
  const memberAvatars = conv.memberAvatars?.map((m, i) => ({
    ...m,
    imageRef: conv.memberIds?.[i] ? contactById(conv.memberIds[i])?.avatarRef : undefined,
  }));

  // Shared long-press physics (M-I0) — this copy used to cancel on ANY pointer
  // movement, which made the press nearly impossible to land on a touchscreen.
  const lp = useLongPress((_x, y) => onLongPress(y));
  // A completed horizontal swipe must not ALSO open the chat on release.
  const swipeDragged = useRef(false);
  // The gesture WeChat actually uses for these two actions (M-H3). The long
  // press stays: it carries 置顶 / 免打扰 too, and muscle memory is cheap to
  // honour.
  const swipe = useSwipeRow(TRAY_WIDTH);

  return (
    <div
      className={`conv-swipe${stagger?.className ? ` ${stagger.className}` : ''}`}
      style={stagger?.style}
    >
      {/* The tray sits UNDER the row and is revealed by sliding it; rendering
          it above and animating width would reflow the row's text on every
          frame of the drag. */}
      <div className="conv-swipe__tray" aria-hidden={!swipe.open || undefined}>
        <button
          className="conv-swipe__action conv-swipe__action--read"
          onClick={() => {
            swipe.close();
            onRead();
          }}
        >
          {conv.unreadCount > 0 ? '标为已读' : '标为未读'}
        </button>
        <button
          className="conv-swipe__action conv-swipe__action--delete"
          onClick={() => {
            swipe.close();
            onDelete();
          }}
        >
          删除
        </button>
      </div>
    <div
      ref={swipe.ref}
      className={`conv-row hairline-bottom${conv.isPinned ? ' conv-row--pinned' : ''}`}
      onClick={() => {
        // A swipe that ends on the row must not also open the chat, and a tap
        // on an open row closes the tray instead of navigating — both are what
        // every native list does, and both are invisible until they are wrong.
        if (swipe.open) {
          swipe.close();
        } else if (!lp.fired() && !swipeDragged.current) {
          onOpen();
        }
        lp.consume();
        swipeDragged.current = false;
      }}
      onPointerDown={(e) => {
        swipeDragged.current = false;
        swipe.handlers.onPointerDown(e);
        lp.handlers.onPointerDown(e);
      }}
      onPointerUp={() => {
        lp.handlers.onPointerUp();
        swipe.handlers.onPointerUp();
      }}
      onPointerMove={(e) => {
        lp.handlers.onPointerMove(e);
        swipe.handlers.onPointerMove(e);
        if (swipe.dragging()) swipeDragged.current = true;
      }}
      onPointerLeave={lp.handlers.onPointerLeave}
      onPointerCancel={(e) => {
        lp.handlers.onPointerUp();
        swipe.handlers.onPointerCancel(e);
      }}
      onContextMenu={lp.handlers.onContextMenu}
      role="button"
    >
      <div className="conv-row__avatar">
        <Avatar color={conv.avatarColor} text={conv.avatarText} size={48} imageRef={peerRef} members={memberAvatars} />
        {badge &&
          (dotOnly ? (
            <span className="conv-row__badge conv-row__badge--dot" />
          ) : (
            // M-I8: the OLD number leaves upward as the new one arrives from
            // below. M-H3's `badge-roll` only animated the arriving value, so
            // what you saw was 3 blinking into 4 — see RollingNumber.tsx.
            <span className="conv-row__badge">
              <RollingNumber value={conv.unreadCount > 99 ? '99+' : String(conv.unreadCount)} />
            </span>
          ))}
      </div>
      <div className="conv-row__main">
        <div className="conv-row__line1">
          <span className="conv-row__title">{conv.title}</span>
          <span className="conv-row__time">{listTimestamp(conv.lastMsgAt, NOW)}</span>
        </div>
        <div className="conv-row__line2">
          <span className="conv-row__preview">
            {conv.draft ? <span className="conv-row__draft">[草稿] </span> : null}
            {conv.mentionMe && !conv.draft ? <span className="conv-row__mention">[有人@我] </span> : null}
            {conv.draft ?? conv.lastMsgPreview}
          </span>
          {conv.isMuted && <MuteIcon />}
        </div>
      </div>
    </div>
    </div>
  );
}

function MuteIcon() {
  return (
    <svg className="conv-row__mute" width="15" height="15" viewBox="0 0 24 24" aria-label="免打扰">
      <path
        d="M12 4a5 5 0 0 0-5 5v3l-1.5 2.5h13L17 12V9a5 5 0 0 0-5-5zM10 18a2 2 0 0 0 4 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path d="M4 4l16 16" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
