import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { repo, DELETE_CONTACT_CASCADE } from '../../src/db/repo';
import { idbPut, idbGetAll, idbClear, STORES } from '../../src/db/idb';
import type { ContactVM, ConversationVM, FavoriteVM } from '../../src/data/types';

/**
 * 收藏 (M-I13): storage semantics and the two invariants that must never bend:
 *
 *  1. HIDDEN-CONVERSATION ZERO VISIBILITY — a favorite row referencing a
 *     hidden AI↔AI DM never leaves the repo, whatever the UI asks for.
 *     The filter lives in `getFavorites()` itself (the search() lesson).
 *  2. deleteContact CASCADE — favorites of a deleted contact (or captured
 *     from their dying threads) disappear with them; unrelated favorites stay.
 */

const T0 = new Date(2026, 6, 1, 12, 0).getTime();

function fav(over: Partial<FavoriteVM> & Pick<FavoriteVM, 'id' | 'convId'>): FavoriteVM {
  return {
    msgId: 1,
    senderId: 'self',
    senderName: '我',
    convTitle: '会话',
    type: 'text',
    content: '一句话',
    createdAt: T0,
    favedAt: T0,
    ...over,
  };
}

function conv(over: Partial<ConversationVM> & Pick<ConversationVM, 'id'>): ConversationVM {
  return {
    type: 'single',
    title: '会话',
    avatarColor: 'gray',
    avatarText: '会',
    isPinned: false,
    isMuted: false,
    unreadCount: 0,
    mentionMe: false,
    lastMsgPreview: '',
    lastMsgAt: T0,
    ...over,
  };
}

function contact(id: string, name: string): ContactVM {
  return { id, type: 'ai', name, avatarColor: 'gray', avatarText: name.slice(0, 1) };
}

async function wipe(): Promise<void> {
  for (const s of STORES) await idbClear(s.name);
}

beforeEach(async () => {
  await wipe();
});

describe('favorites storage', () => {
  it('round-trips a snapshot and sorts newest-favorited first', async () => {
    await repo.putConversation(conv({ id: 'c1' }));
    await repo.putFavorite(fav({ id: 'f1', convId: 'c1', favedAt: T0, content: '早' }));
    await repo.putFavorite(fav({ id: 'f2', convId: 'c1', favedAt: T0 + 1000, content: '晚' }));
    const rows = await repo.getFavorites();
    expect(rows.map((r) => r.id)).toEqual(['f2', 'f1']);
    expect(rows[1].content).toBe('早');
  });

  it('favoriting the same message twice is an upsert, not a duplicate', async () => {
    await repo.putConversation(conv({ id: 'c1' }));
    await repo.putFavorite(fav({ id: 'fav_c1_7', convId: 'c1', msgId: 7 }));
    await repo.putFavorite(fav({ id: 'fav_c1_7', convId: 'c1', msgId: 7, favedAt: T0 + 5000 }));
    const rows = await repo.getFavorites();
    expect(rows).toHaveLength(1);
    expect(rows[0].favedAt).toBe(T0 + 5000);
  });

  it('deleteFavorite removes exactly one row', async () => {
    await repo.putConversation(conv({ id: 'c1' }));
    await repo.putFavorite(fav({ id: 'f1', convId: 'c1' }));
    await repo.putFavorite(fav({ id: 'f2', convId: 'c1' }));
    await repo.deleteFavorite('f1');
    expect((await repo.getFavorites()).map((r) => r.id)).toEqual(['f2']);
  });

  it('keeps meta snapshots intact (cards render from the favorite alone)', async () => {
    await repo.putConversation(conv({ id: 'c1' }));
    await repo.putFavorite(
      fav({
        id: 'f1',
        convId: 'c1',
        type: 'file',
        content: '合同.pdf',
        meta: { fileName: '合同.pdf', sizeBytes: 123_456, ext: 'pdf' },
      }),
    );
    const [row] = await repo.getFavorites();
    expect(row.meta).toEqual({ fileName: '合同.pdf', sizeBytes: 123_456, ext: 'pdf' });
  });

  it('a favorite survives its source conversation being deleted (snapshot semantics)', async () => {
    await repo.putConversation(conv({ id: 'c1' }));
    await repo.putFavorite(fav({ id: 'f1', convId: 'c1' }));
    await repo.deleteConversation('c1');
    // The conversation is gone; the snapshot remains (and is not hidden —
    // a deleted conv is not a hidden conv).
    expect((await repo.getFavorites()).map((r) => r.id)).toEqual(['f1']);
  });
});

describe('hidden conversations are ZERO-visible in favorites (转红)', () => {
  it('a favorite row referencing a hidden AI↔AI DM never leaves the repo', async () => {
    await repo.putConversation(conv({ id: 'c_vis' }));
    await repo.putConversation(
      conv({ id: 'dm_a_b', isHidden: true, memberIds: ['ai_a', 'ai_b'] }),
    );
    // Simulate the leak vector: a row lands in the store DIRECTLY (a tampered
    // backup restore, a future writer's bug) — not through any UI.
    await idbPut('favorites', fav({ id: 'f_leak', convId: 'dm_a_b', content: '八卦原文' }));
    await repo.putFavorite(fav({ id: 'f_ok', convId: 'c_vis' }));

    const rows = await repo.getFavorites();
    expect(rows.map((r) => r.id)).toEqual(['f_ok']);
    expect(JSON.stringify(rows)).not.toContain('八卦原文');

    // The row physically exists — proof the filter (not the setup) did the work.
    const raw = await idbGetAll<FavoriteVM>('favorites');
    expect(raw.some((r) => r.id === 'f_leak')).toBe(true);
  });
});

describe('deleteContact cascade covers favorites (转红)', () => {
  it('is registered in the cascade ledger as cascade', () => {
    expect(DELETE_CONTACT_CASCADE.favorites).toBe('cascade');
  });

  it('removes favorites FROM the contact and from their dead threads; keeps the rest', async () => {
    await repo.putContact(contact('ai_gone', '要删的人'));
    await repo.putContact(contact('ai_stay', '留下的人'));
    await repo.putConversation(conv({ id: 'c_gone', peerId: 'ai_gone' }));
    await repo.putConversation(conv({ id: 'c_stay', peerId: 'ai_stay' }));

    // 1) her message favorited in her own thread (dies via dead thread)
    await repo.putFavorite(
      fav({ id: 'f1', convId: 'c_gone', senderId: 'ai_gone', senderName: '要删的人' }),
    );
    // 2) MY message favorited in her thread (dies via dead thread too)
    await repo.putFavorite(fav({ id: 'f2', convId: 'c_gone', senderId: 'self' }));
    // 3) her message favorited in a GROUP that survives (dies via senderId)
    await repo.putConversation(
      conv({ id: 'g1', type: 'group', memberIds: ['ai_gone', 'ai_stay'] }),
    );
    await repo.putFavorite(fav({ id: 'f3', convId: 'g1', senderId: 'ai_gone' }));
    // 4) an unrelated favorite that must survive
    await repo.putFavorite(fav({ id: 'f4', convId: 'c_stay', senderId: 'ai_stay' }));

    await repo.deleteContact('ai_gone');

    const left = await repo.getFavorites();
    expect(left.map((r) => r.id)).toEqual(['f4']);
  });
});
