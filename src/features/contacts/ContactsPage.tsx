import { useNavigate } from 'react-router-dom';
import { NavBar } from '../../components/NavBar';
import { Avatar } from '../../components/Avatar';
import { IconPlus, IconSearch } from '../../components/icons';
import { useAppStore } from '../../store/appStore';
import './contacts.css';

/**
 * Contacts function entries — white glyph on a colored rounded square, colors
 * matched to the device screenshot (orange/orange/green/blue/deep-blue/light-blue).
 */
const FUNCTION_ENTRIES = [
  { key: 'new', label: '新的朋友', color: 'var(--wx-fn-orange)', glyph: 'person-add' },
  { key: 'chat-only', label: '仅聊天的朋友', color: 'var(--wx-fn-orange)', glyph: 'chat-person' },
  { key: 'group', label: '群聊', color: 'var(--color-brand)', glyph: 'people' },
  { key: 'tag', label: '标签', color: 'var(--wx-fn-blue)', glyph: 'tag' },
  { key: 'official', label: '公众号', color: 'var(--wx-fn-deep-blue)', glyph: 'official' },
] as const;

function FnGlyph({ kind }: { kind: string }) {
  switch (kind) {
    case 'person-add':
      return (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden>
          <circle cx="10" cy="8.5" r="3.4" fill="currentColor" />
          <path d="M3.5 19c0-3.3 2.8-5.5 6.5-5.5s6.5 2.2 6.5 5.5" fill="currentColor" />
          <path d="M18.5 8v5M16 10.5h5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    case 'chat-person':
      return (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden>
          <path
            d="M12 3.5c-4.7 0-8.5 3-8.5 6.8 0 2.1 1.2 4 3 5.2l-.7 2.7 3.1-1.5c1 .3 2 .4 3.1.4 4.7 0 8.5-3 8.5-6.8S16.7 3.5 12 3.5z"
            fill="currentColor"
          />
          <circle cx="12" cy="9.5" r="2" fill="var(--wx-fn-orange)" />
          <path d="M8.5 14c.7-1.2 2-1.9 3.5-1.9s2.8.7 3.5 1.9" stroke="var(--wx-fn-orange)" strokeWidth="1.4" fill="none" strokeLinecap="round" />
        </svg>
      );
    case 'people':
      return (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden>
          <circle cx="9" cy="9" r="3.2" fill="currentColor" />
          <path d="M2.8 18.5c0-3 2.6-5 6.2-5s6.2 2 6.2 5" fill="currentColor" />
          <circle cx="16.5" cy="9.5" r="2.6" fill="currentColor" />
          <path d="M16 13.8c3 .2 5.2 2 5.2 4.7h-4" fill="currentColor" />
        </svg>
      );
    case 'tag':
      return (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden>
          <path
            d="M4 5.5A1.5 1.5 0 0 1 5.5 4h5.4c.4 0 .8.16 1.06.44l7.6 7.6a1.5 1.5 0 0 1 0 2.12l-5.4 5.4a1.5 1.5 0 0 1-2.12 0l-7.6-7.6A1.5 1.5 0 0 1 4 10.9V5.5z"
            fill="currentColor"
          />
          <circle cx="8.5" cy="8.5" r="1.4" fill="var(--wx-fn-blue)" />
        </svg>
      );
    case 'official':
      return (
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" aria-hidden>
          <path d="M12 4c4 2.5 6.5 6.5 6.5 10.5 0 2.5-1.2 4.5-3.2 5.5-2-.8-3.3-2.6-3.3-5V4z" fill="currentColor" />
          <path d="M12 4C8 6.5 5.5 10.5 5.5 14.5c0 2.5 1.2 4.5 3.2 5.5 2-.8 3.3-2.6 3.3-5V4z" fill="currentColor" opacity="0.75" />
        </svg>
      );
    default:
      return null;
  }
}

const INDEX_RAIL = ['↑', '☆', 'A', 'C', 'L', 'M', '#'];

export function ContactsPage() {
  const navigate = useNavigate();
  // Select the STABLE array reference, then derive — a selector that returns a
  // fresh array (`.filter`) each call makes useSyncExternalStore loop (React #185).
  const allContacts = useAppStore((s) => s.contacts);
  const contacts = allContacts.filter((c) => c.type === 'ai');
  const groups = groupByInitial(contacts);
  const starred = contacts.filter((c) => (c as { isStarred?: boolean }).isStarred);

  return (
    <>
      <NavBar
        title="通讯录"
        right={
          <>
            <button className="navbar__btn" aria-label="搜索" onClick={() => navigate('/search')}>
              <IconSearch />
            </button>
            <button className="navbar__btn" aria-label="添加">
              <IconPlus />
            </button>
          </>
        }
      />
      <div className="page-body contacts">
        <div className="contacts__functions">
          {FUNCTION_ENTRIES.map((f) => (
            <div key={f.key} className="contacts__row">
              <div className="contacts__fn-icon" style={{ background: f.color }}>
                <FnGlyph kind={f.glyph} />
              </div>
              <span className="contacts__name hairline-bottom contacts__cell">{f.label}</span>
            </div>
          ))}
        </div>
        {starred.length > 0 && (
          <div className="contacts__group">
            <div className="contacts__index">星标朋友</div>
            {starred.map((cc) => (
              <ContactRow
                key={cc.id}
                name={cc.remark ?? cc.name}
                color={cc.avatarColor}
                text={cc.avatarText}
                onClick={() => navigate(`/persona/${cc.id}`)}
              />
            ))}
          </div>
        )}
        {groups.map(([letter, list]) => (
          <div key={letter} className="contacts__group">
            <div className="contacts__index">{letter}</div>
            {list.map((cc) => (
              <ContactRow
                key={cc.id}
                name={cc.remark ?? cc.name}
                color={cc.avatarColor}
                text={cc.avatarText}
                onClick={() => navigate(`/persona/${cc.id}`)}
              />
            ))}
          </div>
        ))}
        <div className="contacts__count">{contacts.length} 位联系人</div>
      </div>
      <div className="contacts__az">
        {INDEX_RAIL.map((l) => (
          <span key={l}>{l}</span>
        ))}
      </div>
    </>
  );
}

function ContactRow({
  name,
  color,
  text,
  onClick,
}: {
  name: string;
  color: string;
  text: string;
  onClick?: () => void;
}) {
  return (
    <div className="contacts__row" onClick={onClick}>
      <Avatar color={color} text={text} size={40} />
      <span className="contacts__name hairline-bottom contacts__cell">{name}</span>
    </div>
  );
}

function groupByInitial<T extends { pinyinInitial?: string }>(items: T[]): Array<[string, T[]]> {
  const map = new Map<string, T[]>();
  for (const it of items) {
    const k = it.pinyinInitial ?? '#';
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(it);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}
