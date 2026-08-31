/**
 * Backup and restore (.aiwx), v3.
 *
 * There is no server: if this device is lost, the conversations are gone. That
 * makes export the only durability story the app has, so it errs toward
 * completeness — every store, one JSON envelope, no silent omissions.
 *
 * v2 (M-I17) added incremental packages on top of the v1 full snapshot: the
 * append-heavy stores (messages, moments, likes, comments, 零钱明细, media)
 * travelled by per-store WATERMARK — only rows above the last backup's max
 * id/createdAt. Everything else (the small stores: contacts, personas,
 * conversations, settings, transfers, red packets …) is snapshotted whole in
 * every package, so an incremental restore replaces those and upserts the rest.
 * Restore order: the base full first, then its increments oldest→newest.
 *
 * v3 (M-I18) fixes what a watermark cannot see. A watermark is a valid summary
 * of an APPEND-ONLY table, and none of those six tables actually is one:
 *
 *   IN-PLACE EDITS — a 转账 message row is written once as `meta.status
 *   'pending'` and EDITED days later to 'accepted'; a recall flips isRecalled;
 *   a send retry flips status. All of those live at or below the watermark, so
 *   v2 dropped them and a restored 转账 bubble sat on 「待收款」 forever while
 *   the wallet ledger said the money had arrived. v2 special-cased `isRecalled`
 *   alone, which is the shape of the bug, not a fix for it.
 *
 *   DELETIONS — an increment could only ever upsert, so a message, moment,
 *   comment or like the user DELETED came back to life on [full + increments].
 *   Including the one he deleted on purpose.
 *
 * The judge for both is a per-row CONTENT HASH (`RowDigest`), taken over the
 * same rows the package was cut from and stored on the device beside the
 * watermarks. The next package includes every row whose hash changed or is
 * new, and emits a TOMBSTONE for every id the digest knew that is now gone.
 * Why a hash and not a row-level `updatedAt`: an `updatedAt` column has to be
 * stamped correctly at every mutation site (there are dozens, across engines,
 * handlers, the money service and the UI), and the one site that forgets fails
 * SILENTLY and permanently — exactly the class of bug this is. The digest is
 * derived from the state itself, so no call site can be missed. The cost is
 * one canonical stringify per row per backup and a device-local map of ~15
 * bytes per row; a 32-bit collision would have to hit the SAME id's before and
 * after content (2^-32 per edit) to hide anything, and the digest never
 * travels in the file (it is on the device-local exclusion list).
 *
 *   DRIVER-AWARE I/O — reads and writes go through src/db/driver.ts, which
 *   routes each store to its live home (SQLite after the native migration,
 *   IndexedDB otherwise/always on web). Reading IndexedDB directly on a
 *   migrated device would export the stale pre-migration copy.
 *
 * DELIBERATE EXCLUSIONS, stated in the manifest so a restore can explain what
 * it can't bring back:
 *
 *   providers  — API keys never leave secure storage (constitution rule #2).
 *                Slots are exported by `keyAlias` only, so a restore rebuilds
 *                the configuration and asks for the keys again.
 *   tts_cache  — synthesized audio, re-derivable from the text it was made
 *                from. Including it would multiply the file size for data the
 *                app can regenerate on demand.
 *   设备本地行 — see src/lib/device-local.ts: the ONE list of settings rows
 *                that describe this phone (crypto key, backup shelf, notify
 *                permission, storage-engine flags) rather than the user's data.
 *                Filtered out of every export, preserved from THIS device
 *                across every restore.
 *
 * Restore is a REPLACE, not a merge. This is single-device data with no
 * conflict resolution anywhere in the system; merging two divergent histories
 * would interleave messages into a conversation that never happened. The prior
 * contents are snapshotted first so a mistaken restore is recoverable — that
 * now holds for the INCREMENTAL path too, which in v2 cleared and rewrote
 * whole stores with no marker, no snapshot and no rollback.
 */
import { STORES, idbGetAll, idbPut, openDB } from '../db/idb';
import { BACKFILL_BARRIER_KEY } from './settings-keys';
import {
  readStoreRows,
  writeStoreRow,
  writeStoreRows,
  deleteStoreRow,
  clearStore,
} from '../db/driver';
import {
  isPortableSettingRow,
  isDeviceLocalSettingRow,
  holdsCryptoKey,
  deviceLocalHome,
  BACKUP_DIGEST_KEY,
  BACKUP_WATERMARKS_KEY,
  AUTO_BACKUP_COUNTER_KEY,
  RESTORE_IN_PROGRESS_KEY,
} from './device-local';

