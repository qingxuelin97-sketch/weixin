/**
 * Backup and restore (.aiwx), v2.
 *
 * There is no server: if this device is lost, the conversations are gone. That
 * makes export the only durability story the app has, so it errs toward
 * completeness — every store, one JSON envelope, no silent omissions.
 *
 * v2 (M-I17) adds two things on top of the v1 full snapshot:
 *
 *   INCREMENTAL PACKAGES — the append-heavy stores (messages, moments, likes,
 *   comments, 零钱明细, media) travel by per-store watermark: only rows ABOVE
 *   the last backup's max id/createdAt are included. Everything else (the
 *   small, mutable stores: contacts, personas, conversations, settings, …) is
 *   snapshotted whole in every package, so an incremental restore replaces
 *   them and upserts the rest. Restore order: the base full first, then its
 *   increments oldest→newest. One wrinkle: a recall EDITS an old message row,
 *   so incremental `messages` also carries every recalled row at or below the
 *   watermark — recalls are rare and small, and without this a message
 *   recalled after the full backup would resurrect un-recalled.
 *
 *   DRIVER-AWARE I/O — reads and writes go through src/db/driver.ts, which
 *   routes each store to its live home (SQLite after the native migration,
 *   IndexedDB otherwise/always on web). Reading IndexedDB directly on a
 *   migrated device would export the stale pre-migration copy.
 *
 * TWO DELIBERATE EXCLUSIONS, both stated in the manifest so a restore can
 * explain what it can't bring back:
 *
 *   providers  — API keys never leave secure storage (constitution rule #2).
 *                Slots are exported by `keyAlias` only, so a restore rebuilds
 *                the configuration and asks for the keys again.
 *   tts_cache  — synthesized audio, re-derivable from the text it was made
 *                from. Including it would multiply the file size for data the
 *                app can regenerate on demand.
 *
 * Restore is a REPLACE, not a merge. This is single-device data with no
 * conflict resolution anywhere in the system; merging two divergent histories
 * would interleave messages into a conversation that never happened. The prior
 * contents are snapshotted first so a mistaken restore is recoverable.
 */
import { STORES, idbGetAll, idbPut, openDB } from '../db/idb';
import { readStoreRows, writeStoreRow, clearStore } from '../db/driver';

/** v2: incremental packages + watermarks. v1 files (full only) still restore. */
export const BACKUP_VERSION = 2;
export const BACKUP_EXT = '.aiwx';

export type BackupMode = 'full' | 'incremental';

/** Stores excluded from every export. See the module comment for why. */
const NEVER_EXPORT = new Set(['tts_cache']);

/**
 * Individual settings rows that must never travel in a backup. The WebCrypto
 * master key is non-extractable and DEVICE-LOCAL: JSON.stringify turns it into
 * `{}`, and restoring that husk over a working key bricks the keystore — every
 * later encrypt throws and no API key can ever be saved again (bug H3).
 */
const NEVER_EXPORT_SETTING_KEYS = new Set([
  '__crypto_master',
  // The in-flight restore marker describes THIS device's restore, not the data.
  // Exporting it would make every later restore of that file look interrupted.
  'restoreInProgress',
  // Driver/migration state is a fact about THIS device's storage engine, not
  // about the data; carrying it would make a restored web install think it
  // had migrated to SQLite.
  'sqliteMigratedAt',
  'sqliteMigrateProgress',
]);

function isPortableSettingRow(row: unknown): boolean {
  const r = row as { key?: unknown; value?: unknown } | null;
  const k = r?.key;
  if (typeof k === 'string' && NEVER_EXPORT_SETTING_KEYS.has(k)) return false;
  // Belt to the keys' braces: ANY row holding a live CryptoKey is device-local
  // by nature — it cannot serialize, so it must not pretend to travel.
  if (typeof CryptoKey !== 'undefined' && r?.value instanceof CryptoKey) return false;
  return true;
}

