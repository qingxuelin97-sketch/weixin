import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { FakeSqlDb } from './fake-sqlite';
import { SqliteRepo, ensureSqliteSchema } from '../../src/db/sqlite';
import { IdbRepo, type Repo } from '../../src/db/repo';
import { openDB, idbGetAll, idbPut, _closeDbForTests } from '../../src/db/idb';
import { makePersona } from '../../src/data/persona-defaults';
import type {
  ContactVM,
  ConversationVM,
  MessageVM,
  MomentVM,
  MomentLikeVM,
  MomentCommentVM,
  MemoryFactVM,
  RpClaimVM,
  MediaItemVM,
} from '../../src/data/types';

/**
 * I17 driver-equivalence suite: the SQLite Repo must answer every question
 * EXACTLY like the IndexedDB Repo it replaces — that is the entire meaning of
 * the Repo interface (CLAUDE.md §3: 换存储驱动只实现接口，不改调用方). Each
 * case performs the same operations against both drivers and diffs the
 * results, so a semantic drift (cursor meaning, sort order, hidden-conv
 * filtering) fails loudly instead of surfacing on a phone.
 */

const T0 = 1_754_500_000_000;

const contact = (id: string, name = id): ContactVM => ({
  id,
  type: 'ai',
  name,
  avatarColor: 'c',
  avatarText: 'x',
});

const conv = (id: string, over: Partial<ConversationVM> = {}): ConversationVM => ({
  id,
  type: 'single',
  peerId: 'ai_a',
  title: id,
  avatarColor: 'c',
  avatarText: 'x',
  isPinned: false,
  isMuted: false,
  unreadCount: 0,
  mentionMe: false,
  lastMsgPreview: '',
  lastMsgAt: T0,
  ...over,
});

const msg = (convId: string, i: number): Omit<MessageVM, 'id'> => ({
  convId,
  senderId: i % 2 ? 'self' : 'ai_a',
  type: 'text',
  content: `msg ${convId} ${i}`,
  status: 'sent',
  createdAt: T0 + i * 1000,
});

const moment = (id: string, at: number): MomentVM => ({
  id,
  authorId: 'ai_a',
  text: `post ${id}`,
  imageRefs: [],
  isNsfw: false,
  createdAt: at,
});

let idb: Repo;
let sq: SqliteRepo;
let fake: FakeSqlDb;

/** Both drivers, fed identical operations. */
const both = async (op: (r: Repo) => Promise<void>) => {
  await op(idb);
  await op(sq);
};

/** The same read against both drivers must agree byte-for-byte. */
const agree = async <T>(read: (r: Repo) => Promise<T>): Promise<T> => {
  const a = await read(idb);
  const b = await read(sq);
  expect(b).toEqual(a);
  return a;
};

beforeEach(async () => {
  // Fresh factory + dropped connection: `clear()` alone keeps autoincrement
  // generators, and id parity is exactly what these tests assert.
  globalThis.indexedDB = new IDBFactory();
  _closeDbForTests();
  await openDB();
  idb = new IdbRepo();
  fake = new FakeSqlDb();
  await ensureSqliteSchema(fake);
  sq = new SqliteRepo(fake);
});

describe('kv parity', () => {
  it('contacts, personas, conversations, settings round-trip identically', async () => {
    await both(async (r) => {
      await r.putContact(contact('ai_a', '阿'));
      await r.putContact(contact('ai_b', '波'));
      await r.putPersona(makePersona({ contactId: 'ai_a', core: '开朗' }));
      await r.putConversation(conv('c1'));
      await r.putConversation(conv('dm_a_b', { isHidden: true, memberIds: ['ai_a', 'ai_b'] }));
      await r.putSetting('nsfwGlobalTier', 'off');
      await r.putSetting('obj', { a: 1, b: [2, 3] });
    });
    await agree((r) => r.getContacts());
    await agree((r) => r.getContact('ai_a'));
    await agree((r) => r.getPersona('ai_a'));
    await agree((r) => r.getConversations());
    await agree((r) => r.getConversation('dm_a_b'));
    await agree((r) => r.getSetting('nsfwGlobalTier'));
    await agree((r) => r.getSetting('obj'));
    await agree((r) => r.getSetting('missing'));
    await agree((r) => r.isEmpty());
  });
});

