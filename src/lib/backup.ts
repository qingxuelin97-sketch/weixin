/**
 * Backup and restore (.aiwx).
 *
 * There is no server: if this device is lost, the conversations are gone. That
 * makes export the only durability story the app has, so it errs toward
 * completeness — every store, one JSON envelope, no silent omissions.
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
import { STORES, idbGetAll, idbPut, idbClear, openDB } from '../db/idb';

export const BACKUP_VERSION = 1;
export const BACKUP_EXT = '.aiwx';

/** Stores excluded from every export. See the module comment for why. */
const NEVER_EXPORT = new Set(['tts_cache']);

export interface BackupManifest {
  version: number;
  /** IndexedDB schema version the export came from. */
  schemaVersion: number;
  createdAt: number;
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

/** Strip anything that must not leave the device. */
function sanitize(store: string, rows: unknown[]): unknown[] {
  if (store !== 'providers') return rows;
  // Keep the slot configuration, drop anything key-shaped. `keyAlias` is only a
  // handle into the keystore, so it is safe and necessary to keep.
  return rows.map((r) => {
    const { apiKey: _k, key: _k2, secret: _s, ...rest } = r as Record<string, unknown>;
    return rest;
  });
}

/**
 * Read every exportable store into a single envelope.
 *
 * @param now injected timestamp so exports are reproducible in tests
 */
export async function exportBackup(now: number, appVersion?: string): Promise<BackupFile> {
  const stores: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};

  for (const def of STORES) {
    if (NEVER_EXPORT.has(def.name)) continue;
    const rows = sanitize(def.name, await idbGetAll(def.name));
    stores[def.name] = rows;
    counts[def.name] = rows.length;
  }

  const db = await openDB();
  return {
    manifest: {
      version: BACKUP_VERSION,
      schemaVersion: db.version,
      createdAt: now,
      counts,
      omitted: {
        tts_cache: '语音缓存可按原文重新合成，不占备份体积',
        'providers.apiKey': 'API key 只存在设备安全存储，永不导出',
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
 * Replace the database contents with the backup.
 *
 * Snapshots current state first — a restore is destructive and the user may
 * have picked the wrong file.
 */
export async function restoreBackup(file: BackupFile, now: number): Promise<RestoreResult> {
  const snapshot = await exportBackup(now);
  const known = new Set(STORES.map((s) => s.name));
  const unknownStores = Object.keys(file.stores).filter((n) => !known.has(n));
  const restored: Record<string, number> = {};

  for (const def of STORES) {
    const rows = file.stores[def.name];
    if (!rows) continue; // absent from this backup — leave the store untouched
    await idbClear(def.name);
    for (const row of rows) await idbPut(def.name, row);
    restored[def.name] = rows.length;
  }

  return { restored, unknownStores, snapshot };
}

/** Suggested filename, e.g. `weixin-ai-20260808-1430.aiwx`. */
export function backupFilename(now: number): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, '0');
  return `weixin-ai-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${BACKUP_EXT}`;
}
