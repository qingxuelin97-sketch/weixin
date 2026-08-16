import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { IconChats, IconContacts, IconDiscover, IconMe } from '../components/icons';
import { Badge } from '../components/Badge';
import { useAppStore } from '../store/appStore';

const TABS = [
  { path: '/chats', label: '微信', Icon: IconChats },
  { path: '/contacts', label: '通讯录', Icon: IconContacts },
  { path: '/discover', label: '发现', Icon: IconDiscover },
  { path: '/me', label: '我', Icon: IconMe },
] as const;

/** Persistent shell for the four root tabs. Child page renders via <Outlet/>. */
export function TabScaffold() {
  const location = useLocation();
  const navigate = useNavigate();
  const totalUnread = useAppStore((s) =>
    s.conversations.reduce((n, c) => n + (c.isMuted || c.isHidden ? 0 : c.unreadCount), 0),
  );

  return (
    <>
      <Outlet />
      <nav className="tabbar" role="tablist">
        {TABS.map(({ path, label, Icon }) => {
          const active = location.pathname === path;
          const showBadge = path === '/chats' && totalUnread > 0;
          return (
            <button
              key={path}
              className={`tabbar__item${active ? ' tabbar__item--active' : ''}`}
              role="tab"
              aria-selected={active}
              onClick={() => navigate(path)}
            >
              {/* Keyed on `active` so the nod REPLAYS on each switch: a class
                  that is merely present animates once, on mount, and then
                  never again (M-H3). */}
              <span
                key={active ? 'on' : 'off'}
                className={`tabbar__icon${active ? ' tab-bounce' : ''}`}
              >
                <Icon active={active} />
              </span>
              {showBadge && (
                <Badge key={`b${totalUnread}`} className="tabbar__badge badge-roll" count={totalUnread} />
              )}
              <span className="tabbar__label">{label}</span>
            </button>
          );
        })}
      </nav>
    </>
  );
}