describe('messages: rowid 序==时间序 and the beforeId cursor', () => {
  it('assigns ascending ids and pages identically through the whole history', async () => {
    await both(async (r) => {
      for (let i = 0; i < 25; i++) await r.addMessage(msg('c1', i));
      for (let i = 0; i < 5; i++) await r.addMessage(msg('c2', i));
    });

    // Default page (newest 30, chronological order).
    await agree((r) => r.getMessages('c1'));
    await agree((r) => r.getMessages('c2', { limit: 3 }));
    await agree((r) => r.firstMessageAt('c1'));
    await agree((r) => r.firstMessageAt('empty'));

    // Walk the full history via the cursor, page by page, on both drivers.
    const walk = async (r: Repo) => {
      const pages: MessageVM[][] = [];
      let beforeId: number | undefined;
      for (;;) {
        const page = await r.getMessages('c1', { limit: 7, beforeId });
        if (page.length === 0) break;
        pages.push(page);
        beforeId = page[0].id;
      }
      return pages;
    };
    const pages = await agree(walk);
    expect(pages.flat()).toHaveLength(25);
    // Chronological within a page; ids strictly ascend with time.
    const ids = pages
      .slice()
      .reverse()
      .flat()
      .map((m) => m.id);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
  });

  it('update, delete and deleteConversation behave identically', async () => {
    await both(async (r) => {
      const a = await r.addMessage(msg('c1', 0));
      await r.addMessage(msg('c1', 1));
      await r.addMessage(msg('c2', 0));
      await r.updateMessage({ ...a, isRecalled: true });
      const b = await r.addMessage(msg('c1', 2));
      await r.deleteMessage(b.id);
      await r.putConversation(conv('c2'));
      await r.putConvSummary({ convId: 'c2', summary: 's', uptoMsgId: 1, updatedAt: T0 });
      await r.deleteConversation('c2');
    });
    await agree((r) => r.getMessages('c1'));
    await agree((r) => r.getMessages('c2'));
    await agree((r) => r.firstMessageAt('c2'));
    await agree((r) => r.getConvSummary('c2'));
    await agree((r) => r.getConversation('c2'));
  });
});

describe('indexed lookups', () => {
  it('memory by subject, claims by packet — same rows, same order', async () => {
    const fact = (id: string, subjectId: string): MemoryFactVM => ({
      id,
      subjectId,
      fact: 'f',
      importance: 3,
      sensitivity: 'normal',
      evidenceMsgIds: [1],
      status: 'confirmed',
      isPinned: false,
      createdAt: T0,
    });
    const claim = (rpId: string, who: string, at: number): RpClaimVM => ({
      id: `${rpId}:${who}`,
      rpId,
      claimerId: who,
      amountFen: 100,
      isBest: false,
      claimedAt: at,
    });
    await both(async (r) => {
      await r.putMemory(fact('m1', 'ai_a'));
      await r.putMemory(fact('m2', 'ai_b'));
      await r.putMemory(fact('m3', 'ai_a'));
      await r.putClaim(claim('rp1', 'ai_b', T0 + 5));
      await r.putClaim(claim('rp1', 'ai_a', T0 + 1));
      await r.putClaim(claim('rp2', 'ai_a', T0 + 2));
      await r.deleteMemory('m3');
    });
    await agree((r) => r.getMemory('ai_a'));
    await agree((r) => r.getMemory('ai_b'));
    await agree((r) => r.getClaims('rp1'));
    await agree((r) => r.getClaims('rp2'));
  });
});

describe('moments: newest-first pagination and social cascade', () => {
  it('pages by createdAt identically, including the before cursor', async () => {
    await both(async (r) => {
      for (let i = 0; i < 10; i++) await r.putMoment(moment(`p${i}`, T0 + i * 60_000));
    });
    const first = await agree((r) => r.getMoments({ limit: 4 }));
    expect(first).toHaveLength(4);
    expect(first[0].id).toBe('p9');
    await agree((r) => r.getMoments({ limit: 4, before: first[first.length - 1].createdAt }));
    await agree((r) => r.getMoments());
  });

  it('likes/comments group + sort identically and die with their post', async () => {
    const like = (id: string, momentId: string, at: number): MomentLikeVM => ({
      id,
      momentId,
      contactId: 'ai_b',
      createdAt: at,
    });
    const cm = (id: string, momentId: string, at: number): MomentCommentVM => ({
      id,
      momentId,
      authorId: 'ai_b',
      text: 'nice',
      createdAt: at,
    });
    await both(async (r) => {
      await r.putMoment(moment('p1', T0));
      await r.putMoment(moment('p2', T0 + 1));
      await r.putLike(like('l2', 'p1', T0 + 9));
      await r.putLike(like('l1', 'p1', T0 + 3));
      await r.putComment(cm('c1', 'p1', T0 + 4));
      await r.putComment(cm('c2', 'p2', T0 + 5));
    });
    await agree((r) => r.getLikes('p1'));
    await agree((r) => r.getComments('p1'));
    await agree((r) => r.getMomentSocial(['p1', 'p2', 'ghost']));
    await both((r) => r.deleteMoment('p1'));
    await agree((r) => r.getMoment('p1'));
    await agree((r) => r.getLikes('p1'));
    await agree((r) => r.getComments('p1'));
    await agree((r) => r.getMomentSocial(['p1', 'p2']));
  });
});

