import { NavBar } from '../../components/NavBar';
import './discover.css';

// Discover entries. Only 朋友圈 (M4) becomes real; the rest are shells (toast "开发中").
const SECTIONS: Array<Array<{ key: string; label: string; color: string; badge?: boolean }>> = [
  [{ key: 'moments', label: '朋友圈', color: 'var(--color-brand)', badge: true }],
  [
    { key: 'channels', label: '视频号', color: 'var(--wx-gold)' },
    { key: 'scan', label: '扫一扫', color: 'var(--color-link)' },
    { key: 'shake', label: '摇一摇', color: 'var(--color-link)' },
  ],
  [
    { key: 'look', label: '看一看', color: 'var(--wx-gold)' },
    { key: 'search', label: '搜一搜', color: 'var(--color-link)' },
  ],
  [{ key: 'miniapp', label: '小程序', color: 'var(--color-brand)' }],
];

export function DiscoverPage() {
  return (
    <>
      <NavBar title="发现" />
      <div className="page-body discover">
        {SECTIONS.map((section, i) => (
          <div key={i} className="discover__group">
            {section.map((entry) => (
              <div key={entry.key} className="discover__row hairline-bottom">
                <div className="discover__icon" style={{ background: entry.color }} />
                <span className="discover__label">{entry.label}</span>
                {entry.badge && <span className="discover__badge" />}
                <span className="discover__chevron">›</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
