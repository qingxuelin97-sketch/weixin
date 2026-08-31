/**
 * 收藏二期 (M-J12) — the pure half of the favorites upgrades: full-text
 * matching, the「笔记」row builder, and the "forward back into a chat" payload.
 *
 * lib/ discipline: no storage, no clock (now is injected), no store — the page
 * hands rows in and gets rows/messages back. The hidden-conversation guarantee
 * is NOT re-implemented here: `repo.getFavorites()` filters hidden rows before
 * anything in this module ever sees them (tests/unit/i13-favorites.test.ts is
 * the red test), and `forwardableConversations` keeps the same rule for the
 * forward TARGET list — a hidden AI↔AI DM must be unreachable as a destination
 * exactly as it is invisible as a source.
 */
import type { ConversationVM, FavoriteVM, MessageVM } from '../data/types';

/* ==================================================================== */
/* Full-text search                                                      */
/* ==================================================================== */

/** Meta fields worth matching, per snapshot type. Values only, never keys. */
const META_TEXT_KEYS = ['title', 'summary', 'fileName', 'name', 'address'] as const;

/**
 * Everything searchable about one favorite, joined into one haystack: the
 * content, who sent it, which thread it came from, and the human-readable meta
 * strings (a file's name, a link's title, a location's address, a merged
 * record's lines). Deliberately NOT JSON.stringify — that would match key
 * names and internal ids, which reads as haunted search results.
 */
export function favoriteSearchText(f: FavoriteVM): string {
  const parts: string[] = [f.content ?? '', f.senderName, f.convTitle];
  const meta = f.meta ?? {};
  for (const k of META_TEXT_KEYS) {
    const v = meta[k];
    if (typeof v === 'string') parts.push(v);
  }
  if (Array.isArray(meta.items)) {
    for (const it of meta.items as Array<{ name?: unknown; body?: unknown }>) {
      if (typeof it?.name === 'string') parts.push(it.name);
      if (typeof it?.body === 'string') parts.push(it.body);
    }
  }
  return parts.filter(Boolean).join('\n');
}

/** Case-insensitive substring filter; an empty query keeps every row. */
export function filterFavorites(rows: FavoriteVM[], queryRaw: string): FavoriteVM[] {
  const q = queryRaw.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((f) => favoriteSearchText(f).toLowerCase().includes(q));
}

/* ==================================================================== */
/* 笔记 — a favorite the user wrote directly                             */
/* ==================================================================== */

/**
 * Build a new note row. Notes are favorites with no source message: they carry
 * `type: 'note'`, an empty convId (never a hidden one — and the delete-contact
 * cascade can never sweep them, since senderId is 'self').
 */
export function makeNoteFavorite(text: string, now: number): FavoriteVM {
  return {
    id: `fav_note_${now}`,
    msgId: 0,
    convId: '',
    senderId: 'self',
    senderName: '我',
    convTitle: '',
    type: 'note',
    content: text,
    createdAt: now,
    favedAt: now,
  };
}

/**
 * Edit a note in place. Only the text changes — id and favedAt stay, so an
 * edit does not shuffle the list order out from under the user's finger.
 */
export function editedNote(f: FavoriteVM, text: string): FavoriteVM {
  return { ...f, content: text };
}

/* ==================================================================== */
/* 转发回聊天                                                            */
/* ==================================================================== */

/**
 * Snapshot types that can be re-sent as a message. Voice (a transcript is not
 * a recording), games (the result was seeded to THAT throw), and the money /
 * system rows stay un-forwardable — same as the device.
 */
const FORWARDABLE = new Set<FavoriteVM['type']>([
  'text',
  'note',
  'image',
  'sticker',
  'location',
  'contact_card',
  'file',
  'link',
  'merged',
]);

export function isForwardable(f: Pick<FavoriteVM, 'type'>): boolean {
  return FORWARDABLE.has(f.type);
}

/**
 * The message a favorite becomes when forwarded into `convId` — or null for a
 * type that cannot travel. A note goes out as plain text (`note` is a
 * favorites-only kind; it must never appear as a message type). Meta is
 * cloned, not aliased: the sent message must not share a mutable object with
 * the stored snapshot.
 */
export function forwardMessageOf(
  f: FavoriteVM,
  convId: string,
  now: number,
): Omit<MessageVM, 'id'> | null {
  if (!isForwardable(f)) return null;
  const type = f.type === 'note' ? 'text' : f.type;
  return {
    convId,
    senderId: 'self',
    type,
    content: f.content,
    ...(f.meta ? { meta: { ...f.meta } } : {}),
    status: 'sent',
    createdAt: now,
  };
}

/**
 * Conversations a forward sheet may offer. THE filter for the forward surface:
 * hidden AI↔AI DMs are dropped here, inside the helper every picker goes
 * through, so a caller that forgets cannot leak one as a destination
 * (the search() lesson, applied to a write path).
 */
export function forwardableConversations(
  conversations: ConversationVM[],
  excludeConvId?: string,
): ConversationVM[] {
  return conversations.filter((c) => !c.isHidden && c.id !== excludeConvId);
}
