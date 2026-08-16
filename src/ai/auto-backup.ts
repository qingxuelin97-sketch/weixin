/**
 * Periodic automatic backups (M-I17), riding the ONE time-evolution path:
 * an `auto_backup` row in scheduled_actions, self-chaining like heartbeats —
 * the chain step queues the next period BEFORE the export that can fail, so a
 * single bad night never ends the habit (scheduler.ts's registerChainedHandler
 * rationale, applied to durability).
 *
 * Cadence policy: every `FULL_EVERY`-th run is a full snapshot; the runs
 * between are incremental packages cut against the stored per-store
 * watermarks. A new full supersedes the auto entries before it, so the shelf
 * stays 一个全量 + 几个增量 rather than growing forever.
 *
 * 铁律 4: no Date.now()/Math.random() in here — every function takes `now`,
 * and ids derive from the period index, which also makes them STABLE: the
 * `actionExists` guard can therefore stop a completed period from being
 * revived by a later upsert (the enqueue-by-id trap in CLAUDE.md).
 */
import {
  enqueue,
  actionExists,
  hasPendingOfKind,
  cancelPendingWhere,
} from './scheduler';
import { repo } from '../db/repo';
import {
  exportBackupWithState,
  serializeBackup,
  backupFilename,
  loadBackupState,
  saveBackupState,
  type BackupMode,
} from '../lib/backup';
import {
  recordBackup,
  pruneSupersededAutoBackups,
  type BackupHistoryEntry,
} from '../lib/backup-history';
import { AUTO_BACKUP_COUNTER_KEY, BACKUP_WATERMARKS_KEY } from '../lib/device-local';

export type AutoBackupFreq = 'off' | 'daily' | 'weekly';

/** The frequency is a user PREFERENCE, so it travels in the backup. */
export const AUTO_BACKUP_FREQ_KEY = 'autoBackupFreq';
/** The counter and the watermarks are device-local bookkeeping; they do not. */
export { AUTO_BACKUP_COUNTER_KEY, BACKUP_WATERMARKS_KEY };

/** Every N-th auto run is a full snapshot; the rest are increments on it. */
export const FULL_EVERY = 7;

export function periodMs(freq: Exclude<AutoBackupFreq, 'off'>): number {
  return freq === 'daily' ? 86_400_000 : 7 * 86_400_000;
}

/** Deterministic per-period id — one backup per period, ever (upsert-safe). */
export function autoBackupActionId(freq: Exclude<AutoBackupFreq, 'off'>, fireAt: number): string {
  return `auto_backup_${freq}_${Math.floor(fireAt / periodMs(freq))}`;
}

/** When the next auto backup should fire. Pure. */
export function nextAutoBackupAt(freq: Exclude<AutoBackupFreq, 'off'>, now: number): number {
  return now + periodMs(freq);
}

export async function getAutoBackupFreq(): Promise<AutoBackupFreq> {
  return (await repo.getSetting<AutoBackupFreq>(AUTO_BACKUP_FREQ_KEY)) ?? 'off';
}

/**
 * User changed the frequency on the settings page: persist it, drop the old
 * chain, start a new one (or none).
 */
export async function setAutoBackupFreq(freq: AutoBackupFreq, now: number): Promise<void> {
  await repo.putSetting(AUTO_BACKUP_FREQ_KEY, freq);
  await cancelPendingWhere((_p, a) => a.kind === 'auto_backup');
  if (freq !== 'off') await scheduleNext(freq, now);
}

async function scheduleNext(freq: Exclude<AutoBackupFreq, 'off'>, now: number): Promise<void> {
  const fireAt = nextAutoBackupAt(freq, now);
  const id = autoBackupActionId(freq, fireAt);
  // A done row with this id means this period already backed up — enqueue
  // upserts by id and would revive it as pending (the nudge trap).
  if (await actionExists(id)) return;
  await enqueue({ kind: 'auto_backup', fireAt, payload: { freq, at: fireAt }, now, id });
}

/**
 * Foreground-pass seeding: make sure a chain exists when the setting says one
 * should (first enable happens on the settings page, but a restore or a
 * cancelled row must not silently kill the habit). Idempotent.
 */
export async function ensureAutoBackupScheduled(now: number): Promise<void> {
  const freq = await getAutoBackupFreq();
  if (freq === 'off') return;
  if (await hasPendingOfKind('auto_backup')) return;
  await scheduleNext(freq, now);
}

/** The CHAIN step — queue the successor before the work that can fail. */
export async function chainAutoBackup(now: number): Promise<void> {
  const freq = await getAutoBackupFreq();
  if (freq === 'off') return; // user turned it off after this row was queued
  await scheduleNext(freq, now);
}

/**
 * The WORK step — produce one backup onto the history shelf.
 * Exported result is what the tests assert against; UI never sees content.
 */
export async function runAutoBackup(now: number): Promise<BackupHistoryEntry | null> {
  const freq = await getAutoBackupFreq();
  if (freq === 'off') return null; // stale row that outlived the setting

  const counter = (await repo.getSetting<number>(AUTO_BACKUP_COUNTER_KEY)) ?? 0;
  const { watermarks: since, digest: sinceDigest } = await loadBackupState();
  // The first run — or any run with no base — must be full: an increment with
  // nothing under it restores to nothing. Both halves of the base are required:
  // a watermark without its digest cannot see in-place edits or deletions, and
  // producing such an increment is precisely the I18 data-loss bug.
  const mode: BackupMode =
    counter % FULL_EVERY === 0 || !since || !sinceDigest ? 'full' : 'incremental';

  const { file, watermarks, digest } = await exportBackupWithState(now, undefined, {
    mode,
    ...(mode === 'incremental' ? { since, sinceDigest } : {}),
  });
  const json = serializeBackup(file);
  const entry: BackupHistoryEntry = {
    id: `ab_${now}`,
    name: `auto-${backupFilename(now, mode)}`,
    createdAt: now,
    bytes: json.length,
    mode,
    source: 'auto',
    counts: file.manifest.counts,
  };
  await recordBackup(entry, json);

  // Bookkeeping only AFTER the file landed — a failed write must not advance
  // the base, or the rows it covered would never be backed up again. The
  // watermarks and the digest move together or not at all.
  await saveBackupState({ watermarks, digest });
  await repo.putSetting(AUTO_BACKUP_COUNTER_KEY, counter + 1);
  await repo.putSetting('lastBackupAt', now);

  if (mode === 'full') await pruneSupersededAutoBackups(now);
  return entry;
}