/**
 * Append-only stores that travel by watermark in an incremental package.
 * `messages` cursor is the autoincrement id (rowid 序==时间序); the others use
 * their epoch-ms createdAt. Every OTHER exported store is snapshotted whole in
 * every package — they are small and they mutate in place, which a watermark
 * cannot see.
 */
export const WATERMARK_FIELDS: Record<string, 'id' | 'createdAt'> = {
  messages: 'id',
  moments: 'createdAt',
  moment_likes: 'createdAt',
  moment_comments: 'createdAt',
  wallet_tx: 'createdAt',
  media: 'createdAt',
};

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
  /** Stores deliberately left out, and why — surfaced in the restore UI. */
  omitted: Record<string, string>;
  appVersion?: string;
}

export interface BackupFile {
  manifest: BackupManifest;
  stores: Record<string, unknown[]>;
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
 * The rows of one watermark store that belong in an incremental package cut
 * against `since`. Pure; exported for tests.
 */
export function incrementalRows(store: string, rows: unknown[], since: number): unknown[] {
  const field = WATERMARK_FIELDS[store];
  if (!field) return rows;
  return rows.filter((r) => {
    const rec = r as Record<string, unknown>;
    const v = Number(rec[field] ?? 0);
    if (v > since) return true;
    // Recalls edit rows BELOW the watermark; carry them so the edit survives.
    return store === 'messages' && rec.isRecalled === true;
  });
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

/**
 * Read every exportable store into a single envelope.
 *
 * @param now injected timestamp so exports are reproducible in tests
 * @param opts includeMedia=false drops the媒体库 (biggest store by bytes) for a
 *             lean file; mode='incremental' cuts watermark stores against
 *             `since` (the previous backup's watermarks)
 */
export async function exportBackup(
  now: number,
  appVersion?: string,
  opts: { includeMedia?: boolean; mode?: BackupMode; since?: Record<string, number> } = {},
): Promise<BackupFile> {
  const includeMedia = opts.includeMedia ?? true;
  const mode = opts.mode ?? 'full';
  const since = opts.since ?? {};
  const stores: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  const fullSets: Record<string, unknown[]> = {};

  for (const def of STORES) {
    if (NEVER_EXPORT.has(def.name)) continue;
    if (def.name === 'media' && !includeMedia) continue;
    const allRows = sanitize(def.name, await readStoreRows(def.name));
    fullSets[def.name] = allRows;
    let rows =
      mode === 'incremental' && def.name in WATERMARK_FIELDS
        ? incrementalRows(def.name, allRows, since[def.name] ?? 0)
        : allRows;
    if (def.name === 'media') rows = await encodeMediaRows(rows);
    stores[def.name] = rows;
    counts[def.name] = rows.length;
  }

  const db = await openDB();
  return {
    manifest: {
      version: BACKUP_VERSION,
      schemaVersion: db.version,
      createdAt: now,
      mode,
      watermarks: computeWatermarks(fullSets, since),
      ...(mode === 'incremental' ? { since } : {}),
      counts,
      omitted: {
        tts_cache: '语音缓存可按原文重新合成，不占备份体积',
        'providers.apiKey': 'API key 只存在设备安全存储，永不导出',
        'settings.__crypto_master': '本机加密主密钥不可迁移，恢复时保留本机的',
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
  };
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

  // THIS device's crypto master key survives every restore: the incoming file
  // never legitimately carries one (export strips it; old files carry a broken
  // `{}` husk), and clearing it would orphan every locally-encrypted API key.
  // Read from IndexedDB directly — the key's home is IDB on every driver.
  const localMaster = await idbGetAll('settings').then((rows) =>
    rows.filter((r) => !isPortableSettingRow(r)),
  );

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
  await writeStoreRow('settings', { key: 'restoreInProgress', value: now });
  try {
    for (const { store, rows } of staged) {
      await clearStore(store);
      // The marker lives in `settings`, so clearing that store erases it. Put it
      // straight back or the crash window it exists to cover is uncovered.
      if (store === 'settings') {
        await writeStoreRow('settings', { key: 'restoreInProgress', value: now });
      }
      for (const row of rows) await writeStoreRow(store, row);
      restored[store] = rows.length;
    }
    // Straight back into IndexedDB, never the dispatcher: a CryptoKey cannot
    // survive a TEXT column, and IDB is where the keystore reads it.
    for (const row of localMaster) await idbPut('settings', row);
  } catch (e) {
    // Roll back from the snapshot we took before touching anything. Best effort
    // by necessity — IndexedDB gives us no cross-store transaction — but it is
    // the difference between "restore failed" and "everything is gone".
    await rollback(snapshot, localMaster).catch(() => {});
    throw new Error(
      `恢复失败，已尽力回滚到恢复前的状态：${e instanceof Error ? e.message : String(e)}`,
    );
  }
  await writeStoreRow('settings', { key: 'restoreInProgress', value: 0 });

  // The restored file may be days old; without re-arming the barrier the next
  // foreground pass would "backfill" that whole gap with fabricated activity.
  await writeStoreRow('settings', { key: 'lastForegroundAt', value: now });

  return { restored, unknownStores, snapshot };
}

/**
 * Layer one incremental package on top of the current contents.
 *
 * Watermark stores UPSERT (rows keep their original keys, so a message lands
 * back under its own id — rowid 序==时间序 holds because increments are applied
 * oldest→newest and their rows are newer than everything already present).
 * Snapshot stores REPLACE, same as a full restore — they were exported whole.
 */
export async function applyIncrementalBackup(
  file: BackupFile,
  now: number,
): Promise<Record<string, number>> {
  if (backupMode(file) !== 'incremental') {
    throw new Error('这不是增量备份文件');
  }
  const applied: Record<string, number> = {};

  const localMaster = await idbGetAll('settings').then((rows) =>
    rows.filter((r) => !isPortableSettingRow(r)),
  );

  // Stage first (decode is the risky part), touch nothing until it all parsed.
  const staged: Array<{ store: string; rows: unknown[]; upsert: boolean }> = [];
  for (const def of STORES) {
    let rows = file.stores[def.name];
    if (!rows) continue;
    if (def.name === 'settings') rows = rows.filter(isPortableSettingRow);
    if (def.name === 'media') rows = rows.map(decodeMediaRow);
    staged.push({ store: def.name, rows, upsert: def.name in WATERMARK_FIELDS });
  }

  for (const { store, rows, upsert } of staged) {
    if (!upsert) {
      await clearStore(store);
    }
    for (const row of rows) await writeStoreRow(store, row);
    applied[store] = rows.length;
  }
  for (const row of localMaster) await idbPut('settings', row);
  await writeStoreRow('settings', { key: 'lastForegroundAt', value: now });
  return applied;
}

/** Put the pre-restore snapshot back. Used only on a failed restore. */
async function rollback(snapshot: BackupFile, localMaster: unknown[]): Promise<void> {
  for (const def of STORES) {
    let rows = snapshot.stores[def.name];
    if (!rows) continue;
    if (def.name === 'media') rows = rows.map(decodeMediaRow);
    await clearStore(def.name);
    for (const row of rows) await writeStoreRow(def.name, row);
  }

  for (const row of localMaster) await idbPut('settings', row);
  await writeStoreRow('settings', { key: 'restoreInProgress', value: 0 });
}

/**
 * Did a previous restore die partway through? Returns the timestamp it started,
 * or 0. The restore page surfaces this so a half-written database is announced
 * rather than silently lived with.
 */
export async function pendingRestoreAt(): Promise<number> {
  const rows = (await readStoreRows('settings')) as Array<{ key?: string; value?: unknown }>;
  const row = rows.find((r) => r.key === 'restoreInProgress');
  return typeof row?.value === 'number' ? row.value : 0;
}

/** Suggested filename, e.g. `weixin-ai-20260808-1430.aiwx` (`-inc` when 增量). */
export function backupFilename(now: number, mode: BackupMode = 'full'): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
  return `weixin-ai-${stamp}${mode === 'incremental' ? '-inc' : ''}${BACKUP_EXT}`;
}