/**
 * v3: tombstones + content-hash deltas. v2 and v1 files still restore — a v2
 * increment simply carries no tombstones and is applied by watermark rules.
 */
export const BACKUP_VERSION = 3;
export const BACKUP_EXT = '.aiwx';

export type BackupMode = 'full' | 'incremental';

/** Stores excluded from every export. See the module comment for why. */
const NEVER_EXPORT = new Set(['tts_cache']);

/**
 * Stores that travel by DELTA in an incremental package: new + changed rows,
 * plus tombstones for rows that vanished. The watermark field is kept because
 * the manifest still reports it (and a v2 file's `since` still resolves), but
 * the row-level judge is the digest — see the module comment.
 *
 * Every OTHER exported store is snapshotted whole in every package; they are
 * small enough that a snapshot is cheaper than any delta bookkeeping.
 */
export const WATERMARK_FIELDS: Record<string, 'id' | 'createdAt'> = {
  messages: 'id',
  moments: 'createdAt',
  moment_likes: 'createdAt',
  moment_comments: 'createdAt',
  wallet_tx: 'createdAt',
  media: 'createdAt',
};

/** Primary key path per store, from the single store list in db/idb.ts. */
const KEY_PATH: Record<string, string> = Object.fromEntries(
  STORES.map((s) => [s.name, s.keyPath]),
);

/** Stores whose primary key is a NUMBER (only `messages`, the rowid table). */
const NUMERIC_KEY_STORES: ReadonlySet<string> = new Set(
  STORES.filter((s) => s.autoIncrement).map((s) => s.name),
);

/** A row's primary key, as the string a digest/tombstone map uses. */
export function rowKeyOf(store: string, row: unknown): string {
  return String((row as Record<string, unknown>)[KEY_PATH[store] ?? 'id']);
}

/**
 * Back from the string form to the key the store is actually indexed by.
 * `messages` is an autoincrement rowid table: deleting `"7"` there would be a
 * no-op and the tombstone would silently do nothing.
 */
export function storeKeyOf(store: string, raw: string): string | number {
  return NUMERIC_KEY_STORES.has(store) ? Number(raw) : raw;
}

/** store → primary key (as string) → 32-bit content hash at the last backup. */
export type RowDigest = Record<string, Record<string, number>>;

/** FNV-1a, 32-bit. Cheap, dependency-free, and only ever compared per-id. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * JSON with object keys in a fixed order, so the hash describes CONTENT and
 * not property order. The two drivers genuinely disagree about order — the
 * SQLite reader rebuilds a message as `{...JSON.parse(data), id}` while IDB
 * hands back the order the row was stored in — and plain JSON.stringify would
 * therefore report every single row as "changed" the first time a migrated
 * device cut an increment. `undefined` is dropped, matching JSON.stringify.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const rec = value as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of Object.keys(rec).sort()) {
    if (rec[k] === undefined) continue;
    parts.push(`${JSON.stringify(k)}:${stableStringify(rec[k])}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * Content hash of one row.
 *
 * `media` is projected onto its metadata + byte length instead of its bytes:
 * media rows are written once and never edited, and hashing a 60MB library on
 * every nightly backup would cost more than the backup it is meant to shrink.
 */
export function rowHash(store: string, row: unknown): number {
  const r = row as Record<string, unknown>;
  if (store === 'media') {
    const blob = r.blob;
    const bytes =
      blob instanceof Blob
        ? blob.size
        : typeof r.blobB64 === 'string'
          ? r.blobB64.length
          : 0;
    return fnv1a(stableStringify({ ...r, blob: undefined, blobB64: undefined, bytes }));
  }
  return fnv1a(stableStringify(r));
}

/**
 * The digest of the state a package was cut from — the base the NEXT package
 * compares against. Only the delta stores get one; snapshot stores are carried
 * whole every time and need no bookkeeping.
 *
 * A store missing from `fullSets` (media, when the user excluded it) gets NO
 * digest, which makes the next package carry that store whole and emit no
 * tombstones for it. That is the safe direction: the chain never had those
 * rows, so it must receive all of them.
 */
