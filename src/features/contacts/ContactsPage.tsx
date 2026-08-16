import { useNavigate } from 'react-router-dom';
import { NavBar } from '../../components/NavBar';
import { Avatar } from '../../components/Avatar';
import { IconPlus, IconSearch } from '../../components/icons';
import { useAppStore } from '../../store/appStore';
import { captureFlipSource, FLIP_KEYS } from '../../lib/flip';
import { useStagger, type StaggerRowProps } from '../../lib/useStagger';
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

export function ContactsPage() {
  const navigate = useNavigate();
  // First paint only (M-I8): the letter sections arrive in sequence instead of
  // all at once. Rows revealed by the A-Z rail or by scrolling do not replay —
  // the effect belongs to arriving at the list.
  const stagger = useStagger();
  let row = 0;
  const showToast = useAppStore((s) => s.showToast);
  // Select the STABLE array reference, then derive — a selector that returns a
  // fresh array (`.filter`) each call makes useSyncExternalStore loop (React #185).
  const allContacts = useAppStore((s) => s.contacts);
  const contacts = allContacts.filter((c) => c.type === 'ai');
  const groups = groupByInitial(contacts);
  const starred = contacts.filter((c) => c.isStarred);

  // A-Z rail made REAL (M-I6): letters come from the actual sections, taps and
  // finger drags land on them. It was seven hardcoded decorative glyphs.
  const rail = ['↑', ...(starred.length ? ['☆'] : []), ...groups.map(([letter]) => letter)];
  const jumpTo = (railKey: string) => {
    const id =
      railKey === '↑' ? 'contacts-top' : railKey === '☆' ? 'contacts-star' : `contacts-${railKey}`;
    document.getElementById(id)?.scrollIntoView({ block: 'start' });
  };
  const railFromPoint = (clientY: number, el: HTMLElement) => {
    const rect = el.getBoundingClientRect();
    const idx = Math.floor(((clientY - rect.top) / rect.height) * rail.length);
    return rail[Math.min(Math.max(idx, 0), rail.length - 1)];
  };

  return (
    <>
      <NavBar
        title="通讯录"
        right={
          <>
            <button className="navbar__btn" aria-label="搜索" onClick={() => navigate('/search')}>
              <IconSearch />
            </button>
            <button className="navbar__btn" aria-label="添加" onClick={() => navigate('/contact-new')}>
              <IconPlus />
            </button>
          </>
        }
      />
      <div className="page-body contacts">
        <div id="contacts-top" />
        <div className="contacts__functions">
          {FUNCTION_ENTRIES.map((f) => (
            <div
              key={f.key}
              className="contacts__row"
              role="button"
              onClick={() => {
                // M-D3: every visible entry goes somewhere real. 公众号 stays a
                // deliberate never-do (kept for 1:1 fidelity, light toast).
                if (f.key === 'group') navigate('/groups');
                else if (f.key === 'new') navigate('/new-friends');
                else if (f.key === 'chat-only') navigate('/contacts-chats-only');
                else if (f.key === 'tag') navigate('/contacts-tags');
                else showToast('暂未开放');
              }}
            >
              <div className="contacts__fn-icon" style={{ background: f.color }}>
                <FnGlyph kind={f.glyph} />
              </div>
              <span className="contacts__name hairline-bottom contacts__cell">{f.label}</span>
            </div>
          ))}
        </div>
        {starred.length > 0 && (
          <div className="contacts__group" id="contacts-star">
            <div className="contacts__index">星标朋友</div>
            {starred.map((cc) => (
              <ContactRow
                key={cc.id}
                name={cc.remark ?? cc.name}
                color={cc.avatarColor}
                text={cc.avatarText}
                imageRef={cc.avatarRef}
                flipKey={FLIP_KEYS.contactAvatar(cc.id)}
                stagger={stagger(row++)}
                onClick={() => navigate(`/contact/${cc.id}`)}
              />
            ))}
          </div>
        )}
        {groups.map(([letter, list]) => (
          <div key={letter} className="contacts__group" id={`contacts-${letter}`}>
            <div className="contacts__index">{letter}</div>
            {list.map((cc) => (
              <ContactRow
                key={cc.id}
                name={cc.remark ?? cc.name}
                color={cc.avatarColor}
                text={cc.avatarText}
                imageRef={cc.avatarRef}
                flipKey={FLIP_KEYS.contactAvatar(cc.id)}
                stagger={stagger(row++)}
                onClick={() => navigate(`/contact/${cc.id}`)}
              />
            ))}
          </div>
        ))}
        <div className="contacts__count">{contacts.length} 位联系人</div>
      </div>
      <div
        className="contacts__az"
        // Tap OR drag: pointermove tracks the finger so sliding down the rail
        // sweeps through sections, like the device does.
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          jumpTo(railFromPoint(e.clientY, e.currentTarget));
        }}
        onPointerMove={(e) => {
          if (e.buttons > 0) jumpTo(railFromPoint(e.clientY, e.currentTarget));
        }}
      >
        {rail.map((l) => (
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
  imageRef,
  onClick,
  flipKey,
  stagger,
}: {
  name: string;
  color: string;
  text: string;
  imageRef?: string;
  onClick?: () => void;
  /** Hand this row's avatar rect to the profile card's (M-I8, lib/flip.ts). */
  flipKey?: string;
  /** First-paint entrance props, or undefined for a row arriving later (M-I8). */
  stagger?: StaggerRowProps;
}) {
  return (
    <div
      className={`contacts__row${stagger?.className ? ` ${stagger.className}` : ''}`}
      style={stagger?.style}
      onClick={(e) => {
        // The avatar is found by query rather than held in a ref, deliberately:
        // a ref would need a wrapper element around <Avatar/>, and every row in
        // the contacts golden would shift by whatever that wrapper's box does.
        // Measured at the TAP, because the list scrolls (and unmounts) before
        // the profile card lays out, and a rect read late flies in from nowhere.
        if (flipKey) captureFlipSource(flipKey, e.currentTarget.querySelector('.avatar'));
        onClick?.();
      }}
    >
      <Avatar color={color} text={text} imageRef={imageRef} size={40} />
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
