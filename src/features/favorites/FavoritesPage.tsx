/**
 * 收藏 (M-I13; upgraded M-J12): everything the user long-press-favorited,
 * filterable by type — now also full-text searchable, writable (「笔记」rows
 * the user types directly), and forwardable back into a chat.
 *
 * Renders SNAPSHOTS — the favorite carries its own content/meta copy, so rows
 * survive the source message (or thread) being deleted. Hidden-conversation
 * rows never arrive here at all: `repo.getFavorites()` filters them out at the
 * repo layer, the same defense-in-depth as global search — and the forward
 * sheet's TARGET list keeps the same rule via `forwardableConversations`.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SubNav } from '../../components/SubNav';
import { Sheet } from '../../components/Sheet';
import { ForwardSheet } from '../../components/ForwardSheet';
import { showConfirm } from '../../components/dialog';
import { useLongPress } from '../../components/useLongPress';
import { LongPressMenu, type LongPressMenuItem } from '../../components/LongPressMenu';
import { IconSearch } from '../../components/icons';
import { repo } from '../../db/repo';
import { logError } from '../../lib/errlog';
import { chatTimestamp } from '../../lib/time';
import { useNow } from '../../lib/useNow';
import {
  filterFavorites,
  forwardMessageOf,
  isForwardable,
  makeNoteFavorite,
  editedNote,
} from '../../lib/favorites';
import { useAppStore } from '../../store/appStore';
import { stickerGlyph } from '../../data/stickers';
import { resolveImageRef } from '../../data/moments-images';
import { useMedia } from '../../components/useMedia';
import { humanSize } from '../../ai/bubble-materialize';
import { RPS_GLYPHS, diceResult, rpsResult } from '../../lib/game';
import type { FavoriteVM } from '../../data/types';
import './favorites.css';

/** Filter chips: a label plus the snapshot kinds it admits. */
const FILTERS: Array<{ key: string; label: string; types?: Array<FavoriteVM['type']> }> = [
  { key: 'all', label: '全部' },
  { key: 'note', label: '笔记', types: ['note'] },
  { key: 'text', label: '文字', types: ['text'] },
  { key: 'image', label: '图片', types: ['image'] },
  { key: 'voice', label: '语音', types: ['voice'] },
  { key: 'link', label: '链接', types: ['link'] },
  { key: 'file', label: '文件', types: ['file'] },
  { key: 'location', label: '位置', types: ['location'] },
  { key: 'merged', label: '聊天记录', types: ['merged'] },
];