describe('media: blobs survive the TEXT column', () => {
  it('round-trips bytes and filters by kind like the IDB driver', async () => {
    const item = (id: string, kind: MediaItemVM['kind'], text: string): MediaItemVM => ({
      id,
      kind,
      tags: ['风景'],
      mime: 'text/plain',
      blob: new Blob([text], { type: 'text/plain' }),
      createdAt: T0,
    });
    await both(async (r) => {
      await r.putMedia(item('m1', 'avatar', 'AVATAR_BYTES'));
      await r.putMedia(item('m2', 'photo', 'PHOTO_BYTES'));
    });
    const a = await sq.getMedia('avatar');
    expect(a).toHaveLength(1);
    expect(await a[0].blob.text()).toBe('AVATAR_BYTES');
    expect(a[0].blob).toBeInstanceOf(Blob);
    const one = await sq.getMediaItem('m2');
    expect(await one!.blob.text()).toBe('PHOTO_BYTES');
    // Same ids and metadata as the IDB driver (bytes asserted above).
    const strip = (xs: MediaItemVM[]) => xs.map(({ blob: _b, ...rest }) => rest);
    expect(strip(await sq.getMedia())).toEqual(strip(await idb.getMedia()));
    await both((r) => r.deleteMedia('m1'));
    await agree(async (r) => (await r.getMedia()).length);
  });
});

describe('deleteContact cascade on the SQLite driver', () => {
  it('cleans its own tables AND the IDB-resident scheduler queue', async () => {
    // The queue's live home is IndexedDB on every driver (scheduler.ts reads
    // it directly), so the SQLite cascade must reach across.
    await idbPut('scheduled_actions', {
      id: 'hb_1',
      fireAt: T0,
      kind: 'heartbeat',
      payloadJson: JSON.stringify({ contactId: 'ai_a' }),
      status: 'pending',
      createdAt: T0,
    });
    await idbPut('scheduled_actions', {
      id: 'hb_2',
      fireAt: T0,
      kind: 'heartbeat',
      payloadJson: JSON.stringify({ contactId: 'ai_b' }),
      status: 'pending',
      createdAt: T0,
    });
    await sq.putContact(contact('ai_a'));
    await sq.putContact(contact('ai_b'));
    await sq.putPersona(makePersona({ contactId: 'ai_a', core: 'x' }));
    await sq.putPersona(
      makePersona({ contactId: 'ai_b', core: 'y', relations: { user: '朋友', ai_a: '闺蜜' } }),
    );
    await sq.putConversation(conv('c1', { peerId: 'ai_a' }));
    await sq.putConversation(conv('g1', { type: 'group', memberIds: ['ai_a', 'ai_b'] }));
    await sq.addMessage(msg('c1', 0));
    await sq.putSetting('affect:ai_a', { v: 1 });
    await sq.putSetting('affect:ai_b', { v: 2 });
    await sq.putMoment({ ...moment('p1', T0), authorId: 'ai_a' });

    await sq.deleteContact('ai_a');

    expect(await sq.getContact('ai_a')).toBeUndefined();
    expect(await sq.getPersona('ai_a')).toBeUndefined();
    expect(await sq.getConversation('c1')).toBeUndefined();
    expect(await sq.getMessages('c1')).toEqual([]);
    expect((await sq.getConversation('g1'))!.memberIds).toEqual(['ai_b']);
    expect((await sq.getPersona('ai_b'))!.relations).toEqual({ user: '朋友' });
    expect(await sq.getSetting('affect:ai_a')).toBeUndefined();
    expect(await sq.getSetting('affect:ai_b')).toEqual({ v: 2 });
    expect(await sq.getMoment('p1')).toBeUndefined();
    const queue = await idbGetAll<{ id: string }>('scheduled_actions');
    expect(queue.map((a) => a.id)).toEqual(['hb_2']);
  });

  it('refuses to delete the user, like the IDB driver', async () => {
    await expect(sq.deleteContact('self')).rejects.toThrow(/refusing/);
    await expect(idb.deleteContact('self')).rejects.toThrow(/refusing/);
  });
});