export function computeRowDigest(stores: Record<string, unknown[]>): RowDigest {
  const out: RowDigest = {};
  for (const store of Object.keys(WATERMARK_FIELDS)) {
    const rows = stores[store];
    if (!rows) continue;
    const map: Record<string, number> = {};
    for (const r of rows) map[rowKeyOf(store, r)] = rowHash(store, r);
    out[store] = map;
  }
  return out;
}

export interface BackupManifest {
  version: number;
  /** IndexedDB schema version the export came from. */
  schemaVersion: number;
  createdAt: number;
  /** v2: 'full' | 'incremental'. Absent (v1 files) means 'full'. */
  mode?: BackupMode;
  /** v2: per-store high-water marks AFTER this backup (next increment's base). */
  watermarks?: Record<string, number>;
  /** v2, incremental only: the watermarks this package was cut against. */
  since?: Record<string, number>;
  /** Row count per store, so a restore can report what it's about to write. */
  counts: Record<string, number>;
  /** v3, incremental only: how many rows this package DELETES, per store. */
  deleted?: Record<string, number>;
  /** Stores deliberately left out, and why — surfaced in the restore UI. */
  omitted: Record<string, string>;
  appVersion?: string;
}

export interface BackupFile {
  manifest: BackupManifest;
  stores: Record<string, unknown[]>;
  /**
   * v3, incremental only: per-store primary keys that were DELETED since the
   * base package. Applied before the upserts. Deleting a row never renumbers
   * another, so `rowid 序 == 时间序` is untouched — that invariant is why a
   * tombstone list is the only shape a deletion may take here (re-inserting a
   * compacted range would change ids and break cursor pagination).
   */
  tombstones?: Record<string, Array<string | number>>;
}

export function backupMode(file: BackupFile): BackupMode {
  return file.manifest.mode ?? 'full';
}

/** Strip anything that must not leave the device. */
function sanitize(store: string, rows: unknown[]): unknown[] {
  if (store === 'settings') return rows.filter(isPortableSettingRow);
  if (store !== 'providers') return rows;
  // Keep the slot configuration, drop anything key-shaped. `keyAlias` is only a
  // handle into the keystore, so it is safe and necessary to keep.
  return rows.map((r) => {
    const { apiKey: _k, key: _k2, secret: _s, ...rest } = r as Record<string, unknown>;
    return rest;
  });
}

/**
 * Media rows carry Blobs, which JSON.stringify silently turns into `{}` — the
 * same class of bug as the CryptoKey husk (H3). They travel base64-encoded in
 * a `blobB64` field instead, rebuilt into Blobs on restore.
 */
export async function encodeMediaRows(rows: unknown[]): Promise<unknown[]> {
  return Promise.all(
    rows.map(async (r) => {
      const { blob, ...rest } = r as { blob?: Blob } & Record<string, unknown>;
      if (!(blob instanceof Blob)) return rest;
      const buf = new Uint8Array(await blob.arrayBuffer());
      let bin = '';
      // Chunked to keep the argument list under engine limits on big photos.
      for (let i = 0; i < buf.length; i += 0x8000) {
        bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      }
      return { ...rest, blobB64: btoa(bin) };
    }),
  );
}

