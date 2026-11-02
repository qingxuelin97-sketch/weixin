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
// 原生 SQLite 驱动整个是懒加载的 (M-K10)：Web 永远用不到它，原生也只在迁移完成
// 之后才用——此前它静态挂在 driver 上，于是每一次冷启动都在解析一个 11KB、
// 绝大多数设备一辈子不会执行的模块。类型照常静态导入（编译期擦除，零字节）。
import type { SqlDb } from './sqlite';
type SqliteModule = typeof import('./sqlite');
let sqliteMod: SqliteModule | null = null;
/** 第一次需要 SQLite 时才去取模块；之后同步可用（dispatch 函数依赖这一点）。 */
export async function loadSqliteModule(): Promise<SqliteModule> {
  return (sqliteMod ??= await import('./sqlite'));
}
import { SQLITE_MIGRATED_AT_KEY } from '../lib/device-local';

/**
 * Settings row (in IndexedDB) that marks the migration as completed. It is
 * device-local — see src/lib/device-local.ts, which owns the one list a backup
 * filters against. Re-exported under the SAME name so existing import sites
 * keep working: an alias (`export const X = Y`) would be a second name for one
 * key, and the settings-key ledger guard follows imports, not aliases.
 */
export { SQLITE_MIGRATED_AT_KEY };

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
  await (await loadSqliteModule()).ensureSqliteSchema(sqlDb);
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
    await activateSqliteDriver(db);
    return 'sqlite';
  } catch {
    // A broken SQLite file must not brick the app; IDB still has everything
    // it had before the migration.
    activeDb = null;
    return 'idb';
  }
}

/**
 * Swap the live Repo to SQLite. Called by init and by the migration flow.
 * Async since M-K10: it may be the first thing that needs the (lazy) module.
 * `activeDb` is set only once the module is in hand, so the dispatch helpers
 * below can rely on `sqliteMod` whenever they see an active db.
 */
export async function activateSqliteDriver(db: SqlDb): Promise<void> {
  const m = await loadSqliteModule();
  activeDb = db;
  setRepoImpl(new m.SqliteRepo(db));
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

/** The live SQLite db + its module, when `store` is served from SQLite right now. */
function sqliteHome(store: string): { db: SqlDb; m: SqliteModule } | null {
  return activeDb && sqliteMod && sqliteMod.SQLITE_SERVED_STORES.has(store)
    ? { db: activeDb, m: sqliteMod }
    : null;
}

/** Every row of a store, from wherever that store actually lives right now. */
export async function readStoreRows(store: string): Promise<unknown[]> {
  const h = sqliteHome(store);
  return h ? h.m.sqliteReadAll(h.db, store) : idbGetAll(store);
}

/** Upsert one row into a store's live home. */
export async function writeStoreRow(store: string, row: unknown): Promise<void> {
  const h = sqliteHome(store);
  if (h) return void (await h.m.sqliteWriteRow(h.db, store, row));
  await idbPut(store, row);
}

/** Upsert many rows. */
export async function writeStoreRows(store: string, rows: unknown[]): Promise<void> {
  const h = sqliteHome(store);
  if (h) {
    for (const row of rows) await h.m.sqliteWriteRow(h.db, store, row);
    return;
  }
  await idbBulkPut(store, rows);
}

/**
 * Delete ONE row from a store's live home. Only the incremental-restore
 * tombstone path uses this: an increment must be able to say "this row is
 * gone" or a deleted message resurrects on every restore.
 */
export async function deleteStoreRow(store: string, key: string | number): Promise<void> {
  const h = sqliteHome(store);
  if (h) return void (await h.m.sqliteDeleteRow(h.db, store, key));
  await idbDelete(store, key);
}

/** Clear a store's live home (restore = replace, never merge). */
export async function clearStore(store: string): Promise<void> {
  const h = sqliteHome(store);
  if (h) return void (await h.m.sqliteClearStore(h.db, store));
  await idbClear(store);
}
