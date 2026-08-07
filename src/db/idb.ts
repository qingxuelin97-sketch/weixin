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
const DB_VERSION = 1;

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
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
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