export function decodeMediaRow(row: unknown): unknown {
  const { blobB64, ...rest } = row as { blobB64?: string; mime?: string } & Record<string, unknown>;
  if (typeof blobB64 !== 'string') return row;
  const bin = atob(blobB64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return { ...rest, blob: new Blob([buf], { type: (rest.mime as string) || 'image/jpeg' }) };
}

/**
 * The rows of one delta store that belong in an incremental package.
 *
 * With a digest base (v3) the judge is per-row content: a row is carried when
 * it is NEW to the base or its hash CHANGED — which covers appends, recalls,
 * 转账收款 status flips, send retries and anything else that edits an old row,
 * without any of them having to be enumerated here.
 *
 * Without one (a v2 chain, or a store the base package never read) it falls
 * back to the v2 watermark rule so old chains keep working. Pure; exported for
 * tests.
 */
export function incrementalRows(
  store: string,
  rows: unknown[],
  since: number,
  sinceDigest?: Record<string, number>,
): unknown[] {
  const field = WATERMARK_FIELDS[store];
  if (!field) return rows; // snapshot store — carried whole
  if (!sinceDigest) {
    return rows.filter((r) => {
      const rec = r as Record<string, unknown>;
      const v = Number(rec[field] ?? 0);
      if (v > since) return true;
      // v2's one hand-listed in-place edit; kept for chains cut before v3.
      return store === 'messages' && rec.isRecalled === true;
    });
  }
  return rows.filter((r) => {
    const prev = sinceDigest[rowKeyOf(store, r)];
    return prev === undefined || prev !== rowHash(store, r);
  });
}

/**
 * The primary keys the base package knew about and this state no longer has —
 * i.e. what the user deleted. Empty without a digest base: a v2 chain simply
 * cannot express a deletion, and inventing tombstones from a watermark would
 * delete rows that merely predate it. Pure; exported for tests.
 */
export function deletedRowKeys(
  store: string,
  rows: unknown[],
  sinceDigest?: Record<string, number>,
): Array<string | number> {
  if (!sinceDigest) return [];
  const alive = new Set(rows.map((r) => rowKeyOf(store, r)));
  const gone: Array<string | number> = [];
  for (const k of Object.keys(sinceDigest)) {
    if (!alive.has(k)) gone.push(storeKeyOf(store, k));
  }
  return gone;
}

/**
 * Per-store high-water marks over full row sets. Marks never move backwards:
 * a store that lost rows keeps its previous mark, so the next increment cannot
 * silently re-include rows an older package already carried.
 */
export function computeWatermarks(
  stores: Record<string, unknown[]>,
  prev: Record<string, number> = {},
): Record<string, number> {
  const out: Record<string, number> = { ...prev };
  for (const [store, field] of Object.entries(WATERMARK_FIELDS)) {
    const rows = stores[store];
    if (!rows) continue;
    let max = out[store] ?? 0;
    for (const r of rows) {
      const v = Number((r as Record<string, unknown>)[field] ?? 0);
      if (v > max) max = v;
    }
    out[store] = max;
  }
  return out;
}

export interface ExportOptions {
  /** false drops the 媒体库 (biggest store by bytes) for a lean file. */
  includeMedia?: boolean;
  mode?: BackupMode;
  /** The previous package's watermarks (v2 base). */
  since?: Record<string, number>;
  /** The previous package's row digest (v3 base) — the precise judge. */
  sinceDigest?: RowDigest;
}

/**
 * The envelope PLUS the bookkeeping the device must keep to cut the next
 * increment against this one. The digest is deliberately NOT in the file: it
 * is device-local state, it would dwarf a small increment, and it describes
 * the shelf rather than the data.
 */
export interface ExportResult {
  file: BackupFile;
  watermarks: Record<string, number>;
  digest: RowDigest;
}

/**
 * Read every exportable store into a single envelope, and return the state the
 * next increment needs. Callers that persist that state (manual export, auto
 * backup) use this; everything else uses `exportBackup`.
 *
 * @param now injected timestamp so exports are reproducible in tests
 */
export async function exportBackupWithState(
  now: number,
  appVersion?: string,
  opts: ExportOptions = {},
): Promise<ExportResult> {
  const includeMedia = opts.includeMedia ?? true;
  const mode = opts.mode ?? 'full';
  const since = opts.since ?? {};
  const sinceDigest = opts.sinceDigest;
  const stores: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  const tombstones: Record<string, Array<string | number>> = {};
  const deleted: Record<string, number> = {};
  const fullSets: Record<string, unknown[]> = {};

  for (const def of STORES) {
    if (NEVER_EXPORT.has(def.name)) continue;
    if (def.name === 'media' && !includeMedia) continue;
    const allRows = sanitize(def.name, await readStoreRows(def.name));
    fullSets[def.name] = allRows;
    let rows = allRows;
    if (mode === 'incremental' && def.name in WATERMARK_FIELDS) {
      const base = sinceDigest?.[def.name];
      rows = incrementalRows(def.name, allRows, since[def.name] ?? 0, base);
      const gone = deletedRowKeys(def.name, allRows, base);
      if (gone.length > 0) {
        tombstones[def.name] = gone;
        deleted[def.name] = gone.length;
      }
    }
    if (def.name === 'media') rows = await encodeMediaRows(rows);
    stores[def.name] = rows;
    counts[def.name] = rows.length;
  }

  const db = await openDB();
  const watermarks = computeWatermarks(fullSets, since);
  const file: BackupFile = {
    manifest: {
      version: BACKUP_VERSION,
      schemaVersion: db.version,
      createdAt: now,
      mode,
      watermarks,
      ...(mode === 'incremental' ? { since } : {}),
      counts,
      ...(Object.keys(deleted).length > 0 ? { deleted } : {}),
      omitted: {
        tts_cache: '语音缓存可按原文重新合成，不占备份体积',
        'providers.apiKey': 'API key 只存在设备安全存储，永不导出',
        'settings.__crypto_master': '本机加密主密钥不可迁移，恢复时保留本机的',
        'settings.设备本地行': '备份货架、通知权限、存储引擎标志属于本机，恢复时保留本机的',
        // "No silent omissions": a user choice is still an omission the restore
        // UI must be able to explain — dangling avatar/image refs otherwise
        // read as data loss.
        ...(includeMedia
          ? {}
          : { media: '按导出时的选择未包含素材图片；头像与图片消息恢复后将显示占位' }),
      },
      appVersion,
    },
    stores,
    ...(Object.keys(tombstones).length > 0 ? { tombstones } : {}),
  };
  return { file, watermarks, digest: computeRowDigest(fullSets) };
}

/** The envelope alone. See `exportBackupWithState` for the bookkeeping. */
export async function exportBackup(
  now: number,
  appVersion?: string,
  opts: ExportOptions = {},
): Promise<BackupFile> {
  return (await exportBackupWithState(now, appVersion, opts)).file;
}

/* ------------------------------------------------ device-side backup state */

export interface BackupState {
  watermarks?: Record<string, number>;
  digest?: RowDigest;
}

/**
 * The base the next increment is cut against. Both halves must move together:
 * a watermark without its digest silently degrades to v2 behaviour, which is
 * the bug this release exists to fix.
 */
export async function loadBackupState(): Promise<BackupState> {
  const rows = (await readStoreRows('settings')) as Array<{ key?: string; value?: unknown }>;
  const at = (k: string) => rows.find((r) => r.key === k)?.value;
  return {
    watermarks: at(BACKUP_WATERMARKS_KEY) as Record<string, number> | undefined,
    digest: at(BACKUP_DIGEST_KEY) as RowDigest | undefined,
  };
}

export async function saveBackupState(state: Required<BackupState>): Promise<void> {
  await writeStoreRow('settings', { key: BACKUP_WATERMARKS_KEY, value: state.watermarks });
  await writeStoreRow('settings', { key: BACKUP_DIGEST_KEY, value: state.digest });
}

/**
 * Land a produced package, then advance the base ONLY IF that landing worked.
 *
 * The manual export used to swallow a failed shelf write (`.catch(() => {})`)
 * and advance the watermarks anyway. The shelf is what `resolveRestoreChain`
 * resolves against, so every later auto increment was then cut against a full
 * that no device could find: the chain restored, reported success, and was
 * silently missing everything between that full and the next one. Returns
 * whether the package is actually on the shelf, so the UI can say so.
 */
export async function commitBackupState(
  state: Required<BackupState>,
  shelve: () => Promise<void>,
): Promise<boolean> {
  try {
    await shelve();
  } catch {
    return false;
  }
  await saveBackupState(state);
  return true;
}

/**
 * Forget the base. Called after any restore: the data on this device is no
 * longer what the shelf's watermarks describe, so the next auto backup must be
 * a FULL (`runAutoBackup` treats a missing base exactly that way). Chaining an
 * increment onto a stale base is how a restore chain silently loses a span.
 */
export async function clearBackupState(): Promise<void> {
  for (const key of [BACKUP_WATERMARKS_KEY, BACKUP_DIGEST_KEY, AUTO_BACKUP_COUNTER_KEY]) {
    await deleteStoreRow('settings', key);
  }
}

export function serializeBackup(file: BackupFile): string {
  return JSON.stringify(file);
}

/** Parse and validate. Throws a user-facing message when the file is unusable. */
export function parseBackup(text: string): BackupFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('文件不是有效的备份格式');
  }
  const file = parsed as Partial<BackupFile>;
  if (!file?.manifest || !file.stores) throw new Error('备份文件缺少 manifest 或数据');
  if (typeof file.manifest.version !== 'number') throw new Error('备份文件版本信息损坏');
  if (file.manifest.version > BACKUP_VERSION) {
    throw new Error(`备份来自更新的版本（v${file.manifest.version}），请先升级 App`);
  }
  return file as BackupFile;
}

