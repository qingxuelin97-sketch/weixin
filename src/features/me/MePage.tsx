import { liveStatus, statusLabel } from '../../lib/status';
import { useNow } from '../../lib/useNow';
import { useNavigate } from 'react-router-dom';
import { NavBar } from '../../components/NavBar';
import { Avatar } from '../../components/Avatar';
import { useAppStore } from '../../store/appStore';
import './me.css';

/** Colored LINE icons for the Me page rows (device style, not filled squares). */
function MIcon({ kind }: { kind: string }) {
  const sw = 1.7;
  switch (kind) {
    case 'service': // green check-in-bubble
      return (
        <svg viewBox="0 0 26 26" className="me__svg" aria-hidden>
          <path
            d="M13 3.5c-5.2 0-9.5 3.5-9.5 7.8 0 2.4 1.4 4.6 3.5 6l-.8 3.2 3.6-1.8c1 .3 2.1.4 3.2.4 5.2 0 9.5-3.5 9.5-7.8S18.2 3.5 13 3.5z"
            fill="none"
            stroke="var(--color-brand)"
            strokeWidth={sw}
          />
          <path d="m9.5 11.5 2.5 2.5 4.5-5" fill="none" stroke="var(--color-brand)" strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'fav': // tri-color box
      return (
        <svg viewBox="0 0 26 26" className="me__svg" aria-hidden>
          <path d="M13 3.5 22 8v10l-9 4.5L4 18V8l9-4.5z" fill="none" stroke="var(--wx-dc-yellow)" strokeWidth={sw} strokeLinejoin="round" />
          <path d="M4 8l9 4.5L22 8M13 12.5v10" fill="none" stroke="var(--wx-dc-blue)" strokeWidth={sw} strokeLinejoin="round" />
        </svg>
      );
    case 'album': // photo
      return (
        <svg viewBox="0 0 26 26" className="me__svg" aria-hidden>
          <rect x="3.5" y="5" width="19" height="16" rx="2" fill="none" stroke="var(--wx-dc-blue)" strokeWidth={sw} />
          <path d="m3.5 17 5-5 4.5 4.5 3.5-3.5 6 6" fill="none" stroke="var(--wx-dc-blue)" strokeWidth={sw} strokeLinejoin="round" />
        </svg>
      );
    case 'works': // stacked cards
      return (
        <svg viewBox="0 0 26 26" className="me__svg" aria-hidden>
          <rect x="7" y="7" width="14" height="14" rx="2" fill="none" stroke="var(--wx-dc-blue)" strokeWidth={sw} />
          <path d="M5 17V6a2 2 0 0 1 2-2h11" fill="none" stroke="var(--wx-dc-blue)" strokeWidth={sw} strokeLinecap="round" />
        </svg>
      );
    case 'cards': // wallet smile
      return (
        <svg viewBox="0 0 26 26" className="me__svg" aria-hidden>
          <path d="M4 9c2-2.5 5.3-4 9-4s7 1.5 9 4" fill="none" stroke="var(--wx-dc-red)" strokeWidth={sw} strokeLinecap="round" />
          <path d="M4 13.5h18v5a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 4 18.5v-5z" fill="none" stroke="var(--wx-dc-red)" strokeWidth={sw} strokeLinejoin="round" />
        </svg>
      );
    case 'sticker': // yellow smiley
      return (
        <svg viewBox="0 0 26 26" className="me__svg" aria-hidden>
          <circle cx="13" cy="13" r="9.5" fill="none" stroke="var(--wx-dc-yellow)" strokeWidth={sw} />
          <circle cx="9.8" cy="10.8" r="1.1" fill="var(--wx-dc-yellow)" />
          <circle cx="16.2" cy="10.8" r="1.1" fill="var(--wx-dc-yellow)" />
          <path d="M9 15.5c1 1.4 2.4 2.2 4 2.2s3-.8 4-2.2" fill="none" stroke="var(--wx-dc-yellow)" strokeWidth={sw} strokeLinecap="round" />
        </svg>
      );
    case 'report': // bar chart (annual report)
      return (
        <svg viewBox="0 0 26 26" className="me__svg" aria-hidden>
          <rect x="4" y="14" width="4" height="7" rx="1" fill="none" stroke="var(--wx-dc-purple)" strokeWidth={sw} />
          <rect x="11" y="9" width="4" height="12" rx="1" fill="none" stroke="var(--wx-dc-purple)" strokeWidth={sw} />
          <rect x="18" y="5" width="4" height="16" rx="1" fill="none" stroke="var(--wx-dc-purple)" strokeWidth={sw} />
        </svg>
      );
    case 'settings': // gear
      return (
        <svg viewBox="0 0 26 26" className="me__svg" aria-hidden>
          <circle cx="13" cy="13" r="3.2" fill="none" stroke="var(--wx-dc-blue)" strokeWidth={sw} />
          <path
            d="M13 3.8v3M13 19.2v3M3.8 13h3M19.2 13h3M6.5 6.5l2.1 2.1M17.4 17.4l2.1 2.1M19.5 6.5l-2.1 2.1M8.6 17.4l-2.1 2.1"
            stroke="var(--wx-dc-blue)"
            strokeWidth={sw}
            strokeLinecap="round"
          />
        </svg>
      );
    default:
      return null;
  }
}

const GROUPS: Array<Array<{ key: string; label: string }>> = [
  [{ key: 'service', label: '服务（零钱）' }],
  [
    { key: 'fav', label: '收藏' },
    { key: 'album', label: '朋友圈' },
    { key: 'report', label: '聊天年度报告' },
    { key: 'cards', label: '小店与卡包' },
    { key: 'sticker', label: '表情' },
  ],
  [{ key: 'settings', label: '设置' }],
];

export function MePage() {
  const me = useAppStore((s) => s.contactById('self'));
  const showToast = useAppStore((s) => s.showToast);
  const navigate = useNavigate();
  const now = useNow();
  const statuses = useAppStore((s) => s.statuses);
  const myStatus = liveStatus(statuses, 'self', now);
  return (
    <>
      <NavBar title="" />
      <div className="page-body me">
        <div className="me__header" onClick={() => navigate('/profile')} role="button">
          <Avatar color={me?.avatarColor ?? 'var(--color-brand)'} text={me?.avatarText ?? '我'} imageRef={me?.avatarRef} size={64} />
          <div className="me__id">
            <div className="me__name">{me?.name ?? '我'}</div>
            <div className="me__wxid-row">
              <span className="me__wxid">微信号：{me?.wxid ?? '—'}</span>
            </div>
            <div className="me__pills">
              {/* 微信「状态」 (M-J7). This pill has shown 「暂未开放」 since M1 —
                  the same dead entry as the mic button before J7a: it is on the
                  screen, and pressing it tells you it is not there. */}
              {myStatus ? (
                <button
                  className="me__pill status-chip"
                  style={{ '--chip-tint': `var(${myStatus.option.tint})` } as React.CSSProperties}
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate('/status-set');
                  }}
                >
                  <span className="status-chip__emoji">{myStatus.option.emoji}</span>
                  {statusLabel(myStatus)}
                </button>
              ) : (
                <button
                  className="me__pill"
                  onClick={(e) => {
                    e.stopPropagation();
                    navigate('/status-set');
                  }}
                >
                  ＋ 状态
                </button>
              )}
              <button
                className="me__pill"
                onClick={(e) => {
                  e.stopPropagation();
                  navigate('/moments');
                }}
              >
                朋友圈
                <span className="me__pill-dot" />
              </button>
            </div>
          </div>
          <div className="me__right">
            {/* 我的二维码 (M-J7): the glyph has sat here since M1 as decoration.
                stopPropagation so it opens the code, not 个人信息. */}
            <span
              role="button"
              aria-label="我的二维码"
              onClick={(e) => {
                e.stopPropagation();
                navigate('/qrcode');
              }}
            >
              <QrGlyph />
            </span>
            <span className="me__chevron">›</span>
          </div>
        </div>
        {GROUPS.map((group, i) => (
          <div key={i} className="me__group">
            {group.map((e, j) => (
              <div
                key={e.key}
                className={`me__row${j < group.length - 1 ? ' me__row--divided' : ''}`}
                onClick={() => {
                  if (e.key === 'settings') navigate('/settings');
                  else if (e.key === 'service') navigate('/wallet');
                  else if (e.key === 'album') navigate('/moments');
                  else if (e.key === 'report') navigate('/report');
                  else if (e.key === 'fav') navigate('/favorites');
                  else showToast('暂未开放');
                }}
              >
                <MIcon kind={e.key} />
                <span className="me__label">{e.label}</span>
                <span className="me__chevron">›</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}

function QrGlyph() {
  return (
    <svg viewBox="0 0 20 20" width="17" height="17" aria-hidden>
      <g fill="none" stroke="var(--color-text-secondary)" strokeWidth="1.4">
        <rect x="2" y="2" width="6" height="6" />
        <rect x="12" y="2" width="6" height="6" />
        <rect x="2" y="12" width="6" height="6" />
        <path d="M12 12h2.5v2.5H12zM15.5 15.5H18V18h-2.5z" />
      </g>
    </svg>
  );
}
