import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { webcrypto } from 'node:crypto';
import { FakeSqlDb } from './fake-sqlite';
import {
  openDB,
  idbPut,
  idbAdd,
  idbGet,
  idbGetAll,
  STORES,
  _closeDbForTests,
} from '../../src/db/idb';
import {
  migrateToSqlite,
  MIGRATE_PROGRESS_KEY,
  MIGRATE_SKIPPED,
} from '../../src/db/migrate-to-sqlite';
import { SQLITE_MIGRATED_AT_KEY } from '../../src/db/driver';
import { sqliteReadAll, sqliteCount } from '../../src/db/sqlite';

/**
 * I17 migration acceptance (转红条款 ①): seed EVERY store in IndexedDB, run
 * the migrator against the in-memory SQLite fake, and diff store by store.
 * The CryptoKey settings row must be EXCLUDED (and stay behind in IDB where
 * the keystore reads it); everything else must land deep-equal, message ids
 * included. Plus: interrupt/resume, and the failure paths that must NOT set
 * the completion flag.
 */

const T0 = 1_754_500_000_000;

async function makeCryptoKey(): Promise<CryptoKey> {
  // Non-extractable, like the real master key — the exact object JSON turns
  // into a `{}` husk.
  return (webcrypto as unknown as Crypto).subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  ) as Promise<CryptoKey>;
}

/** Seed a couple of representative rows into EVERY store. */
async function seedAllStores(): Promise<void> {
  await idbPut('contacts', { id: 'ai_a', type: 'ai', name: '阿', avatarColor: 'c', avatarText: 'A' });
  await idbPut('contacts', { id: 'self', type: 'self', name: '我', avatarColor: 'c', avatarText: '我' });
  await idbPut('personas', { contactId: 'ai_a', core: '开朗', relations: { user: '朋友' } });
  await idbPut('conversations', {
    id: 'c1', type: 'single', peerId: 'ai_a', title: '阿', avatarColor: 'c', avatarText: 'A',
    isPinned: false, isMuted: false, unreadCount: 0, mentionMe: false,
  });
  await idbPut('conversations', {
    id: 'dm_a_b', type: 'single', isHidden: true, memberIds: ['ai_a', 'ai_b'], title: '',
    avatarColor: 'c', avatarText: 'D', isPinned: false, isMuted: false, unreadCount: 0, mentionMe: false,
  });
  for (let i = 0; i < 7; i++) {
    await idbAdd('messages', {
      convId: i < 5 ? 'c1' : 'dm_a_b', senderId: i % 2 ? 'self' : 'ai_a', type: 'text',
      content: `m${i}`, status: 'sent', createdAt: T0 + i * 1000,
    });
  }
  await idbPut('memory_facts', {
    id: 'f1', subjectId: 'ai_a', fact: '喜欢猫', importance: 3, sensitivity: 'normal',
    evidenceMsgIds: [1], status: 'confirmed', isPinned: false, createdAt: T0,
  });
  await idbPut('conv_summaries', { convId: 'c1', summary: 's', uptoMsgId: 3, updatedAt: T0 });
  await idbPut('scheduled_actions', {
    id: 'hb_1', fireAt: T0 + 60_000, kind: 'heartbeat',
    payloadJson: JSON.stringify({ contactId: 'ai_a' }), status: 'pending', createdAt: T0,
  });
  await idbPut('providers', { id: 'p1', kind: 'custom', label: 'L', baseUrl: 'https://x', keyAlias: 'k1', enabled: true });
  await idbPut('settings', { key: 'nsfwGlobalTier', value: 'off' });
  await idbPut('settings', { key: 'lastBackupAt', value: T0 });
  await idbPut('settings', { key: '__crypto_master', value: await makeCryptoKey() });
  await idbPut('red_packets', {
    id: 'rp1', convId: 'c1', senderId: 'self', totalFen: 800, count: 2, kind: 'lucky',
    greeting: '恭喜发财', status: 'active', createdAt: T0,
  });
  await idbPut('rp_claims', { id: 'rp1:ai_a', rpId: 'rp1', claimerId: 'ai_a', amountFen: 300, isBest: false, claimedAt: T0 + 2 });
  await idbPut('transfers', { id: 't1', convId: 'c1', fromId: 'self', toId: 'ai_a', amountFen: 500, status: 'pending', createdAt: T0 });
  await idbPut('wallet_tx', { id: 'w1', kind: 'adjust', amountFen: 128_800, balanceAfterFen: 128_800, createdAt: T0 });
  await idbPut('tts_cache', { key: 'hash1', blob: new Blob(['AUDIO'], { type: 'audio/mpeg' }) });
  await idbPut('moments', { id: 'p1', authorId: 'ai_a', text: 'hi', imageRefs: [], isNsfw: false, createdAt: T0 });
  await idbPut('moment_likes', { id: 'p1:self', momentId: 'p1', contactId: 'self', createdAt: T0 + 1 });
  await idbPut('moment_comments', { id: 'cm1', momentId: 'p1', authorId: 'self', text: '赞', createdAt: T0 + 2 });
  await idbPut('media', {
    id: 'md1', kind: 'avatar', tags: [], mime: 'text/plain',
    blob: new Blob(['IMAGE_BYTES'], { type: 'text/plain' }), createdAt: T0,
  });
  await idbPut('story_scripts', { id: 'ss1', title: '剧本', nsfwLevel: 0, dag: {}, createdAt: T0 });
  await idbPut('story_saves', { id: 'sv1', scriptId: 'ss1', isActive: false, createdAt: T0 });
  await idbPut('worldbook', { id: 'wb1', scope: 'global', keys: ['猫'], text: '世界观', createdAt: T0 });
}

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  _closeDbForTests();
  await openDB();
});

