/**
 * One-time IndexedDB → SQLite migration (M-I17).
 *
 * COPIES, never deletes: the IndexedDB source stays exactly as it was, which
 * is what makes 「回退到 IndexedDB」 a one-line flag clear instead of a reverse
 * migration. Properties:
 *
 *   - batched, with a progress callback for the settings-page progress bar;
 *   - interruptible and resumable: per-store completion (and, for the huge
 *     `messages` store, a per-batch id watermark) is persisted after every
 *     batch, so a killed app continues where it stopped instead of starting
 *     over;
 *   - the completion flag is set ONLY after every store landed and a row-count
 *     verify passed. A failed or aborted run leaves the flag unset, so the
 *     next launch silently keeps IndexedDB (no data ever at risk);
 *   - `messages` keep their EXPLICIT ids (INSERT with id), because replyToId,
 *     evidence lists and conv summaries all reference message ids — and
 *     because rowid 序==时间序 must mean the same rows it meant before.
 *
 * Row-level exclusions (the H3 lesson):
 *   - any settings row whose value is a CryptoKey — the device-local master
 *     key is non-extractable and JSON-serializes to `{}`; it STAYS in
 *     IndexedDB where lib/keystore.ts reads it. Checked with `instanceof
 *     CryptoKey`, never truthiness (an old husk `{}` is truthy).
 *   - `tts_cache` wholesale: re-derivable audio whose only reader talks to
 *     IndexedDB directly.
 *
 * No Date.now() / Math.random() anywhere in here (铁律 4): the caller injects
 * the clock, and nothing needs randomness.
 */
import { STORES, idbGet, idbGetAll, idbPut, idbDelete } from './idb';
import {
  SQLITE_TABLES,
  sqliteWriteRow,
  sqliteClearStore,
  sqliteCount,
  ensureSqliteSchema,
  type SqlDb,
} from './sqlite';
import { SQLITE_MIGRATED_AT_KEY } from './driver';

/** Where the resumable progress lives (an IndexedDB settings row). */
export const MIGRATE_PROGRESS_KEY = 'sqliteMigrateProgress';

/** Stores never copied, with the reason the settings page shows. */
export const MIGRATE_SKIPPED: Record<string, string> = {
  tts_cache: '语音缓存可按原文重新合成，不迁移',
};

interface ProgressRow {
  /** Stores fully landed in SQLite. */
  done: string[];
  /** Highest message id already copied (messages resume mid-store). */
  messagesUpto?: number;
}

export interface MigrateProgressEvent {
  store: string;
  storeIndex: number;
  storeCount: number;
  /** Rows landed in this store so far. */
  rows: number;
  /** Total rows this store holds in IndexedDB. */
  totalRows: number;
}

export interface MigrateResult {
  ok: boolean;
  aborted: boolean;
  /** Rows landed per store (this run + previous resumed runs are in SQLite). */
  counts: Record<string, number>;
  /** Row-level exclusions this run made, per store. */
  excluded: Record<string, number>;
  error?: string;
}

/** Settings rows that describe THIS migration/driver, not the data. */
const DRIVER_STATE_KEYS = new Set([SQLITE_MIGRATED_AT_KEY, MIGRATE_PROGRESS_KEY]);

/**
 * A settings row that must stay in IndexedDB: the live CryptoKey master key
 * (instanceof, never truthiness — a `{}` husk is truthy), and the migration's
 * own bookkeeping rows (copying a progress marker into the destination would
 * freeze a stale copy of it there).
 */
function isDeviceLocalRow(store: string, row: unknown): boolean {
  if (store !== 'settings') return false;
  const r = row as { key?: unknown; value?: unknown } | null;
  if (typeof r?.key === 'string' && DRIVER_STATE_KEYS.has(r.key)) return true;
  return typeof CryptoKey !== 'undefined' && r?.value instanceof CryptoKey;
}

async function readProgress(): Promise<ProgressRow> {
  const row = await idbGet<{ key: string; value: ProgressRow }>('settings', MIGRATE_PROGRESS_KEY);
  const v = row?.value;
  return v && Array.isArray(v.done) ? v : { done: [] };
}

async function writeProgress(p: ProgressRow): Promise<void> {
  await idbPut('settings', { key: MIGRATE_PROGRESS_KEY, value: p });
}

/**
 * Run (or resume) the migration. Returns rather than throws on failure, so the
 * settings page can show the reason without a try/catch of its own.
 */
