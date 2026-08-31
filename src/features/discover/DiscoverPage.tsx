import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { NavBar } from '../../components/NavBar';
import { Avatar } from '../../components/Avatar';
import { Badge } from '../../components/Badge';
import { IconPlus, IconSearch } from '../../components/icons';
import { useAppStore } from '../../store/appStore';
import './discover.css';

/**
 * Discover rows — colored LINE icons (not filled squares), matching the device
 * screenshot: 朋友圈 rainbow disc, 视频号 orange bow, 直播, 扫一扫 blue, 听一听 red
 * note, 看一看 yellow, 搜一搜 red, 附近的人 blue pair, 游戏, 小程序 purple.
 * Only 朋友圈 becomes real (M4); the rest are shells.
 */
function DIcon({ kind }: { kind: string }) {
  const sw = 1.7;
  switch (kind) {
    case 'moments': // rainbow camera disc
      return (
        <svg viewBox="0 0 26 26" className="discover__svg" aria-hidden>
          <circle cx="13" cy="13" r="10" fill="none" stroke="var(--wx-dc-gray)" strokeWidth={sw} />
          <path d="M13 3a10 10 0 0 1 8.6 5" fill="none" stroke="var(--wx-dc-red)" strokeWidth={sw} />
          <path d="M21.6 8a10 10 0 0 1-.3 10.3" fill="none" stroke="var(--wx-dc-yellow)" strokeWidth={sw} />
          <path d="M21.3 18.3A10 10 0 0 1 9 22.2" fill="none" stroke="var(--wx-dc-green)" strokeWidth={sw} />
          <path d="M9 22.2A10 10 0 0 1 3.4 10" fill="none" stroke="var(--wx-dc-blue)" strokeWidth={sw} />
          <circle cx="13" cy="13" r="4.2" fill="none" stroke="var(--wx-dc-gray)" strokeWidth={sw} />
        </svg>
      );
    case 'channels': // orange bow (video account)
      return (
        <svg viewBox="0 0 26 26" className="discover__svg" aria-hidden>
          <path
            d="M13 13 5.6 8.2a2.4 2.4 0 0 0-3.6 2v5.6a2.4 2.4 0 0 0 3.6 2L13 13zm0 0 7.4-4.8a2.4 2.4 0 0 1 3.6 2v5.6a2.4 2.4 0 0 1-3.6 2L13 13z"
            fill="none"
            stroke="var(--wx-dc-orange)"
            strokeWidth={sw}
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'live': // concentric circles
      return (
        <svg viewBox="0 0 26 26" className="discover__svg" aria-hidden>
          <circle cx="13" cy="13" r="9.5" fill="none" stroke="var(--wx-dc-red)" strokeWidth={sw} />
          <circle cx="13" cy="13" r="4" fill="none" stroke="var(--wx-dc-red)" strokeWidth={sw} />
        </svg>
      );
    case 'scan': // scan frame
      return (
        <svg viewBox="0 0 26 26" className="discover__svg" aria-hidden>
          <path
            d="M4 9V6a2 2 0 0 1 2-2h3M17 4h3a2 2 0 0 1 2 2v3M22 17v3a2 2 0 0 1-2 2h-3M9 22H6a2 2 0 0 1-2-2v-3"
            fill="none"
            stroke="var(--wx-dc-blue)"
            strokeWidth={sw}
            strokeLinecap="round"
          />
          <path d="M4 13h18" stroke="var(--wx-dc-blue)" strokeWidth={sw} strokeLinecap="round" />
        </svg>
      );
    case 'listen': // music note
      return (
        <svg viewBox="0 0 26 26" className="discover__svg" aria-hidden>
          <path
            d="M10 19.5V6.8l9-2v12.4"
            fill="none"
            stroke="var(--wx-dc-red)"
            strokeWidth={sw}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <ellipse cx="7.5" cy="19.5" rx="2.6" ry="2.2" fill="none" stroke="var(--wx-dc-red)" strokeWidth={sw} />
          <ellipse cx="16.5" cy="17.2" rx="2.6" ry="2.2" fill="none" stroke="var(--wx-dc-red)" strokeWidth={sw} />
        </svg>
      );
    case 'look': // yellow flower badge
      return (
        <svg viewBox="0 0 26 26" className="discover__svg" aria-hidden>
          <path
            d="M13 3.5 15.6 6l3.5-.7.7 3.5 3.2 1.7-1.7 3.2 1.7 3.2-3.2 1.7-.7 3.5-3.5-.7-2.6 2.4-2.6-2.4-3.5.7-.7-3.5-3.2-1.7 1.7-3.2-1.7-3.2 3.2-1.7.7-3.5 3.5.7L13 3.5z"
            fill="none"
            stroke="var(--wx-dc-yellow)"
            strokeWidth={sw}
            strokeLinejoin="round"
          />
        </svg>
      );
    case 'search': // sparkle search
      return (
        <svg viewBox="0 0 26 26" className="discover__svg" aria-hidden>
          <path
            d="M13 4v6M13 16v6M4 13h6M16 13h6M7 7l3.5 3.5M15.5 15.5 19 19M19 7l-3.5 3.5M10.5 15.5 7 19"
            stroke="var(--wx-dc-red)"
            strokeWidth={sw}
            strokeLinecap="round"
          />
        </svg>
      );
    case 'nearby': // two people
      return (
        <svg viewBox="0 0 26 26" className="discover__svg" aria-hidden>
          <circle cx="9" cy="7.5" r="2.6" fill="none" stroke="var(--wx-dc-blue)" strokeWidth={sw} />
          <path d="M5 21v-6a4 4 0 0 1 8 0v6" fill="none" stroke="var(--wx-dc-blue)" strokeWidth={sw} strokeLinecap="round" />
          <circle cx="18" cy="7.5" r="2.3" fill="none" stroke="var(--wx-dc-blue)" strokeWidth={sw} />
          <path d="M15.5 21v-5.5a3.5 3.5 0 0 1 7 0V21" fill="none" stroke="var(--wx-dc-blue)" strokeWidth={sw} strokeLinecap="round" />
        </svg>
      );
    case 'games': // diamond compass
      return (
        <svg viewBox="0 0 26 26" className="discover__svg" aria-hidden>
          <path d="M13 3.5 22.5 13 13 22.5 3.5 13z" fill="none" stroke="var(--wx-dc-green)" strokeWidth={sw} strokeLinejoin="round" />
          <path d="M13 8.5 17.5 13 13 17.5 8.5 13z" fill="none" stroke="var(--wx-dc-red)" strokeWidth={sw} strokeLinejoin="round" />
        </svg>
      );
    case 'miniapp': // purple S-in-circle
      return (
        <svg viewBox="0 0 26 26" className="discover__svg" aria-hidden>
          <circle cx="13" cy="13" r="9.5" fill="none" stroke="var(--wx-dc-purple)" strokeWidth={sw} />
          <path
            d="M15.8 8.8c-2.4-1-5 .2-5.3 2.2-.3 1.8 1.3 2.6 3 3 1.7.4 3.3 1.2 3 3-.3 2-2.9 3.2-5.3 2.2"
            fill="none"
            stroke="var(--wx-dc-purple)"
            strokeWidth={sw}
            strokeLinecap="round"
          />
        </svg>
      );
    default:
      return null;
  }
}

interface Row {
  key: string;
  label: string;
  extra?: 'badge' | 'avatar-dot' | 'text';
  extraText?: string;
  badge?: number;
}

const SECTIONS: Row[][] = [
  [{ key: 'moments', label: '朋友圈', extra: 'avatar-dot' }],
  [
    { key: 'channels', label: '视频号' },
    { key: 'live', label: '直播' },
  ],
  [
    { key: 'scan', label: '扫一扫' },
    { key: 'listen', label: '听一听' },
  ],
  [
    { key: 'look', label: '看一看' },
    { key: 'search', label: '搜一搜' },
  ],
  [{ key: 'nearby', label: '附近的人' }],
  [{ key: 'games', label: '游戏' }],
  [{ key: 'miniapp', label: '小程序' }],
];

/** Only 朋友圈 navigates; the rest toast honestly instead of eating the tap. */
const ROUTES: Record<string, string> = { moments: '/moments', search: '/search' };

export function DiscoverPage() {
  const navigate = useNavigate();
  const showToast = useAppStore((s) => s.showToast);
  // 朋友圈红点 (M-I15): likes/comments on YOUR posts since you last opened the
  // feed. Derived from storage on mount — the badge must survive restarts, so
  // it is never a counter that only lives in memory.
  const momentsNews = useAppStore((s) => s.momentsNews);
  const refreshMomentsNews = useAppStore((s) => s.refreshMomentsNews);
  const contactById = useAppStore((s) => s.contactById);
  useEffect(() => {
    void refreshMomentsNews().catch(() => {});
  }, [refreshMomentsNews]);
  const newsActor = momentsNews.actorId ? contactById(momentsNews.actorId) : undefined;
  return (
    <>
      <NavBar
        title="发现"
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
      <div className="page-body discover">
        {SECTIONS.map((section, i) => (
          <div key={i} className="discover__group">
            {section.map((entry, j) => (
              <div
                key={entry.key}
                className={`discover__row${j < section.length - 1 ? ' hairline-bottom' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() =>
                  ROUTES[entry.key] ? navigate(ROUTES[entry.key]) : showToast('暂未开放')
                }
              >
                <DIcon kind={entry.key} />
                <span className="discover__label">{entry.label}</span>
                {entry.extra === 'badge' && entry.badge != null && (
                  <Badge className="discover__num-badge" count={entry.badge} />
                )}
                {entry.extra === 'avatar-dot' && momentsNews.count > 0 && (
                  // WeChat's idiom: the ACTOR's face plus a red dot — the row
                  // tells you WHO before you even enter the feed (M-I15).
                  <span className="discover__avatar-dot">
                    <span className="discover__news-hint">有新消息</span>
                    <span className="discover__avatar-wrap">
                      {newsActor ? (
                        <Avatar
                          text={newsActor.avatarText}
                          color={newsActor.avatarColor}
                          imageRef={newsActor.avatarRef}
                          size={26}
                        />
                      ) : (
                        <span className="discover__mini-avatar" />
                      )}
                      {/* The 「有新消息」 text above already names it. */}
                      <Badge className="discover__reddot" dot />
                    </span>
                  </span>
                )}
                <span className="discover__chevron">›</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
