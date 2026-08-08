import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { DB_VERSION, STORES } from '../../src/db/idb';

/**
 * Migration guards for the CLAUDE.md §3.5 trap "每加一个 store 必须 DB_VERSION+1".
 * Two nets:
 *  1. A store↔version ledger: adding a store to STORES without registering it
 *     here (and bumping DB_VERSION when the ledger demands it) turns tests red —
 *     the human-memory rule becomes machine-enforced.
 *  2. A real upgrade run on fake-indexeddb: open at v(N-1) with the previous
 *     store set, reopen at current version, assert every store now exists.
 */

/**
 * THE LEDGER. When you add a store: add a row with version = DB_VERSION + 1,
 * then bump DB_VERSION in src/db/idb.ts to match. Never edit existing rows.
 */
const STORE_INTRODUCED_IN: Record<string, number> = {
  contacts: 1,
  personas: 1,
  conversations: 1,
  messages: 1,
  memory_facts: 1,
  conv_summaries: 1,
  scheduled_actions: 1,
  providers: 1,
  settings: 1,
  red_packets: 2,
  rp_claims: 2,
  transfers: 2,
  wallet_tx: 2,
  tts_cache: 3,
  moments: 4,
  moment_likes: 4,
  moment_comments: 4,
};

describe('DB migration guards', () => {
  it('every store in STORES is registered in the version ledger', () => {
    for (const s of STORES) {
      expect(
        STORE_INTRODUCED_IN[s.name],
        `store "${s.name}" 不在版本台账里——新加 store 必须登记引入版本并把 DB_VERSION 提到该版本`,
      ).toBeDefined();
    }
  });

  it('the ledger has no orphan entries for stores that no longer exist', () => {
    const names = new Set(STORES.map((s) => s.name));
    for (const name of Object.keys(STORE_INTRODUCED_IN)) {
      expect(names.has(name), `台账里的 "${name}" 已不在 STORES 中`).toBe(true);
    }
  });

  it('DB_VERSION matches the newest store introduction (bump-forgotten guard)', () => {
    const newest = Math.max(...Object.values(STORE_INTRODUCED_IN));
    expect(
      DB_VERSION,
      `台账最高版本是 ${newest} 但 DB_VERSION=${DB_VERSION}——加 store 忘了 bump（或 bump 了没登记）`,
    ).toBe(newest);
  });

  describe('real upgrade from v(N-1)', () => {
    beforeEach(() => {
      // Fresh factory per test so module-level DB caches can't interfere.
      globalThis.indexedDB = new IDBFactory();
    });

    it('opening the previous-version DB with current code creates every store', async () => {
      const prevStores = STORES.filter((s) => STORE_INTRODUCED_IN[s.name] < DB_VERSION);
      expect(prevStores.length).toBeGreaterThan(0);

      // 1) Simulate the OLD app: create the DB at v(N-1) with only the old stores.
      const oldDb = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('weixin-ai', DB_VERSION - 1);
        req.onupgradeneeded = () => {
          for (const s of prevStores) {
            req.result.createObjectStore(s.name, {
              keyPath: s.keyPath,
              autoIncrement: s.autoIncrement ?? false,
            });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      oldDb.close();

      // 2) Simulate the NEW app: same upgrade routine openDB() runs.
      const newDb = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open('weixin-ai', DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          for (const s of STORES) {
            if (db.objectStoreNames.contains(s.name)) continue;
            const os = db.createObjectStore(s.name, {
              keyPath: s.keyPath,
              autoIncrement: s.autoIncrement ?? false,
            });
            for (const idx of s.indexes ?? []) {
              os.createIndex(idx.name, idx.keyPath, { unique: idx.unique ?? false });
            }
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });

      // 3) Every store — old and new — must exist after the upgrade.
      for (const s of STORES) {
        expect(newDb.objectStoreNames.contains(s.name), `升级后缺 store "${s.name}"`).toBe(true);
      }
      newDb.close();
    });
  });
});