export interface RestoreResult {
  restored: Record<string, number>;
  /** Stores in the file that this build has no home for (a forward-compat hint). */
  unknownStores: string[];
  /** The pre-restore snapshot, so the caller can offer an undo. */
  snapshot: BackupFile;
}

/* --------------------------------------------- device-local row protection */

/**
 * The device-local settings rows as they stand right now, captured from BOTH
 * homes because a restore clears whichever one the driver serves.
 *
 * On an IDB device the two sets overlap and the write-back is idempotent. On a
 * migrated device they are genuinely different rows: `clearStore('settings')`
 * empties the SQLite table while the crypto key and the engine flags sit
 * untouched in IndexedDB, which is exactly where their readers look for them.
 */
interface DeviceLocalRows {
  idb: unknown[];
  live: unknown[];
}

async function captureDeviceLocalRows(): Promise<DeviceLocalRows> {
  const idb = (await idbGetAll('settings')).filter(
    (r) => isDeviceLocalSettingRow(r) && deviceLocalHome(rowKeyOf('settings', r)) !== 'live',
  );
  const live = (await readStoreRows('settings')).filter(
    // A CryptoKey can never go through the driver: on SQLite that is a TEXT
    // column, and `{}` is what comes back out (bug H3, again).
    (r) => isDeviceLocalSettingRow(r) && !holdsCryptoKey(r),
  );
  return { idb, live };
}

