/**
 * 收藏 (M-I13): everything the user long-press-favorited, filterable by type.
 *
 * Renders SNAPSHOTS — the favorite carries its own content/meta copy, so rows
 * survive the source message (or thread) being deleted. Hidden-conversation
 * rows never arrive here at all: `repo.getFavorites()` filters them out at the
 * repo layer, the same defense-in-depth as global search.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SubNav } from '../../components/SubNav';
import { showConfirm } from '../../components/dialog';
import { repo } from '../../db/repo';
import { logError } from '../../lib/errlog';
import { chatTimestamp } from '../../lib/time';
import { useNow } from '../../lib/useNow';
import { stickerGlyph } from '../../data/stickers';
import { resolveImageRef } from '../../data/moments-images';
import { useMedia } from '../../components/useMedia';
import { humanSize } from '../../ai/bubble-materialize';
import { RPS_GLYPHS, diceResult, rpsResult } from '../../lib/game';
import type { FavoriteVM, MessageType } from '../../data/types';
import './favorites.css';

/** Filter chips: a label plus the message types it admits. */
const FILTERS: Array<{ key: string; label: string; types?: MessageType[] }> = [
  { key: 'all', label: '全部' },
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
  const [rows, setRows] = useState<FavoriteVM[] | null>(null);
  const [filter, setFilter] = useState('all');

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
    if (!f?.types) return rows;
    const want = new Set<MessageType>(f.types);
    return rows.filter((r) => want.has(r.type));
  }, [rows, filter]);

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

  return (
    <>
      <SubNav title="收藏" />
      <div className="page-body favorites">
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
            {filter === 'all' ? '长按聊天里的消息即可收藏' : '这个分类下还没有收藏'}
          </div>
        )}
        {shown.map((f) => (
          <div key={f.id} className="favorites__item">
            <FavoriteBody
              fav={f}
              onContactTap={(cid) => navigate(`/contact/${cid}`)}
            />
            <div className="favorites__meta">
              <span className="favorites__source">
                {f.senderName}
                {f.convTitle ? ` · ${f.convTitle}` : ''} · {chatTimestamp(f.createdAt, NOW)}
              </span>
              <button className="favorites__del" aria-label="删除收藏" onClick={() => void remove(f)}>
                删除
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
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
