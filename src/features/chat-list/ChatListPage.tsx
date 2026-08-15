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
import { showConfirm } from '../../components/dialog';

const LONG_PRESS_MS = 500;

export function ChatListPage() {
  const all = useAppStore((s) => s.conversations);
  const showToast = useAppStore((s) => s.showToast);
  const patchConversation = useAppStore((s) => s.patchConversation);
  const deleteConversation = useAppStore((s) => s.deleteConversation);
  // Hidden (AI↔AI DM) conversations must never surface here.
  const conversations = useMemo(() => all.filter((c) => !c.isHidden), [all]);
  const navigate = useNavigate();
  const totalUnread = conversations.reduce((n, c) => n + (c.isMuted ? 0 : c.unreadCount), 0);

  const [plusOpen, setPlusOpen] = useState(false);
  const [menu, setMenu] = useState<{ conv: ConversationVM; y: number } | null>(null);

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
      <div className="page-body chat-list">
        <Virtuoso
          data={conversations}
          itemContent={(_i, conv) => (
            <ConversationRow
              conv={conv}
              onOpen={() => navigate(`/chat/${conv.id}`)}
              onLongPress={(y) => setMenu({ conv, y })}
              onRead={() =>
                act(() =>
                  patchConversation(
                    conv.id,
                    conv.unreadCount > 0 ? { unreadCount: 0, mentionMe: false } : { unreadCount: 1 },
                  ),
                )
              }
              onDelete={() => confirmDelete(conv)}
            />
          )}
        />
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
  onOpen,
  onLongPress,
  onRead,
  onDelete,
}: {
  conv: ConversationVM;
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

  // Long-press via pointer timer; movement/release cancels so scrolling stays natural.
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);
  const cancelPress = () => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = null;
  };
  // The gesture WeChat actually uses for these two actions (M-H3). The long
  // press stays: it carries 置顶 / 免打扰 too, and muscle memory is cheap to
  // honour.
  const swipe = useSwipeRow(TRAY_WIDTH);

  return (
    <div className="conv-swipe">
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
        } else if (!fired.current) {
          onOpen();
        }
        fired.current = false;
      }}
      onPointerDown={(e) => {
        fired.current = false;
        swipe.handlers.onPointerDown(e);
        const y = e.clientY;
        pressTimer.current = setTimeout(() => {
          fired.current = true;
          onLongPress(y);
        }, LONG_PRESS_MS);
      }}
      onPointerUp={() => {
        cancelPress();
        swipe.handlers.onPointerUp();
      }}
      onPointerMove={(e) => {
        cancelPress();
        swipe.handlers.onPointerMove(e);
        if (swipe.dragging()) fired.current = true;
      }}
      onPointerLeave={cancelPress}
      onPointerCancel={(e) => {
        cancelPress();
        swipe.handlers.onPointerCancel(e);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        fired.current = true;
        onLongPress(e.clientY);
      }}
      role="button"
    >
      <div className="conv-row__avatar">
        <Avatar color={conv.avatarColor} text={conv.avatarText} size={48} imageRef={peerRef} members={memberAvatars} />
        {badge && (
          // Keyed on the count so a changed number rolls in rather than
          // swapping in place (M-H3).
          <span
            key={`n${conv.unreadCount}`}
            className={`conv-row__badge badge-roll${dotOnly ? ' conv-row__badge--dot' : ''}`}
          >
            {dotOnly ? '' : conv.unreadCount > 99 ? '99+' : conv.unreadCount}
          </span>
        )}
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
