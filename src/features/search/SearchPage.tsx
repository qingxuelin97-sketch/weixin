/**
 * Global search — contacts, conversations, message bodies, and Moments.
 *
 * The three 搜索 buttons in the nav bars have been inert placeholders since M1;
 * this is what they open.
 *
 * Results are computed synchronously from what the store already holds. That is
 * viable because the corpus is one person's history (see src/lib/search.ts for
 * why there is no index), and it keeps typing feedback instant with no loading
 * state to design around.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '../../store/appStore';
import { Avatar } from '../../components/Avatar';
import { IconBack, IconSearch } from '../../components/icons';
import { search, searchAll, groupByKind, highlightParts, type SearchHit } from '../../lib/search';
import { momentTimestamp } from '../../lib/time';
import { repo } from '../../db/repo';
import { logError } from '../../lib/errlog';
import { useNow } from '../../lib/useNow';
import './search.css';

function Highlighted({ text, ranges }: { text: string; ranges: Array<[number, number]> }) {
  return (
    <>
      {highlightParts(text, ranges).map((p, i) =>
        p.hit ? (
          <em key={i} className="search__hit">
            {p.text}
          </em>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

export function SearchPage() {
  const navigate = useNavigate();
  const [query, setQuery] = useState('');

  const contacts = useAppStore((s) => s.contacts);
  const conversations = useAppStore((s) => s.conversations);
  const messages = useAppStore((s) => s.messages);
  const moments = useAppStore((s) => s.moments);
  const loadMoments = useAppStore((s) => s.loadMoments);
  const contactById = useAppStore((s) => s.contactById);
  const now = useNow();

  // Moments are loaded lazily elsewhere; searching them requires them present.
  useEffect(() => {
    void loadMoments();
  }, [loadMoments]);

  // The in-memory pass renders instantly off what the store already holds.
  const shallow = useMemo(
    () => search({ contacts, conversations, messages, moments }, query),
    [contacts, conversations, messages, moments, query],
  );

  // …then the database pass replaces it, reaching history hydration never
  // loaded. Without this the app could not find a message it had stored
  // perfectly well: search only ever looked at the flat 200 per conversation
  // that hydration put in memory.
  const [deep, setDeep] = useState<{ query: string; hits: SearchHit[]; truncated: boolean } | null>(
    null,
  );
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setDeep(null);
      return;
    }
    let alive = true;
    void searchAll(
      { contacts, conversations, messages, moments },
      q,
      { page: (convId, beforeId, limit) => repo.getMessages(convId, { beforeId, limit }) },
    )
      .then((r) => {
        // Ignore a result whose query the user has already typed past.
        if (alive) setDeep({ query: q, hits: r.hits, truncated: r.truncated });
      })
      .catch((e) => logError('search.deep', e));
    return () => {
      alive = false;
    };
  }, [contacts, conversations, messages, moments, query]);

  const hits = deep && deep.query === query.trim() ? deep.hits : shallow;
  const groups = useMemo(() => groupByKind(hits), [hits]);

  const open = (h: SearchHit) => {
    switch (h.kind) {
      case 'contact': {
        // Prefer the existing conversation; fall back to the persona card.
        const conv = conversations.find((c) => c.type === 'single' && c.peerId === h.id);
        navigate(conv ? `/chat/${conv.id}` : `/persona/${h.id}`);
        break;
      }
      case 'conversation':
        navigate(`/chat/${h.id}`);
        break;
      case 'message':
        // Deep-linking to a specific message needs anchored scrolling in the
        // chat view; until that exists, open the conversation rather than
        // pretend to jump and land somewhere arbitrary.
        navigate(`/chat/${h.convId}`);
        break;
      case 'moment':
        navigate('/moments');
        break;
    }
  };

  const avatarFor = (h: SearchHit) => {
    if (h.kind === 'contact') {
      const c = contactById(h.id);
      return {
        text: c?.avatarText ?? '?',
        color: c?.avatarColor ?? 'var(--color-text-placeholder)',
        ref: c?.avatarRef,
      };
    }
    const conv = conversations.find((c) => c.id === (h.convId ?? h.id));
    if (conv) {
      const peer = conv.type === 'single' && conv.peerId ? contactById(conv.peerId) : undefined;
      return { text: conv.avatarText, color: conv.avatarColor, ref: peer?.avatarRef };
    }
    return { text: '圈', color: 'var(--color-text-placeholder)', ref: undefined };
  };

  return (
    <div className="page search">
      <header className="search__bar">
        <button className="search__back" aria-label="返回" onClick={() => navigate(-1)}>
          <IconBack />
        </button>
        <div className="search__field">
          <IconSearch />
          <input
            autoFocus
            value={query}
            placeholder="搜索"
            aria-label="搜索"
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button className="search__clear" aria-label="清除" onClick={() => setQuery('')}>
              ×
            </button>
          )}
        </div>
      </header>

      <div className="search__body">
        {!query.trim() ? (
          <p className="search__tip">搜索聊天记录、联系人、朋友圈</p>
        ) : groups.length === 0 ? (
          <p className="search__tip">
            没有找到「<span className="search__hit">{query.trim()}</span>」相关内容
          </p>
        ) : (
          groups.map((g) => (
            <section key={g.kind} className="search__group">
              <h2 className="search__group-title">{g.label}</h2>
              {g.hits.map((h) => {
                const av = avatarFor(h);
                // Contacts highlight the title; everything else highlights the
                // matched body text underneath.
                const titleRanges = h.kind === 'contact' || h.kind === 'conversation' ? h.ranges : [];
                return (
                  <button
                    key={`${h.kind}:${h.id}`}
                    className="search__row"
                    onClick={() => open(h)}
                  >
                    <Avatar text={av.text} color={av.color} imageRef={av.ref} size={40} />
                    <span className="search__text">
                      <span className="search__title">
                        <Highlighted text={h.title} ranges={titleRanges} />
                      </span>
                      {h.subtitle && (
                        <span className="search__sub">
                          <Highlighted text={h.subtitle} ranges={titleRanges.length ? [] : h.ranges} />
                        </span>
                      )}
                    </span>
                    {h.createdAt && (
                      <span className="search__time">{momentTimestamp(h.createdAt, now)}</span>
                    )}
                  </button>
                );
              })}
            </section>
          ))
        )}
      </div>
    </div>
  );
}
