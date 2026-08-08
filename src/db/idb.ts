/**
 * Minimal promise-based IndexedDB wrapper (zero dependencies). This is the M2
 * web persistence driver behind the Repo interface. At M3 the APK swaps in
 * @capacitor-community/sqlite behind the SAME Repo — components never change.
 *
 * Object stores mirror the Drizzle tables (src/db/schema.ts is the canonical
 * shape). `messages` uses an autoincrement key + a convId index so per-conversation
 * cursor pagination stays rowid==time ordered.
 */

const DB_NAME = 'weixin-ai';
// v2 adds the money stores; v3 adds the TTS audio cache; v4 adds Moments;
// v5 adds the runtime media library.
// Bump this on EVERY new store or onupgradeneeded never runs (see CLAUDE.md §3.5).
// Exported for tests/unit/idb-migration.test.ts, whose ledger machine-enforces
// that rule — register new stores there when bumping.
export const DB_VERSION = 5;

export interface StoreDef {
  name: string;
  keyPath: string;
  autoIncrement?: boolean;
  indexes?: Array<{ name: string; keyPath: string | string[]; unique?: boolean }>;
}

export const STORES: StoreDef[] = [
  { name: 'contacts', keyPath: 'id' },
  { name: 'personas', keyPath: 'contactId' },
  { name: 'conversations', keyPath: 'id' },
  {
    name: 'messages',
    keyPath: 'id',
    autoIncrement: true,
    indexes: [{ name: 'byConv', keyPath: 'convId' }],
  },
  { name: 'memory_facts', keyPath: 'id', indexes: [{ name: 'bySubject', keyPath: 'subjectId' }] },
  { name: 'conv_summaries', keyPath: 'convId' },
  { name: 'scheduled_actions', keyPath: 'id', indexes: [{ name: 'byStatus', keyPath: 'status' }] },
  { name: 'providers', keyPath: 'id' },
  { name: 'settings', keyPath: 'key' },
  // --- money (v2) ---
  { name: 'red_packets', keyPath: 'id' },
  { name: 'rp_claims', keyPath: 'id', indexes: [{ name: 'byRp', keyPath: 'rpId' }] },
  { name: 'transfers', keyPath: 'id' },
  { name: 'wallet_tx', keyPath: 'id' },
  // Content-addressed TTS audio cache (key = hash of voice+text+params).
  { name: 'tts_cache', keyPath: 'key' },
  // --- moments (v4) ---
  { name: 'moments', keyPath: 'id' },
  // SQLite models likes as a composite PK (momentId, contactId). IndexedDB keyPaths
  // are single-valued, so the id is the synthetic join `${momentId}:${contactId}` —
  // that keeps "one like per person per moment" enforced by the store itself.
  { name: 'moment_likes', keyPath: 'id', indexes: [{ name: 'byMoment', keyPath: 'momentId' }] },
  {
    name: 'moment_comments',
    keyPath: 'id',
    indexes: [{ name: 'byMoment', keyPath: 'momentId' }],
  },
  // --- runtime media library (v5) ---
  // User-imported avatars & photo pools live HERE, not in src/assets: the APK is
  // CI-built, so a build-time asset slot is unreachable from the device — the
  // library must be writable at runtime. Blobs are structured-clone friendly.
  { name: 'media', keyPath: 'id' },
];

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
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
    // A stale tab/WebView holding the old version blocks the upgrade forever —
    // without this handler every DB call (API test included) hangs silently.
    req.onblocked = () =>
      reject(new Error('数据库被其他页面占用，请关闭其他窗口后重试'));
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  // A failed open must not cache the rejection forever (e.g. blocked once).
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

function tx(db: IDBDatabase, store: string, mode: IDBTransactionMode): IDBObjectStore {
  return db.transaction(store, mode).objectStore(store);
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function idbGet<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDB();
  return wrap<T>(tx(db, store, 'readonly').get(key) as IDBRequest<T>);
}

export async function idbGetAll<T>(store: string): Promise<T[]> {
  const db = await openDB();
  return wrap<T[]>(tx(db, store, 'readonly').getAll() as IDBRequest<T[]>);
}

/** Put (insert or replace). For autoincrement stores, omit the key to insert. */
export async function idbPut<T>(store: string, value: T): Promise<IDBValidKey> {
  const db = await openDB();
  return wrap(tx(db, store, 'readwrite').put(value as unknown as IDBValidKey extends never ? never : object));
}

/** Add to an autoincrement store; returns the generated key. */
export async function idbAdd<T>(store: string, value: T): Promise<IDBValidKey> {
  const db = await openDB();
  return wrap(tx(db, store, 'readwrite').add(value as object));
}

export async function idbDelete(store: string, key: IDBValidKey): Promise<void> {
  const db = await openDB();
  await wrap(tx(db, store, 'readwrite').delete(key));
}

export async function idbBulkPut<T>(store: string, values: T[]): Promise<void> {
  const db = await openDB();
  const t = db.transaction(store, 'readwrite');
  const os = t.objectStore(store);
  for (const v of values) os.put(v as object);
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function idbCount(store: string): Promise<number> {
  const db = await openDB();
  return wrap<number>(tx(db, store, 'readonly').count());
}

/** Delete every row in a store. Used by restore, which replaces rather than merges. */
export async function idbClear(store: string): Promise<void> {
  const db = await openDB();
  const os = tx(db, store, 'readwrite');
  return new Promise((resolve, reject) => {
    const req = os.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/**
 * Equality lookup on an index, unordered, for stores keyed by a string id.
 * Separate from `idbQueryByIndex` because that one assumes numeric autoincrement
 * keys so it can walk them descending for cursor pagination — Moments likes and
 * comments have neither property, and callers sort them explicitly.
 */
export async function idbGetAllByIndex<T>(
  store: string,
  indexName: string,
  value: IDBValidKey,
): Promise<T[]> {
  const db = await openDB();
  const os = tx(db, store, 'readonly');
  return new Promise((resolve, reject) => {
    const req = os.index(indexName).getAll(value);
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Query an index for all rows whose indexed value equals `value`, newest-first,
 * optionally paginated with a cursor (return rows with id < cursorId).
 */
export async function idbQueryByIndex<T extends { id: number }>(
  store: string,
  indexName: string,
  value: IDBValidKey,
  opts: { limit?: number; beforeId?: number } = {},
): Promise<T[]> {
  const db = await openDB();
  const os = tx(db, store, 'readonly');
  const index = os.index(indexName);
  const results: T[] = [];
  const limit = opts.limit ?? Infinity;
  return new Promise((resolve, reject) => {
    // Descending order by primary key within the matched index value.
    const req = index.openCursor(IDBKeyRange.only(value), 'prev');
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || results.length >= limit) {
        resolve(results);
        return;
      }
      const row = cursor.value as T;
      if (opts.beforeId == null || row.id < opts.beforeId) results.push(row);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}
