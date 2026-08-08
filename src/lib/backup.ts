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

/**
 * Individual settings rows that must never travel in a backup. The WebCrypto
 * master key is non-extractable and DEVICE-LOCAL: JSON.stringify turns it into
 * `{}`, and restoring that husk over a working key bricks the keystore — every
 * later encrypt throws and no API key can ever be saved again (bug H3).
 */
const NEVER_EXPORT_SETTING_KEYS = new Set(['__crypto_master']);

function isPortableSettingRow(row: unknown): boolean {
  const k = (row as { key?: unknown })?.key;
  return typeof k !== 'string' || !NEVER_EXPORT_SETTING_KEYS.has(k);
}

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
 * Read every exportable store into a single envelope.
 *
 * @param now injected timestamp so exports are reproducible in tests
 * @param opts includeMedia=false drops the媒体库 (biggest store by bytes) for a lean file
 */
export async function exportBackup(
  now: number,
  appVersion?: string,
  opts: { includeMedia?: boolean } = {},
): Promise<BackupFile> {
  const includeMedia = opts.includeMedia ?? true;
  const stores: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};

  for (const def of STORES) {
    if (NEVER_EXPORT.has(def.name)) continue;
    if (def.name === 'media' && !includeMedia) continue;
    let rows = sanitize(def.name, await idbGetAll(def.name));
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

  // THIS device's crypto master key survives every restore: the incoming file
  // never legitimately carries one (export strips it; old files carry a broken
  // `{}` husk), and clearing it would orphan every locally-encrypted API key.
  const localMaster = await idbGetAll('settings').then((rows) =>
    rows.filter((r) => !isPortableSettingRow(r)),
  );

  for (const def of STORES) {
    let rows = file.stores[def.name];
    if (!rows) continue; // absent from this backup — leave the store untouched
    if (def.name === 'settings') rows = rows.filter(isPortableSettingRow);
    if (def.name === 'media') rows = rows.map(decodeMediaRow);
    await idbClear(def.name);
    for (const row of rows) await idbPut(def.name, row);
    restored[def.name] = rows.length;
  }
  for (const row of localMaster) await idbPut('settings', row);

  // The restored file may be days old; without re-arming the barrier the next
  // foreground pass would "backfill" that whole gap with fabricated activity.
  await idbPut('settings', { key: 'lastForegroundAt', value: now });

  return { restored, unknownStores, snapshot };
}

/** Suggested filename, e.g. `weixin-ai-20260808-1430.aiwx`. */
export function backupFilename(now: number): string {
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, '0');
  return `weixin-ai-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${BACKUP_EXT}`;
}
