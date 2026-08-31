import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { IconChats, IconContacts, IconDiscover, IconMe } from '../components/icons';
import { Badge } from '../components/Badge';
import { useAppStore } from '../store/appStore';
import { totalUnread as totalUnreadOf } from '../lib/unread';

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
  // Muted and HIDDEN threads are excluded — see lib/unread.ts for why the rule
  // lives in one place now.
  const totalUnread = useAppStore((s) => totalUnreadOf(s.conversations));

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
                // One badge component, and the roll lives inside it (M-I0 ×
                // M-I8): no `key` remount trick, no per-site `badge-roll`.
                <Badge className="tabbar__badge" count={totalUnread} />
              )}
              <span className="tabbar__label">{label}</span>
            </button>
          );
        })}
      </nav>
    </>
  );
}
