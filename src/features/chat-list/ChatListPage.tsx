import { useMemo } from 'react';
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


export function ChatListPage() {
  const all = useAppStore((s) => s.conversations);
  const showToast = useAppStore((s) => s.showToast);
  // Hidden (AI↔AI DM) conversations must never surface here.
  const conversations = useMemo(() => all.filter((c) => !c.isHidden), [all]);
  const navigate = useNavigate();
  const totalUnread = conversations.reduce((n, c) => n + (c.isMuted ? 0 : c.unreadCount), 0);

  return (
    <>
      <NavBar
        title={totalUnread > 0 ? `微信(${totalUnread})` : '微信'}
        right={
          <>
            <button className="navbar__btn" aria-label="搜索" onClick={() => navigate('/search')}>
              <IconSearch />
            </button>
            <button className="navbar__btn" aria-label="更多" onClick={() => showToast('暂未开放')}>
              <IconPlus />
            </button>
          </>
        }
      />
      <div className="page-body chat-list">
        <Virtuoso
          data={conversations}
          itemContent={(_i, conv) => (
            <ConversationRow conv={conv} onOpen={() => navigate(`/chat/${conv.id}`)} />
          )}
        />
      </div>
    </>
  );
}

function ConversationRow({ conv, onOpen }: { conv: ConversationVM; onOpen: () => void }) {
  const NOW = useNow();
  const badge = conv.unreadCount > 0;
  // Muted conversations show a small red dot instead of a numeric badge (device behavior).
  const dotOnly = conv.isMuted;
  return (
    <div
      className={`conv-row hairline-bottom${conv.isPinned ? ' conv-row--pinned' : ''}`}
      onClick={onOpen}
      role="button"
    >
      <div className="conv-row__avatar">
        <Avatar color={conv.avatarColor} text={conv.avatarText} size={48} members={conv.memberAvatars} />
        {badge && (
          <span className={`conv-row__badge${dotOnly ? ' conv-row__badge--dot' : ''}`}>
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
