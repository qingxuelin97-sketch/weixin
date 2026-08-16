/**
 * Backup history (M-I17): the app-managed shelf of .aiwx files.
 *
 * METADATA lives in the settings KV (`backupHistory`, one JSON array — no new
 * IndexedDB store, deliberately: I17 must not touch DB_VERSION). CONTENT lives
 * as real files under `backups/` via @capacitor/filesystem — on Android that
 * is the app's data dir; on the web the plugin's IndexedDB-backed virtual disk
 * (a separate database, not ours). The split matters: the history list renders
 * from metadata alone, without ever loading megabytes of JSON.
 *
 * Privacy note (CLAUDE.md hidden-conversation rule): entries carry only
 * aggregate counts and sizes — never message content, never conversation
 * titles — so the history page cannot leak a hidden AI↔AI DM no matter what
 * the UI does with an entry.
 *
 * Retention: when a new FULL auto-backup lands, every OLDER auto entry (that
 * full's predecessors and their increments) is superseded and deleted. Manual
 * exports are never auto-deleted.
 */
import { Capacitor } from '@capacitor/core';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { repo } from '../db/repo';
import { saveTextFile } from './save-file';
import type { BackupMode } from './backup';
import { BACKUP_HISTORY_KEY } from './device-local';

/**
 * Re-exported from the device-local list, which owns the name: the shelf's
 * metadata points at files under THIS device's `backups/`, so a backup that
 * carried it would, on restore, list files that do not exist and drop the very
 * entry the restore came from (I18-3).
 */
export { BACKUP_HISTORY_KEY };
const DIR = Directory.Data;

export interface BackupHistoryEntry {
  id: string;
  /** Filename, also the path under backups/. */
  name: string;
  createdAt: number;
  bytes: number;
  mode: BackupMode;
  source: 'auto' | 'manual';
  /** Aggregate row counts only — never content (hidden-conv rule). */
  counts?: Record<string, number>;
}

function pathOf(entry: Pick<BackupHistoryEntry, 'name'>): string {
  return `backups/${entry.name}`;
}

export async function listBackupHistory(): Promise<BackupHistoryEntry[]> {
  const list = (await repo.getSetting<BackupHistoryEntry[]>(BACKUP_HISTORY_KEY)) ?? [];
  return [...list].sort((a, b) => b.createdAt - a.createdAt);
}

async function writeHistory(list: BackupHistoryEntry[]): Promise<void> {
  await repo.putSetting(BACKUP_HISTORY_KEY, list);
}

/**
 * Persist a produced backup: file first, metadata second — an entry must never
 * point at a file that failed to write.
 */
export async function recordBackup(
  entry: BackupHistoryEntry,
  content: string,
): Promise<void> {
  await Filesystem.writeFile({
    path: pathOf(entry),
    data: content,
    directory: DIR,
    encoding: Encoding.UTF8,
    recursive: true,
  });
  const list = (await repo.getSetting<BackupHistoryEntry[]>(BACKUP_HISTORY_KEY)) ?? [];
  await writeHistory([...list.filter((e) => e.id !== entry.id), entry]);
}

/** Read one entry's content back (for share / restore). */
export async function readBackupContent(entry: BackupHistoryEntry): Promise<string> {
  const res = await Filesystem.readFile({
    path: pathOf(entry),
    directory: DIR,
    encoding: Encoding.UTF8,
  });
  if (typeof res.data !== 'string') throw new Error('备份文件读取失败');
  return res.data;
}

/** Delete the file and its metadata. Missing files are not an error. */
export async function deleteBackupEntry(id: string): Promise<void> {
  const list = (await repo.getSetting<BackupHistoryEntry[]>(BACKUP_HISTORY_KEY)) ?? [];
  const entry = list.find((e) => e.id === id);
  if (entry) {
    await Filesystem.deleteFile({ path: pathOf(entry), directory: DIR }).catch(() => {});
  }
  await writeHistory(list.filter((e) => e.id !== id));
}

/** Hand an entry's file to the user (share sheet on native, download on web). */
export async function shareBackupEntry(entry: BackupHistoryEntry): Promise<void> {
  const content = await readBackupContent(entry);
  await saveTextFile(entry.name, content, 'application/json', '分享备份文件');
}

/**
 * Retire auto entries superseded by a new full auto backup: everything AUTO
 * and OLDER than `fullCreatedAt` is covered by the new full and goes away.
 */
export async function pruneSupersededAutoBackups(fullCreatedAt: number): Promise<number> {
  const list = (await repo.getSetting<BackupHistoryEntry[]>(BACKUP_HISTORY_KEY)) ?? [];
  const dead = list.filter((e) => e.source === 'auto' && e.createdAt < fullCreatedAt);
  for (const e of dead) {
    await Filesystem.deleteFile({ path: pathOf(e), directory: DIR }).catch(() => {});
  }
  if (dead.length > 0) {
    const deadIds = new Set(dead.map((e) => e.id));
    await writeHistory(list.filter((e) => !deadIds.has(e.id)));
  }
  return dead.length;
}

/**
 * The apply-order for restoring TO a target entry: the newest full at or
 * before it, then every incremental between that full and the target
 * (inclusive), oldest→newest. Pure over the entry list; exported for tests.
 * Returns null when no covering full exists (an orphan increment).
 */
export function resolveRestoreChain(
  entries: BackupHistoryEntry[],
  targetId: string,
): BackupHistoryEntry[] | null {
  const target = entries.find((e) => e.id === targetId);
  if (!target) return null;
  if (target.mode === 'full') return [target];
  const base = entries
    .filter((e) => e.mode === 'full' && e.createdAt <= target.createdAt)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (!base) return null;
  const increments = entries
    .filter(
      (e) =>
        e.mode === 'incremental' &&
        e.createdAt > base.createdAt &&
        e.createdAt <= target.createdAt,
    )
    .sort((a, b) => a.createdAt - b.createdAt);
  return [base, ...increments];
}

/** True when this platform can keep files for the history shelf at all. */
export function backupHistorySupported(): boolean {
  // The Filesystem plugin works on web too (virtual disk); this exists so a
  // future platform gap fails soft in ONE place.
  return typeof Capacitor !== 'undefined';
}