export function FavoritesPage() {
  const NOW = useNow();
  const navigate = useNavigate();
  const appendMessage = useAppStore((s) => s.appendMessage);
  const showToast = useAppStore((s) => s.showToast);
  const [rows, setRows] = useState<FavoriteVM[] | null>(null);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');

  // 笔记 editor sheet: 'new' = composing a fresh note, a row = editing it.
  const [noteTarget, setNoteTarget] = useState<'new' | FavoriteVM | null>(null);
  const [noteDraft, setNoteDraft] = useState('');

  // Long-press menu + the forward sheet it can open.
  const [menu, setMenu] = useState<{ fav: FavoriteVM; x: number; y: number } | null>(null);
  const [forwarding, setForwarding] = useState<FavoriteVM | null>(null);

  useEffect(() => {
    let alive = true;
    void repo
      .getFavorites()
      .then((r) => alive && setRows(r))
      .catch((e) => {
        logError('favorites.load', e);
        if (alive) setRows([]);
      });
    return () => {
      alive = false;
    };
  }, []);

  const shown = useMemo(() => {
    if (!rows) return [];
    const f = FILTERS.find((x) => x.key === filter);
    const byType = f?.types
      ? rows.filter((r) => (f.types as Array<FavoriteVM['type']>).includes(r.type))
      : rows;
    // Full-text pass AFTER the type chip — the two narrow together.
    return filterFavorites(byType, query);
  }, [rows, filter, query]);

  // Image favorites resolve through the lazy media registry, like the chat.
  useMedia(
    useMemo(() => shown.filter((r) => r.type === 'image').map((r) => r.content), [shown]),
  );

  const remove = async (f: FavoriteVM) => {
    const ok = await showConfirm({ title: '删除这条收藏？' });
    if (!ok) return;
    try {
      await repo.deleteFavorite(f.id);
      setRows((rs) => (rs ? rs.filter((r) => r.id !== f.id) : rs));
    } catch (e) {
      logError('favorites.delete', e);
    }
  };

  const saveNote = async () => {
    const text = noteDraft.trim();
    const target = noteTarget;
    if (!text || !target) return;
    const row = target === 'new' ? makeNoteFavorite(text, Date.now()) : editedNote(target, text);
    setNoteTarget(null);
    setNoteDraft('');
    try {
      await repo.putFavorite(row);
      setRows((rs) => {
        if (!rs) return rs;
        const rest = rs.filter((r) => r.id !== row.id);
        return [...rest, row].sort((a, b) => b.favedAt - a.favedAt);
      });
    } catch (e) {
      logError('favorites.note', e);
    }
  };

  const forwardTo = async (f: FavoriteVM, convId: string, convTitle: string) => {
    const msg = forwardMessageOf(f, convId, Date.now());
    if (!msg) return;
    try {
      await appendMessage(msg);
      showToast(`已转发给 ${convTitle}`);
    } catch (e) {
      logError('favorites.forward', e);
    }
  };

  const menuItems = (f: FavoriteVM): LongPressMenuItem[] => {
    const items: LongPressMenuItem[] = [];
    if (isForwardable(f)) {
      items.push({ label: '转发到聊天', onSelect: () => setForwarding(f) });
    }
    if (f.type === 'note') {
      items.push({
        label: '编辑',
        onSelect: () => {
          setNoteDraft(f.content ?? '');
          setNoteTarget(f);
        },
      });
    }
    items.push({ label: '删除', onSelect: () => void remove(f) });
    return items;
  };

  return (
    <>
      <SubNav
        title="收藏"
        right={
          <button
            className="navbar__btn favorites__add"
            aria-label="新建笔记"
            onClick={() => {
              setNoteDraft('');
              setNoteTarget('new');
            }}
          >
            ＋
          </button>
        }
      />
      <div className="page-body favorites">
        <div className="favorites__searchbar">
          <IconSearch />
          <input
            value={query}
            placeholder="搜索收藏"
            aria-label="搜索收藏"
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button className="favorites__search-clear" aria-label="清除" onClick={() => setQuery('')}>
              ×
            </button>
          )}
        </div>
        <div className="favorites__filters">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              className={`favorites__chip${filter === f.key ? ' favorites__chip--on' : ''}`}
              onClick={() => setFilter(f.key)}
            >
              {f.label}
            </button>
          ))}
        </div>
        {rows != null && shown.length === 0 && (
          <div className="favorites__empty">
            {query.trim()
              ? '没有匹配的收藏'
              : filter === 'all'
                ? '长按聊天里的消息即可收藏，点右上角 + 可以写笔记'
                : filter === 'note'
                  ? '还没有笔记。点右上角 + 写一条。'
                  : '这个分类下还没有收藏'}
          </div>
        )}
        {shown.map((f) => (
          <FavoriteItem
            key={f.id}
            fav={f}
            now={NOW}
            onContactTap={(cid) => navigate(`/contact/${cid}`)}
            onDelete={() => void remove(f)}
            onLongPress={(x, y) => setMenu({ fav: f, x, y })}
          />
        ))}
      </div>

      {menu && (
        <LongPressMenu
          at={{ x: menu.x, y: menu.y }}
          layout="column"
          label="收藏操作"
          onClose={() => setMenu(null)}
          items={menuItems(menu.fav)}
        />
      )}

      <ForwardSheet
        open={forwarding != null}
        onClose={() => setForwarding(null)}
        onPick={(c) => {
          const f = forwarding;
          if (f) void forwardTo(f, c.id, c.title);
        }}
      />

      {noteTarget != null && (
        <Sheet
          open
          onClose={() => setNoteTarget(null)}
          title={noteTarget === 'new' ? '新建笔记' : '编辑笔记'}
        >
          <div className="favorites__note-editor">
            <textarea
              autoFocus
              value={noteDraft}
              placeholder="写点什么…"
              aria-label="笔记内容"
              onChange={(e) => setNoteDraft(e.target.value)}
            />
            <button
              className="favorites__note-save"
              disabled={!noteDraft.trim()}
              onClick={() => void saveNote()}
            >
              保存
            </button>
          </div>
        </Sheet>
      )}
    </>
  );
}

/**
 * One row: content + source line, with the long-press menu gesture. Its own
 * component because `useLongPress` is per-element state — a map callback
 * cannot hold a hook.
 */