describe('migrateToSqlite round trip (转红 ①)', () => {
  it('every store lands deep-equal; the CryptoKey row is excluded and stays home', async () => {
    await seedAllStores();
    const db = new FakeSqlDb();
    const events: string[] = [];
    const res = await migrateToSqlite(db, {
      now: () => T0 + 999,
      batchSize: 3,
      onProgress: (p) => events.push(`${p.store}:${p.rows}/${p.totalRows}`),
    });
    expect(res.error).toBeUndefined();
    expect(res.ok).toBe(true);
    // Two row-level exclusions: the CryptoKey master + the migrator's own
    // progress marker (written before the settings store's turn came).
    expect(res.excluded.settings).toBe(2);

    for (const def of STORES) {
      const store = def.name;
      if (store in MIGRATE_SKIPPED) continue;
      const src = await idbGetAll<Record<string, unknown>>(store);
      const dst = (await sqliteReadAll(db, store)) as Record<string, unknown>[];
      if (store === 'settings') {
        // Everything except the device-local rows (row-level, not
        // store-level: the other settings must travel).
        const portable = src.filter(
          (r) =>
            !(r.value instanceof CryptoKey) &&
            r.key !== SQLITE_MIGRATED_AT_KEY &&
            r.key !== MIGRATE_PROGRESS_KEY,
        );
        expect(dst).toEqual(portable);
        expect(dst.some((r) => r.key === '__crypto_master')).toBe(false);
      } else if (store === 'media') {
        const strip = (rows: Record<string, unknown>[]) =>
          rows.map(({ blob: _b, ...rest }) => rest);
        expect(strip(dst)).toEqual(strip(src));
        expect(await (dst[0].blob as Blob).text()).toBe('IMAGE_BYTES');
      } else {
        expect(dst, `store ${store} 迁移后不等价`).toEqual(src);
      }
    }

    // Message ids survived verbatim — rowid 序==时间序 depends on it.
    const msgs = (await sqliteReadAll(db, 'messages')) as Array<{ id: number }>;
    expect(msgs.map((m) => m.id)).toEqual([1, 2, 3, 4, 5, 6, 7]);

    // tts_cache never crossed (no table in the SQLite schema at all).
    await expect(sqliteReadAll(db, 'tts_cache')).rejects.toThrow(/no such table/);

    // Completion flag set with the injected clock; progress row retired.
    const flag = await idbGet<{ key: string; value: number }>('settings', SQLITE_MIGRATED_AT_KEY);
    expect(flag?.value).toBe(T0 + 999);
    expect(await idbGet('settings', MIGRATE_PROGRESS_KEY)).toBeUndefined();

    // The master key never moved: still in IDB, still a live CryptoKey.
    const master = await idbGet<{ key: string; value: unknown }>('settings', '__crypto_master');
    expect(master?.value).toBeInstanceOf(CryptoKey);

    expect(events.length).toBeGreaterThan(0);
  });

  it('an aborted run leaves the flag unset and resumes to completion', async () => {
    await seedAllStores();
    const db = new FakeSqlDb();
    let batches = 0;
    const first = await migrateToSqlite(db, {
      now: () => T0,
      batchSize: 2,
      shouldAbort: () => ++batches > 3,
    });
    expect(first.ok).toBe(false);
    expect(first.aborted).toBe(true);
    expect(await idbGet('settings', SQLITE_MIGRATED_AT_KEY)).toBeUndefined();
    // Progress survived, so the next run continues rather than starting over.
    expect(await idbGet('settings', MIGRATE_PROGRESS_KEY)).toBeDefined();

    const second = await migrateToSqlite(db, { now: () => T0 + 1, batchSize: 2 });
    expect(second.error).toBeUndefined();
    expect(second.ok).toBe(true);
    // Resume must not duplicate: counts equal the source exactly.
    expect(await sqliteCount(db, 'messages')).toBe((await idbGetAll('messages')).length);
    expect(await sqliteCount(db, 'contacts')).toBe((await idbGetAll('contacts')).length);
    const flag = await idbGet<{ key: string; value: number }>('settings', SQLITE_MIGRATED_AT_KEY);
    expect(flag?.value).toBe(T0 + 1);
  });

  it('a failed verify blocks the completion flag (no data ever at risk)', async () => {
    await seedAllStores();
    const db = new FakeSqlDb();
    // A phantom message row the source does not have → row-count mismatch.
    await db.execute('CREATE TABLE IF NOT EXISTS "messages" (id INTEGER PRIMARY KEY AUTOINCREMENT, conv_id TEXT NOT NULL, data TEXT NOT NULL);');
    await db.run('INSERT OR REPLACE INTO messages (id, conv_id, data) VALUES (?, ?, ?)', [
      999,
      'ghost',
      '{}',
    ]);
    const res = await migrateToSqlite(db, { now: () => T0 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/校验失败/);
    expect(await idbGet('settings', SQLITE_MIGRATED_AT_KEY)).toBeUndefined();
  });
});