/**
 * Put them back. `skip` names rows the caller manages explicitly — the restore
 * marker (it is being held on purpose) and the backup base (which a completed
 * restore must forget, not inherit).
 */
async function restoreDeviceLocalRows(
  rows: DeviceLocalRows,
  skip: ReadonlySet<string> = new Set(),
): Promise<void> {
  for (const row of rows.live) {
    if (skip.has(rowKeyOf('settings', row))) continue;
    await writeStoreRow('settings', row);
  }
  // IDB last: on a non-migrated device this is where the CryptoKey must land,
  // and it must win over anything the driver wrote for the same key.
  for (const row of rows.idb) {
    if (skip.has(rowKeyOf('settings', row))) continue;
    await idbPut('settings', row);
  }
}

/** Rows the restore paths re-establish themselves rather than carrying over. */
const MANAGED_BY_RESTORE: ReadonlySet<string> = new Set([
  RESTORE_IN_PROGRESS_KEY,
  BACKUP_WATERMARKS_KEY,
  BACKUP_DIGEST_KEY,
  AUTO_BACKUP_COUNTER_KEY,
]);

/**
 * Apply one package's tombstones to a store. Deletes come BEFORE the upserts:
 * an id that was deleted and re-created reads as "changed", not "deleted", so
 * the two sets never overlap — but ordering it this way keeps that true even
 * if a future package ever says both.
 */
async function applyTombstones(
  file: BackupFile,
  store: string,
): Promise<number> {
  const keys = file.tombstones?.[store];
  if (!keys?.length) return 0;
  for (const key of keys) await deleteStoreRow(store, key);
  return keys.length;
}

/**
 * Replace the database contents with a FULL backup.
 *
 * Snapshots current state first — a restore is destructive and the user may
 * have picked the wrong file. Incremental packages are applied AFTER a full
 * restore via `applyIncrementalBackup`; handing one to this function is a
 * user-facing error, not a half-restore.
 */
