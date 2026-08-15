/**
 * Storage driver selection (M-I17).
 *
 * Web stays on IndexedDB, permanently — the SQLite driver activates only on a
 * native platform AND only after the one-time migration has completed and set
 * its flag. The flag itself lives in IndexedDB (read directly, not through the
 * Repo, because it must be readable BEFORE the driver is chosen), so:
 *
 *   - a failed migration never sets it → next launch silently stays on IDB;
 *   - 「回退到 IndexedDB」 just clears it → the data is still in IDB, untouched,
 *     because migration COPIES and never deletes the source.
 *
 * This module also owns the raw per-store dispatch (`readStoreRows` etc.) that
 * backup v2 uses: stores the SQLite driver serves are read from SQLite when it
 * is active, while stores whose live home is IndexedDB regardless of driver
 * (the scheduler queue, the TTS cache, story tables — their readers bypass the
 * Repo) always go to IDB. Without this dispatch, a backup taken on a migrated
 * device would silently export the STALE pre-migration IndexedDB data.
 */
import { Capacitor } from '@capacitor/core';
import { idbGet, idbGetAll, idbPut, idbDelete, idbClear, idbBulkPut } from './idb';
import { setRepoImpl, IdbRepo } from './repo';
import {
  SqliteRepo,
  SQLITE_SERVED_STORES,
  ensureSqliteSchema,
  sqliteReadAll,
  sqliteWriteRow,
  sqliteClearStore,
  type SqlDb,
} from './sqlite';

/** Settings row (in IndexedDB) that marks the migration as completed. */
export const SQLITE_MIGRATED_AT_KEY = 'sqliteMigratedAt';

const DB_FILE = 'weixin-ai';

let activeDb: SqlDb | null = null;
let initDone = false;

export type StorageEngine = 'idb' | 'sqlite';

export function activeEngine(): StorageEngine {
  return activeDb ? 'sqlite' : 'idb';
}

export function isSqliteActive(): boolean {
  return activeDb != null;
}

/** When (epoch ms) the migration completed, or 0. Readable on every platform. */
export async function sqliteMigratedAt(): Promise<number> {
  const row = await idbGet<{ key: string; value: number }>('settings', SQLITE_MIGRATED_AT_KEY);
  return typeof row?.value === 'number' ? row.value : 0;
}

/**
 * Open (or reuse) the native SQLite connection and make sure the schema is in
 * place. Only meaningful on a native platform; the web build never calls it.
 */
export async function openNativeSqliteDb(): Promise<SqlDb> {
  if (activeDb) return activeDb;
  const { CapacitorSQLite, SQLiteConnection } = await import('@capacitor-community/sqlite');
  const conn = new SQLiteConnection(CapacitorSQLite);
  const consistent = (await conn.checkConnectionsConsistency()).result ?? false;
  const isConn = (await conn.isConnection(DB_FILE, false)).result ?? false;
  const db =
    consistent && isConn
      ? await conn.retrieveConnection(DB_FILE, false)
      : await conn.createConnection(DB_FILE, false, 'no-encryption', 1, false);
  await db.open();
  const sqlDb = db as unknown as SqlDb;
  await ensureSqliteSchema(sqlDb);
  return sqlDb;
}

/**
 * Choose the driver. Called once at startup, BEFORE the store hydrates.
 * Failure at any step keeps the IDB driver — the app must boot regardless.
 */
export async function initStorageDriver(
  openDb: () => Promise<SqlDb> = openNativeSqliteDb,
  isNative: () => boolean = () => Capacitor.isNativePlatform(),
): Promise<StorageEngine> {
  if (initDone) return activeEngine();
  initDone = true;
  if (!isNative()) return 'idb';
  try {
    if ((await sqliteMigratedAt()) <= 0) return 'idb';
    const db = await openDb();
    activateSqliteDriver(db);
    return 'sqlite';
  } catch {
    // A broken SQLite file must not brick the app; IDB still has everything
    // it had before the migration.
    activeDb = null;
    return 'idb';
  }
}

/** Swap the live Repo to SQLite. Called by init and by the migration flow. */
export function activateSqliteDriver(db: SqlDb): void {
  activeDb = db;
  setRepoImpl(new SqliteRepo(db));
}

/**
 * 「回退到 IndexedDB」: clear the flag and swap the Repo back. The IDB data is
 * exactly where the migration left it — untouched. Anything written while on
 * SQLite stays in the SQLite file (re-running the migration overwrites it
 * from IDB again; that is the documented meaning of the switch).
 */
export async function revertToIdb(): Promise<void> {
  await idbDelete('settings', SQLITE_MIGRATED_AT_KEY);
  activeDb = null;
  setRepoImpl(new IdbRepo());
}

/** Test hook: reset module state between cases. */
export function _resetDriverForTests(): void {
  activeDb = null;
  initDone = false;
  setRepoImpl(new IdbRepo());
}

/* ------------------------------------------------- raw per-store dispatch */

function sqliteHome(store: string): SqlDb | null {
  return activeDb && SQLITE_SERVED_STORES.has(store) ? activeDb : null;
}

/** Every row of a store, from wherever that store actually lives right now. */
export async function readStoreRows(store: string): Promise<unknown[]> {
  const db = sqliteHome(store);
  return db ? sqliteReadAll(db, store) : idbGetAll(store);
}

/** Upsert one row into a store's live home. */
export async function writeStoreRow(store: string, row: unknown): Promise<void> {
  const db = sqliteHome(store);
  if (db) return void (await sqliteWriteRow(db, store, row));
  await idbPut(store, row);
}

/** Upsert many rows. */
export async function writeStoreRows(store: string, rows: unknown[]): Promise<void> {
  const db = sqliteHome(store);
  if (db) {
    for (const row of rows) await sqliteWriteRow(db, store, row);
    return;
  }
  await idbBulkPut(store, rows);
}

/** Clear a store's live home (restore = replace, never merge). */
export async function clearStore(store: string): Promise<void> {
  const db = sqliteHome(store);
  if (db) return void (await sqliteClearStore(db, store));
  await idbClear(store);
}
