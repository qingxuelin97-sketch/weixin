import { NavBar } from '../../components/NavBar';
import { Avatar } from '../../components/Avatar';
import { useAppStore } from '../../store/appStore';
import './me.css';

const ENTRIES: Array<Array<{ key: string; label: string; color: string }>> = [
  [{ key: 'pay', label: '服务', color: 'var(--color-brand)' }],
  [
    { key: 'fav', label: '收藏', color: 'var(--wx-gold)' },
    { key: 'album', label: '朋友圈', color: 'var(--color-link)' },
    { key: 'cards', label: '卡包', color: 'var(--wx-gold)' },
    { key: 'sticker', label: '表情', color: 'var(--color-brand)' },
  ],
  [{ key: 'settings', label: '设置', color: 'var(--color-link)' }],
];

export function MePage() {
  const me = useAppStore((s) => s.contactById('self'));
  return (
    <>
      <NavBar title="" />
      <div className="page-body me">
        <div className="me__header hairline-bottom">
          <Avatar color={me?.avatarColor ?? 'var(--color-brand)'} text={me?.avatarText ?? '我'} size={64} />
          <div className="me__id">
            <div className="me__name">{me?.name ?? '我'}</div>
            <div className="me__wxid">微信号：{me?.wxid ?? '—'}</div>
          </div>
          <div className="me__qrcode">
            <span className="me__chevron">›</span>
          </div>
        </div>
        {ENTRIES.map((group, i) => (
          <div key={i} className="me__group">
            {group.map((e) => (
              <div key={e.key} className="me__row hairline-bottom">
                <div className="me__icon" style={{ background: e.color }} />
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