export async function restoreBackup(file: BackupFile, now: number): Promise<RestoreResult> {
  if (backupMode(file) === 'incremental') {
    throw new Error('这是一个增量备份，需要先恢复它所基于的全量备份，再叠加恢复增量');
  }
  const snapshot = await exportBackup(now);
  const known = new Set(STORES.map((s) => s.name));
  const unknownStores = Object.keys(file.stores).filter((n) => !known.has(n));
  const restored: Record<string, number> = {};

  // Everything that describes THIS PHONE rather than the data survives the
  // restore: the crypto master key (whose loss orphans every stored API key),
  // the backup shelf, the notification-permission facts, the storage-engine
  // flags. One list, src/lib/device-local.ts — see its header for the three
  // separate bugs that came from judging this per call site.
  const deviceRows = await captureDeviceLocalRows();

  // PHASE 1 — prepare everything, touching nothing. Decoding is where a bad or
  // truncated file actually blows up (a corrupt base64 media blob, a row the
  // schema no longer accepts), and the old code discovered that AFTER clearing
  // some stores: the backup was rejected and the user's real data was already
  // gone, with only an in-memory snapshot standing between them and losing it.
  const staged: Array<{ store: string; rows: unknown[] }> = [];
  for (const def of STORES) {
    let rows = file.stores[def.name];
    if (!rows) continue; // absent from this backup — leave the store untouched
    if (def.name === 'settings') rows = rows.filter(isPortableSettingRow);
    if (def.name === 'media') rows = rows.map(decodeMediaRow);
    staged.push({ store: def.name, rows });
  }

  // PHASE 2 — destructive. A crash between here and the flag's removal leaves a
  // half-written database that LOOKS fine; the marker is how the next launch
  // can tell, instead of the user discovering it one missing conversation later.
  await writeStoreRow('settings', { key: RESTORE_IN_PROGRESS_KEY, value: now });
  try {
    for (const { store, rows } of staged) {
      await clearStore(store);
      // The marker lives in `settings`, so clearing that store erases it. Put it
      // straight back or the crash window it exists to cover is uncovered.
      if (store === 'settings') {
        await writeStoreRow('settings', { key: RESTORE_IN_PROGRESS_KEY, value: now });
      }
      // Bulk, not row-by-row: on IndexedDB `writeStoreRows` puts a whole store
      // inside ONE transaction. Restoring `messages` a row at a time meant one
      // transaction per message — tens of thousands of them on a real install,
      // which is most of why a large restore takes long enough for Android to
      // reclaim the WebView mid-write (the very crash RESTORE_IN_PROGRESS_KEY
      // exists to report). Same failure semantics: the loop already aborted the
      // whole restore on the first throw.
      await writeStoreRows(store, rows);
      restored[store] = rows.length;
    }
    await restoreDeviceLocalRows(deviceRows, MANAGED_BY_RESTORE);
  } catch (e) {
    // Roll back from the snapshot we took before touching anything. Best effort
    // by necessity — IndexedDB gives us no cross-store transaction — but it is
    // the difference between "restore failed" and "everything is gone".
    await rollback(snapshot, deviceRows).catch(() => {});
    throw new Error(
      `恢复失败，已尽力回滚到恢复前的状态：${e instanceof Error ? e.message : String(e)}`,
    );
  }
  await writeStoreRow('settings', { key: RESTORE_IN_PROGRESS_KEY, value: 0 });

  // The data on this device is no longer what the shelf's base described, so
  // the next auto backup must be a full one rather than an increment hanging
  // off a base that no longer exists.
  await clearBackupState();

  // The restored file may be days old; without re-arming the barrier the next
  // foreground pass would "backfill" that whole gap with fabricated activity.
  await writeStoreRow('settings', { key: BACKFILL_BARRIER_KEY, value: now });

  return { restored, unknownStores, snapshot };
}

export interface ApplyIncrementalOptions {
  /**
   * The state to roll back to if this package fails. A chain restore passes
   * the snapshot taken before its BASE full, so a package that dies halfway
   * unwinds the whole chain instead of stranding the user between two versions
   * of their history — and so a seven-package chain snapshots once, not seven
   * times (a snapshot re-encodes the whole media library).
   */
  snapshot?: BackupFile;
}

/**
 * Layer one incremental package on top of the current contents.
 *
 * Delta stores UPSERT (rows keep their original keys, so a message lands back
 * under its own id — `rowid 序==时间序` holds because ids are never reassigned)
 * and then have their TOMBSTONES applied, which is the only way an increment
 * can express "the user deleted this". Snapshot stores REPLACE, same as a full
 * restore — they were exported whole.
 *
 * v2 did all of that with no marker, no snapshot and no rollback, on the same
 * destructive clear+write a full restore uses: one truncated package in a chain
 * silently took the contact list, the conversation list and the settings with
 * it. This path is now protected exactly like `restoreBackup`.
 */