function FavoriteItem({
  fav,
  now,
  onContactTap,
  onDelete,
  onLongPress,
}: {
  fav: FavoriteVM;
  now: number;
  onContactTap: (contactId: string) => void;
  onDelete: () => void;
  onLongPress: (x: number, y: number) => void;
}) {
  const lp = useLongPress(onLongPress);
  return (
    <div
      className="favorites__item"
      {...lp.handlers}
      // The release tap after a fired long-press must not ALSO click whatever
      // sat under the finger (the 删除 button, a contact card) — same guard
      // contract the chat rows follow.
      onClickCapture={(e) => {
        if (lp.fired()) {
          e.preventDefault();
          e.stopPropagation();
          lp.consume();
        }
      }}
    >
      <FavoriteBody fav={fav} onContactTap={onContactTap} />
      <div className="favorites__meta">
        <span className="favorites__source">
          {fav.type === 'note' ? '笔记' : fav.senderName}
          {fav.convTitle ? ` · ${fav.convTitle}` : ''} · {chatTimestamp(fav.createdAt, now)}
        </span>
        <button className="favorites__del" aria-label="删除收藏" onClick={onDelete}>
          删除
        </button>
      </div>
    </div>
  );
}

/** One favorite's content, per type. Compact renderings — a list, not a chat. */
function FavoriteBody({
  fav,
  onContactTap,
}: {
  fav: FavoriteVM;
  onContactTap: (contactId: string) => void;
}) {
  const meta = fav.meta ?? {};
  switch (fav.type) {
    case 'text':
      return <div className="favorites__text">{fav.content}</div>;

    case 'note':
      // A note is the user's own words — full text, no clamp: it IS the item.
      return <div className="favorites__text favorites__text--note">{fav.content}</div>;

    case 'sticker':
      return <div className="favorites__sticker">{stickerGlyph(fav.content)}</div>;

    case 'image': {
      const { url, background } = resolveImageRef(fav.content ?? '');
      return url ? (
        <img className="favorites__img" src={url} alt="" loading="lazy" />
      ) : (
        <div className="favorites__img favorites__img--ph" style={{ background }} />
      );
    }

    case 'voice': {
      const ms = typeof meta.durationMs === 'number' ? meta.durationMs : 0;
      const line = fav.content ? `：${fav.content}` : '';
      return (
        <div className="favorites__text favorites__text--dim">
          [语音 {Math.max(1, Math.round(ms / 1000))}″]{line}
        </div>
      );
    }

    case 'location': {
      const name = (meta.name as string | undefined) ?? fav.content ?? '';
      const address = meta.address as string | undefined;
      return (
        <div className="favorites__card">
          <div className="favorites__card-title">📍 {name}</div>
          {address && <div className="favorites__card-sub">{address}</div>}
        </div>
      );
    }

    case 'contact_card': {
      const cid = meta.contactId as string | undefined;
      return (
        <div
          className="favorites__card"
          role={cid ? 'button' : undefined}
          onClick={cid ? () => onContactTap(cid) : undefined}
        >
          <div className="favorites__card-title">👤 {(meta.name as string) ?? fav.content}</div>
          <div className="favorites__card-sub">个人名片</div>
        </div>
      );
    }

    case 'file': {
      const size = typeof meta.sizeBytes === 'number' ? humanSize(meta.sizeBytes) : '';
      return (
        <div className="favorites__card">
          <div className="favorites__card-title">📄 {(meta.fileName as string) ?? fav.content}</div>
          {size && <div className="favorites__card-sub">{size}</div>}
        </div>
      );
    }

    case 'link': {
      const summary = meta.summary as string | undefined;
      return (
        <div className="favorites__card">
          <div className="favorites__card-title">🔗 {(meta.title as string) ?? fav.content}</div>
          {summary && <div className="favorites__card-sub">{summary}</div>}
        </div>
      );
    }

    case 'merged': {
      const items = Array.isArray(meta.items)
        ? (meta.items as Array<{ name?: string; body?: string }>)
        : [];
      return (
        <div className="favorites__card">
          <div className="favorites__card-title">{(meta.title as string) ?? '聊天记录'}</div>
          {items.slice(0, 2).map((it, i) => (
            <div key={i} className="favorites__card-sub">
              {it.name}: {String(it.body ?? '').slice(0, 30)}
            </div>
          ))}
        </div>
      );
    }

    case 'game': {
      const isRps = meta.game === 'rps';
      return (
        <div className="favorites__sticker">
          {isRps ? RPS_GLYPHS[rpsResult(meta.result)] : `🎲 ${diceResult(meta.result)} 点`}
        </div>
      );
    }

    default:
      return <div className="favorites__text favorites__text--dim">[{fav.type}]</div>;
  }
}