export async function migrateToSqlite(
  db: SqlDb,
  opts: {
    now: () => number;
    batchSize?: number;
    onProgress?: (p: MigrateProgressEvent) => void;
    shouldAbort?: () => boolean;
  },
): Promise<MigrateResult> {
  const batchSize = opts.batchSize ?? 200;
  const counts: Record<string, number> = {};
  const excluded: Record<string, number> = {};
  const stores = STORES.map((s) => s.name).filter((n) => !(n in MIGRATE_SKIPPED));

  try {
    await ensureSqliteSchema(db);
    const progress = await readProgress();

    for (let si = 0; si < stores.length; si++) {
      const store = stores[si];
      if (progress.done.includes(store)) continue;

      const all = await idbGetAll<Record<string, unknown>>(store);
      const emit = (rows: number) =>
        opts.onProgress?.({
          store,
          storeIndex: si,
          storeCount: stores.length,
          rows,
          totalRows: all.length,
        });

      if (store === 'messages') {
        // Resume from the id watermark; ids ascend, so `>` is exact.
        const upto = progress.messagesUpto ?? 0;
        const rest = (all as unknown as Array<{ id: number }>).filter((m) => m.id > upto);
        let landed = all.length - rest.length;
        for (let i = 0; i < rest.length; i += batchSize) {
          if (opts.shouldAbort?.()) return { ok: false, aborted: true, counts, excluded };
          const batch = rest.slice(i, i + batchSize);
          await db.execute('BEGIN', false);
          try {
            for (const row of batch) await sqliteWriteRow(db, store, row);
            await db.execute('COMMIT', false);
          } catch (e) {
            await db.execute('ROLLBACK', false).catch(() => {});
            throw e;
          }
          landed += batch.length;
          progress.messagesUpto = batch[batch.length - 1].id;
          await writeProgress(progress);
          emit(landed);
        }
        counts[store] = all.length;
      } else {
        // Kv stores restart clean on resume — INSERT OR REPLACE makes a
        // half-copied store idempotent, but clearing first keeps the verify
        // honest when the IDB side shrank between runs.
        await sqliteClearStore(db, store);
        let landed = 0;
        let skipped = 0;
        for (let i = 0; i < all.length; i += batchSize) {
          if (opts.shouldAbort?.()) return { ok: false, aborted: true, counts, excluded };
          const batch = all.slice(i, i + batchSize);
          let skippedInBatch = 0;
          await db.execute('BEGIN', false);
          try {
            for (const row of batch) {
              if (isDeviceLocalRow(store, row)) {
                skippedInBatch++;
                continue;
              }
              await sqliteWriteRow(db, store, row);
            }
            await db.execute('COMMIT', false);
          } catch (e) {
            await db.execute('ROLLBACK', false).catch(() => {});
            throw e;
          }
          skipped += skippedInBatch;
          landed += batch.length - skippedInBatch;
          emit(landed);
        }
        counts[store] = landed;
        if (skipped > 0) excluded[store] = skipped;
      }

      progress.done.push(store);
      await writeProgress(progress);
    }

    // Verify before declaring victory: every store's SQLite row count must
    // match what IndexedDB holds (minus this run's row-level exclusions).
    for (const store of stores) {
      const idbRows = await idbGetAll<Record<string, unknown>>(store);
      const expect =
        store === 'settings'
          ? idbRows.filter((r) => !isDeviceLocalRow(store, r)).length
          : idbRows.length;
      const got = await sqliteCount(db, store);
      if (got !== expect) {
        return {
          ok: false,
          aborted: false,
          counts,
          excluded,
          error: `校验失败：${store} 应有 ${expect} 行，SQLite 里有 ${got} 行`,
        };
      }
    }

    // Only now does the flag flip — and the resume marker is retired.
    await idbPut('settings', { key: SQLITE_MIGRATED_AT_KEY, value: opts.now() });
    await idbDelete('settings', MIGRATE_PROGRESS_KEY);
    return { ok: true, aborted: false, counts, excluded };
  } catch (e) {
    return {
      ok: false,
      aborted: false,
      counts,
      excluded,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Sanity: every table the migrator writes exists in the SQLite DDL. */
export function migratableStores(): string[] {
  return STORES.map((s) => s.name).filter(
    (n) => !(n in MIGRATE_SKIPPED) && SQLITE_TABLES.includes(n),
  );
}