export async function applyIncrementalBackup(
  file: BackupFile,
  now: number,
  opts: ApplyIncrementalOptions = {},
): Promise<Record<string, number>> {
  if (backupMode(file) !== 'incremental') {
    throw new Error('这不是增量备份文件');
  }
  const applied: Record<string, number> = {};
  const snapshot = opts.snapshot ?? (await exportBackup(now));
  const deviceRows = await captureDeviceLocalRows();

  // Stage first (decode is the risky part), touch nothing until it all parsed.
  const staged: Array<{ store: string; rows: unknown[]; upsert: boolean }> = [];
  for (const def of STORES) {
    let rows = file.stores[def.name];
    if (!rows) continue;
    if (def.name === 'settings') rows = rows.filter(isPortableSettingRow);
    if (def.name === 'media') rows = rows.map(decodeMediaRow);
    staged.push({ store: def.name, rows, upsert: def.name in WATERMARK_FIELDS });
  }

  await writeStoreRow('settings', { key: RESTORE_IN_PROGRESS_KEY, value: now });
  try {
    for (const { store, rows, upsert } of staged) {
      if (upsert) {
        await applyTombstones(file, store);
      } else {
        await clearStore(store);
        if (store === 'settings') {
          await writeStoreRow('settings', { key: RESTORE_IN_PROGRESS_KEY, value: now });
        }
      }
      await writeStoreRows(store, rows);
      applied[store] = rows.length;
    }
    // A tombstone-only store is never staged (the package carries no rows for
    // it), so sweep the rest here rather than losing the deletions.
    for (const store of Object.keys(file.tombstones ?? {})) {
      if (staged.some((s) => s.store === store)) continue;
      if (!(store in WATERMARK_FIELDS)) continue;
      await applyTombstones(file, store);
    }
    await restoreDeviceLocalRows(deviceRows, MANAGED_BY_RESTORE);
  } catch (e) {
    await rollback(snapshot, deviceRows).catch(() => {});
    throw new Error(
      `增量恢复失败，已尽力回滚到恢复前的状态：${e instanceof Error ? e.message : String(e)}`,
    );
  }
  await writeStoreRow('settings', { key: RESTORE_IN_PROGRESS_KEY, value: 0 });
  await clearBackupState();
  await writeStoreRow('settings', { key: BACKFILL_BARRIER_KEY, value: now });
  return applied;
}

/** Put the pre-restore snapshot back. Used only on a failed restore. */
async function rollback(snapshot: BackupFile, deviceRows: DeviceLocalRows): Promise<void> {
  for (const def of STORES) {
    let rows = snapshot.stores[def.name];
    if (!rows) continue;
    if (def.name === 'media') rows = rows.map(decodeMediaRow);
    await clearStore(def.name);
    await writeStoreRows(def.name, rows);
  }

  // Everything device-local comes back, INCLUDING the backup base: a failed
  // restore changed nothing, so the shelf's watermarks still describe reality.
  await restoreDeviceLocalRows(deviceRows, new Set([RESTORE_IN_PROGRESS_KEY]));
  await writeStoreRow('settings', { key: RESTORE_IN_PROGRESS_KEY, value: 0 });
}

/**
 * Did a previous restore die partway through? Returns the timestamp it started,
 * or 0.
 *
 * Wired at two places, because a marker nobody reads is a marker that does
 * nothing (this was written in I17 with zero callers): the launch pass in
 * `useSchedulerRuntime` announces it once, and the backup page keeps a standing
 * warning until it is acknowledged. A 60MB restore killed by the WebView being
 * reclaimed halfway through `media` otherwise leaves a database that looks
 * fine right up until the missing conversation is noticed.
 */
export async function pendingRestoreAt(): Promise<number> {
  const rows = (await readStoreRows('settings')) as Array<{ key?: string; value?: unknown }>;
  const row = rows.find((r) => r.key === RESTORE_IN_PROGRESS_KEY);
  return typeof row?.value === 'number' ? row.value : 0;
}

/** The user has been told. Clears the standing warning (not the data). */
export async function acknowledgePendingRestore(): Promise<void> {
  await writeStoreRow('settings', { key: RESTORE_IN_PROGRESS_KEY, value: 0 });
}

/** Suggested filename, e.g. `weixin-ai-20260808-1430.aiwx` (`-inc` when 增量). */
export function backupFilename(now: number, mode: BackupMode = 'full'): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  return `weixin-ai-${stamp}${mode === 'incremental' ? '-inc' : ''}${BACKUP_EXT}`;
}
