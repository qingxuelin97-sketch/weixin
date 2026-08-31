/**
 * 设备本地行清单 — the ONE list of `settings` rows that describe THIS PHONE
 * rather than the user's data, and therefore must never travel in a backup.
 *
 * Three separate bugs came from judging this case-by-case at the call site:
 *
 *   H3   the WebCrypto master key exported as the husk `{}`, and a restore
 *        wrote that husk over a working key — the keystore was bricked for
 *        good, every later encrypt threw, no API key could ever be saved again.
 *   I18-3 the backup shelf's own metadata (`backupHistory` / `backupWatermarks`
 *        / `autoBackupCounter`) rode along inside the backup, so restoring
 *        rewound the shelf to a state that listed deleted files and had lost
 *        the very entry the restore came from.
 *   I18-6 `notifyAsked` / `notifyGranted` are a fact about a PERMISSION the OS
 *        granted this install. Restored onto a new phone (where the real
 *        POST_NOTIFICATIONS answer is "denied") the first-run prompt is
 *        skipped, the settings page reads 「已开启」, and notifications are
 *        silently dead forever.
 *
 * All three are the same mistake, so they get one answer: a row named here is
 * FILTERED OUT of every export (full and incremental) and PRESERVED FROM THIS
 * DEVICE across every restore. tests/unit/i18-backup.test.ts guards the list
 * against the real constants, so a key renamed at its home module cannot
 * silently drop off it.
 *
 * This module imports nothing on purpose: it sits below db/, lib/ and ai/ so
 * any of them can name it without a cycle.
 */

/**
 * Where a row's authoritative copy lives, which decides how it is written back
 * after the destructive phase of a restore.
 *
 *  'idb'  — read directly from IndexedDB by code that runs BEFORE the storage
 *           driver is chosen (or that cannot use a TEXT column at all). These
 *           are put back with `idbPut`, never through the driver.
 *  'live' — read through the Repo, so they belong wherever the active driver
 *           keeps `settings` (SQLite after the native migration, IDB
 *           otherwise). These go back through `writeStoreRow`.
 */
export type SettingHome = 'idb' | 'live';

export interface DeviceLocalSetting {
  readonly key: string;
  readonly home: SettingHome;
  /** Why it is device-local — the reason a future reader will need. */
  readonly why: string;
}

/** WebCrypto master key. Non-extractable, unserializable, IDB-only. */
export const CRYPTO_MASTER_KEY = '__crypto_master';
/** Set while a restore is mid-write; non-zero at launch ⇒ it never finished. */
export const RESTORE_IN_PROGRESS_KEY = 'restoreInProgress';
/** The app-managed backup shelf (metadata for files under `backups/`). */
export const BACKUP_HISTORY_KEY = 'backupHistory';
/** Per-store high-water marks of the last package this device produced. */
export const BACKUP_WATERMARKS_KEY = 'backupWatermarks';
/** Per-row content hashes of the last package (in-place edits + deletions). */
export const BACKUP_DIGEST_KEY = 'backupRowDigest';
/** How many auto backups have run — decides full-vs-incremental cadence. */
export const AUTO_BACKUP_COUNTER_KEY = 'autoBackupCounter';
/** When this device last exported; drives the 「该备份了」 nudge. */
export const LAST_BACKUP_AT_KEY = 'lastBackupAt';
/** Storage-engine migration flag/progress — a fact about this install. */
export const SQLITE_MIGRATED_AT_KEY = 'sqliteMigratedAt';
export const SQLITE_MIGRATE_PROGRESS_KEY = 'sqliteMigrateProgress';
/** Notification permission facts, owned by the OS, not by the user's data. */
export const NOTIFY_ASKED_KEY = 'notifyAsked';
export const NOTIFY_GRANTED_KEY = 'notifyGranted';

export const DEVICE_LOCAL_SETTINGS: readonly DeviceLocalSetting[] = [
  {
    key: CRYPTO_MASTER_KEY,
    home: 'idb',
    why: '本机加密主密钥不可迁移（JSON 化会变空壳并永久损坏 keystore）',
  },
  {
    key: RESTORE_IN_PROGRESS_KEY,
    home: 'live',
    why: '描述本机正在进行的恢复；导出它会让这个文件的每次恢复都显示"中断过"',
  },
  {
    key: BACKUP_HISTORY_KEY,
    home: 'live',
    why: '备份货架指向本机 backups/ 下的真实文件；恢复旧列表会列出已删除的文件',
  },
  {
    key: BACKUP_WATERMARKS_KEY,
    home: 'live',
    why: '本机上一个备份包的水位；跟着数据走会让增量挂在错误的基准上',
  },
  {
    key: BACKUP_DIGEST_KEY,
    home: 'live',
    why: '本机上一个备份包的逐行内容哈希，同上（且体积大，不该进包）',
  },
  {
    key: AUTO_BACKUP_COUNTER_KEY,
    home: 'live',
    why: '本机自动备份计数，决定全量/增量节奏',
  },
  {
    key: LAST_BACKUP_AT_KEY,
    home: 'live',
    why: '本机最近一次导出时间；恢复来的旧值会错误地压住"该备份了"提醒',
  },
  {
    key: SQLITE_MIGRATED_AT_KEY,
    home: 'idb',
    why: '本机存储引擎迁移标志；恢复到 Web 端会让它以为自己在用 SQLite',
  },
  {
    key: SQLITE_MIGRATE_PROGRESS_KEY,
    home: 'idb',
    why: '本机迁移续跑进度，同上',
  },
  {
    key: NOTIFY_ASKED_KEY,
    home: 'live',
    why: '系统权限事实：换机后新机其实没问过，恢复来的 true 会永久跳过首启动询问',
  },
  {
    key: NOTIFY_GRANTED_KEY,
    home: 'live',
    why: '系统权限事实：新机可能是拒绝的，恢复来的 true 会让通知静默失效',
  },
];

const BY_KEY = new Map(DEVICE_LOCAL_SETTINGS.map((s) => [s.key, s]));

export const DEVICE_LOCAL_SETTING_KEYS: ReadonlySet<string> = new Set(BY_KEY.keys());

export function deviceLocalHome(key: string): SettingHome | undefined {
  return BY_KEY.get(key)?.home;
}

/** True when a live CryptoKey sits in this row's value — never serializable. */
export function holdsCryptoKey(row: unknown): boolean {
  if (typeof CryptoKey === 'undefined') return false;
  return (row as { value?: unknown } | null)?.value instanceof CryptoKey;
}

/**
 * Device-local by name OR by nature. The `instanceof` half is the belt to the
 * name list's braces: ANY row holding a live CryptoKey cannot serialize, so it
 * must not pretend to travel even under an unknown key — and a husk `{}` is
 * truthy, which is exactly why this is a type check and not a truthiness one.
 */
export function isDeviceLocalSettingRow(row: unknown): boolean {
  const key = (row as { key?: unknown } | null)?.key;
  if (typeof key === 'string' && DEVICE_LOCAL_SETTING_KEYS.has(key)) return true;
  return holdsCryptoKey(row);
}

/** The complement: rows a backup may carry. */
export function isPortableSettingRow(row: unknown): boolean {
  return !isDeviceLocalSettingRow(row);
}
