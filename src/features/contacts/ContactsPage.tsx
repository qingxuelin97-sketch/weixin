import { NavBar } from '../../components/NavBar';
import { Avatar } from '../../components/Avatar';
import { IconPlus, IconSearch } from '../../components/icons';
import { useAppStore } from '../../store/appStore';
import './contacts.css';

const FUNCTION_ENTRIES = [
  { key: 'new', label: '新的朋友', color: 'var(--wx-gold)' },
  { key: 'group', label: '群聊', color: 'var(--color-brand)' },
  { key: 'tag', label: '标签', color: 'var(--color-link)' },
  { key: 'official', label: '公众号', color: 'var(--color-link)' },
];

export function ContactsPage() {
  const contacts = useAppStore((s) => s.contacts.filter((c) => c.type === 'ai'));
  // Group by pinyin initial for the A-Z index.
  const groups = groupByInitial(contacts);

  return (
    <>
      <NavBar
        title="通讯录"
        right={
          <>
            <button className="navbar__btn" aria-label="搜索">
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
            <div key={f.key} className="contacts__row hairline-bottom">
              <div className="contacts__fn-icon" style={{ background: f.color }} />
              <span className="contacts__name">{f.label}</span>
            </div>
          ))}
        </div>
        {groups.map(([letter, list]) => (
          <div key={letter} className="contacts__group">
            <div className="contacts__index">{letter}</div>
            {list.map((cc) => (
              <div key={cc.id} className="contacts__row hairline-bottom">
                <Avatar color={cc.avatarColor} text={cc.avatarText} size={40} />
                <span className="contacts__name">{cc.remark ?? cc.name}</span>
              </div>
            ))}
          </div>
        ))}
        <div className="contacts__count">{contacts.length} 位联系人</div>
      </div>
      <div className="contacts__az">
        {['A', 'C', 'L', 'M'].map((l) => (
          <span key={l}>{l}</span>
        ))}
      </div>
    </>
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
