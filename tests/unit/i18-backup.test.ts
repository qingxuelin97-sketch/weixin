import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDB, idbPut, idbAdd, idbGet, idbGetAll, idbClear, STORES, _closeDbForTests } from '../../src/db/idb';
import {
  exportBackup,
  exportBackupWithState,
  restoreBackup,
  applyIncrementalBackup,
  commitBackupState,
  loadBackupState,
  saveBackupState,
  pendingRestoreAt,
  acknowledgePendingRestore,
  incrementalRows,
  deletedRowKeys,
  computeRowDigest,
  rowHash,
  parseBackup,
  serializeBackup,
  type BackupFile,
  type RowDigest,
} from '../../src/lib/backup';
import {
  DEVICE_LOCAL_SETTINGS,
  DEVICE_LOCAL_SETTING_KEYS,
  isPortableSettingRow,
  BACKUP_HISTORY_KEY,
  BACKUP_WATERMARKS_KEY,
  BACKUP_DIGEST_KEY,
  AUTO_BACKUP_COUNTER_KEY,
  RESTORE_IN_PROGRESS_KEY,
  NOTIFY_ASKED_KEY,
  NOTIFY_GRANTED_KEY,
} from '../../src/lib/device-local';
import { SQLITE_MIGRATED_AT_KEY } from '../../src/db/driver';
import { SQLITE_MIGRATE_PROGRESS_KEY } from '../../src/db/migrate-to-sqlite';
import { BACKUP_HISTORY_KEY as HISTORY_KEY_FROM_SHELF } from '../../src/lib/backup-history';
import {
  AUTO_BACKUP_COUNTER_KEY as COUNTER_KEY_FROM_AUTO,
  BACKUP_WATERMARKS_KEY as WATERMARKS_KEY_FROM_AUTO,
} from '../../src/ai/auto-backup';

/**
 * M-I18 加固：备份/恢复正确性 (转红).
 *
 * Every case here is one audit finding whose consequence is USER DATA WRONG
 * AFTER A RESTORE — the most expensive class this app has, because it is
 * discovered on the new phone, long after the old one is gone.
 *
 *   ① 就地改写      a 转账 accepted after the base full stayed 「待收款」 forever
 *   ② 删除          deleted messages / likes / moments came back to life
 *   ③ 货架自覆盖    restoring rewound the backup shelf onto itself
 *   ④ 中断可知      the restore-in-progress marker had zero readers
 *   ⑤ 增量有护栏    a truncated increment silently took contacts + settings
 *   ⑥ 权限事实      notifyAsked/notifyGranted travelled as if they were data
 *   ⑦ 水位不空转    a failed shelf write still advanced the base
 */

const T = (n: number) => 1_754_500_000_000 + n;
const root = resolve(__dirname, '../..');

const message = (convId: string, i: number, over: Record<string, unknown> = {}) => ({
  convId,
  senderId: i % 2 ? 'self' : 'ai_a',
  type: 'text',
  content: `m${i}`,
  status: 'sent',
  createdAt: T(i * 1000),
  ...over,
});

async function seedBase(): Promise<void> {
  await idbPut('contacts', { id: 'ai_a', type: 'ai', name: '阿', avatarColor: 'c', avatarText: 'A' });
  await idbPut('conversations', {
    id: 'c1', type: 'single', peerId: 'ai_a', title: '阿', avatarColor: 'c', avatarText: 'A',
    isPinned: false, isMuted: false, unreadCount: 0, mentionMe: false,
  });
  for (let i = 1; i <= 4; i++) await idbAdd('messages', message('c1', i));
  await idbPut('settings', { key: 'nsfwGlobalTier', value: 'off' });
}

/** Full → (mutate) → incremental, using the real device-side base bookkeeping. */
async function cutFull(now: number) {
  const { file, watermarks, digest } = await exportBackupWithState(now);
  await saveBackupState({ watermarks, digest });
  return file;
}

async function cutIncrement(now: number): Promise<BackupFile> {
  const { watermarks: since, digest: sinceDigest } = await loadBackupState();
  const { file, watermarks, digest } = await exportBackupWithState(now, undefined, {
    mode: 'incremental',
    since,
    sinceDigest,
  });
  await saveBackupState({ watermarks, digest });
  return file;
}

/** Wipe everything, then restore the chain the way the history page does. */
async function restoreChain(full: BackupFile, incs: BackupFile[], now: number): Promise<void> {
  for (const s of STORES) await idbClear(s.name);
  const { snapshot } = await restoreBackup(parseBackup(serializeBackup(full)), now);
  for (const inc of incs) {
    await applyIncrementalBackup(parseBackup(serializeBackup(inc)), now + 1, { snapshot });
  }
}

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  _closeDbForTests();
  await openDB();
});

describe('① 就地改写的老行必须进增量包', () => {
  it('a 转账 accepted AFTER the base full survives [full + 增量] restore', async () => {
    await seedBase();
    // 周一：AI 发来一笔转账。The bubble row and the transfers row are both
    // written now; the bubble carries the status the chat renders from.
    const transferMsgId = (await idbAdd('messages', {
      ...message('c1', 5),
      type: 'transfer',
      content: '转账',
      meta: { transferId: 'tr1', amountFen: 8800, status: 'pending' },
    })) as number;
    await idbPut('transfers', {
      id: 'tr1', convId: 'c1', fromId: 'ai_a', toId: 'self',
      amountFen: 8800, status: 'pending', createdAt: T(5000),
    });

    // 周一夜：全量。水位 = 这条消息的 id。
    const full = await cutFull(T(100_000));
    expect(full.manifest.watermarks?.messages).toBe(transferMsgId);

    // 周三：收款。三处同时变：transfers 行、账本、以及消息行的 meta（就地改写，
    // id 不变、createdAt 不变——水位法完全看不见它）。
    await idbPut('transfers', {
      id: 'tr1', convId: 'c1', fromId: 'ai_a', toId: 'self',
      amountFen: 8800, status: 'accepted', createdAt: T(5000), acceptedAt: T(200_000),
    });
    await idbPut('wallet_tx', {
      id: 'wt1', kind: 'transfer_in', amountFen: 8800, balanceAfterFen: 8800, createdAt: T(200_000),
    });
    const bubble = await idbGet<Record<string, unknown>>('messages', transferMsgId);
    await idbPut('messages', {
      ...bubble,
      meta: { transferId: 'tr1', amountFen: 8800, status: 'accepted' },
    });

    // 周三夜：增量。The edited row is BELOW the watermark and is not a recall,
    // so v2 dropped it entirely.
    const inc = await cutIncrement(T(300_000));
    const carried = inc.stores.messages as Array<{ id: number }>;
    expect(carried.map((m) => m.id)).toContain(transferMsgId);

    await restoreChain(full, [inc], T(400_000));

    const restoredBubble = await idbGet<{ meta?: { status?: string } }>('messages', transferMsgId);
    expect(restoredBubble?.meta?.status).toBe('accepted');
    // 铁律 3: the money is an integer 分, and the ledger agrees with the bubble.
    const tx = await idbGetAll<{ amountFen: number }>('wallet_tx');
    expect(tx.map((t) => t.amountFen)).toEqual([8800]);
    expect(Number.isInteger(tx[0].amountFen)).toBe(true);
    const tr = await idbGet<{ status: string }>('transfers', 'tr1');
    expect(tr?.status).toBe('accepted');
  });

  it('an unchanged row is NOT re-carried — the increment stays small', async () => {
    await seedBase();
    const full = await cutFull(T(100_000));
    await idbAdd('messages', message('c1', 9));
    const inc = await cutIncrement(T(200_000));
    // Only the new row, none of the four untouched ones.
    expect((inc.stores.messages as unknown[]).length).toBe(1);
    expect(full.manifest.counts.messages).toBe(4);
  });

  it('the content hash is what判断 changed, not a hand-listed field', () => {
    const row = { id: 1, meta: { status: 'pending' } };
    const edited = { id: 1, meta: { status: 'accepted' } };
    expect(rowHash('messages', row)).not.toBe(rowHash('messages', edited));
    const digest = computeRowDigest({ messages: [row] });
    expect(incrementalRows('messages', [edited], 99, digest.messages)).toEqual([edited]);
    expect(incrementalRows('messages', [row], 99, digest.messages)).toEqual([]);
  });

  it('media is hashed by metadata + size, never by re-reading its bytes', () => {
    const a = { id: 'm1', mime: 'image/jpeg', createdAt: 1, blob: new Blob(['aaaa']) };
    const b = { id: 'm1', mime: 'image/jpeg', createdAt: 1, blob: new Blob(['bbbb']) };
    // Same metadata and same size ⇒ same hash: media rows are write-once, and
    // hashing a 60MB library nightly would cost more than the backup itself.
    expect(rowHash('media', a)).toBe(rowHash('media', b));
    const c = { id: 'm1', mime: 'image/jpeg', createdAt: 1, blob: new Blob(['aaaaa']) };
    expect(rowHash('media', a)).not.toBe(rowHash('media', c));
  });

  it('the hash ignores property order — the two drivers disagree about it', () => {
    // SQLite rebuilds a message as `{...JSON.parse(data), id}`; IDB returns the
    // order it was stored in. A JSON.stringify hash would call every row on a
    // freshly migrated device "changed" and re-send the entire history.
    const idbShape = { id: 7, convId: 'c1', meta: { b: 2, a: 1 }, content: 'hi' };
    const sqliteShape = { convId: 'c1', content: 'hi', meta: { a: 1, b: 2 }, id: 7 };
    expect(rowHash('messages', idbShape)).toBe(rowHash('messages', sqliteShape));
    // …but a real difference still shows.
    expect(rowHash('messages', { ...idbShape, content: 'ho' })).not.toBe(
      rowHash('messages', sqliteShape),
    );
  });
});

describe('② 删除必须能被增量表达（墓碑）', () => {
  it('a deleted message, like and moment do NOT resurrect after [full + 增量]', async () => {
    await seedBase();
    await idbPut('moments', { id: 'p1', authorId: 'ai_a', text: '尴尬', imageRefs: [], isNsfw: false, createdAt: T(10) });
    await idbPut('moments', { id: 'p2', authorId: 'ai_a', text: '留着', imageRefs: [], isNsfw: false, createdAt: T(11) });
    await idbPut('moment_likes', { id: 'p2:self', momentId: 'p2', contactId: 'self', createdAt: T(12) });
    await idbPut('moment_comments', { id: 'cm1', momentId: 'p2', authorId: 'ai_a', text: '哈', createdAt: T(13) });
    const embarrassing = (await idbAdd('messages', message('c1', 7, { content: '发错了' }))) as number;

    const full = await cutFull(T(100_000));
    expect((full.stores.messages as unknown[]).length).toBe(5);

    // The user deletes: the message he regrets, the moment he regrets, his own
    // like (取消赞), and one comment.
    const db = await openDB();
    await new Promise<void>((res, rej) => {
      const t = db.transaction(['messages', 'moments', 'moment_likes', 'moment_comments'], 'readwrite');
      t.objectStore('messages').delete(embarrassing);
      t.objectStore('moments').delete('p1');
      t.objectStore('moment_likes').delete('p2:self');
      t.objectStore('moment_comments').delete('cm1');
      t.oncomplete = () => res();
      t.onerror = () => rej(t.error);
    });

    const inc = await cutIncrement(T(200_000));
    expect(inc.tombstones?.messages).toEqual([embarrassing]);
    expect(inc.tombstones?.moments).toEqual(['p1']);
    expect(inc.tombstones?.moment_likes).toEqual(['p2:self']);
    expect(inc.tombstones?.moment_comments).toEqual(['cm1']);
    expect(inc.manifest.deleted?.messages).toBe(1);

    await restoreChain(full, [inc], T(300_000));

    expect(await idbGet('messages', embarrassing)).toBeUndefined();
    expect(await idbGet('moments', 'p1')).toBeUndefined();
    expect(await idbGet('moment_likes', 'p2:self')).toBeUndefined();
    expect(await idbGet('moment_comments', 'cm1')).toBeUndefined();
    // …and everything else is exactly where it was.
    expect(await idbGet('moments', 'p2')).toBeDefined();
    const kept = await idbGetAll<{ id: number }>('messages');
    expect(kept.map((m) => m.id)).toEqual([1, 2, 3, 4]);
  });

  it('a tombstone deletes by the store\'s real key type (messages are numbers)', async () => {
    await seedBase();
    await cutFull(T(1));
    const db = await openDB();
    await new Promise<void>((res) => {
      const t = db.transaction('messages', 'readwrite');
      t.objectStore('messages').delete(2);
      t.oncomplete = () => res();
    });
    const inc = await cutIncrement(T(2));
    // Not the string "2" — deleting "2" from an autoincrement store is a no-op
    // and the tombstone would silently do nothing.
    expect(inc.tombstones?.messages).toEqual([2]);
    expect(typeof inc.tombstones!.messages[0]).toBe('number');
  });

  it('deleting never renumbers a surviving row (rowid 序 == 时间序 holds)', async () => {
    await seedBase();
    const full = await cutFull(T(1));
    const db = await openDB();
    await new Promise<void>((res) => {
      const t = db.transaction('messages', 'readwrite');
      t.objectStore('messages').delete(2);
      t.oncomplete = () => res();
    });
    const inc = await cutIncrement(T(2));
    await restoreChain(full, [inc], T(3));
    const rows = await idbGetAll<{ id: number; createdAt: number }>('messages');
    expect(rows.map((m) => m.id)).toEqual([1, 3, 4]);
    // ids ascend with time, with the hole where the deletion was.
    const byId = [...rows].sort((a, b) => a.id - b.id);
    expect(byId.map((m) => m.createdAt)).toEqual([...byId].sort((a, b) => a.createdAt - b.createdAt).map((m) => m.createdAt));
  });

  it('without a digest base (v2 chain) no tombstone is invented', () => {
    // A v2 increment cannot express deletion; guessing from a watermark would
    // delete every row that merely predates it.
    expect(deletedRowKeys('messages', [{ id: 3 }], undefined)).toEqual([]);
    expect(deletedRowKeys('messages', [{ id: 3 }], { '1': 1, '3': 9 })).toEqual([1]);
  });
});

describe('③ 备份货架元数据不得被自己覆盖', () => {
  it('the shelf never enters the package and never rewinds on restore', async () => {
    await seedBase();
    await idbPut('settings', {
      key: BACKUP_HISTORY_KEY,
      value: [{ id: 'old', name: 'old.aiwx', createdAt: T(1), bytes: 1, mode: 'full', source: 'auto' }],
    });
    await idbPut('settings', { key: AUTO_BACKUP_COUNTER_KEY, value: 3 });

    const full = await cutFull(T(100_000));
    // The shelf, the base and the counter are not in the file at all.
    const settingsRows = full.stores.settings as Array<{ key: string }>;
    const keys = settingsRows.map((r) => r.key);
    expect(keys).not.toContain(BACKUP_HISTORY_KEY);
    expect(keys).not.toContain(BACKUP_WATERMARKS_KEY);
    expect(keys).not.toContain(BACKUP_DIGEST_KEY);
    expect(keys).not.toContain(AUTO_BACKUP_COUNTER_KEY);
    expect(JSON.stringify(full.stores)).not.toContain(BACKUP_HISTORY_KEY);

    // Time passes on the shelf: the old entry is deleted, a NEW one lands —
    // including the very entry this restore is about to be launched from.
    await idbPut('settings', {
      key: BACKUP_HISTORY_KEY,
      value: [
        { id: 'newest', name: 'newest.aiwx', createdAt: T(500_000), bytes: 9, mode: 'full', source: 'manual' },
      ],
    });

    await restoreBackup(parseBackup(serializeBackup(full)), T(600_000));

    const shelf = await idbGet<{ value: Array<{ id: string }> }>('settings', BACKUP_HISTORY_KEY);
    // Not rewound to the deleted entry, and the entry just used is still there.
    expect(shelf?.value.map((e) => e.id)).toEqual(['newest']);
  });

  it('a restore forgets the base so the next auto backup is a FULL', async () => {
    await seedBase();
    const full = await cutFull(T(100_000));
    expect((await loadBackupState()).digest).toBeDefined();
    await restoreBackup(parseBackup(serializeBackup(full)), T(200_000));
    // Chaining an increment onto a base that no longer describes this device is
    // how a chain silently loses a段; runAutoBackup reads a missing base as
    // "must be full".
    const after = await loadBackupState();
    expect(after.watermarks).toBeUndefined();
    expect(after.digest).toBeUndefined();
    expect(await idbGet('settings', AUTO_BACKUP_COUNTER_KEY)).toBeUndefined();
  });

  it('an OLD file that still carries shelf rows cannot write them back', async () => {
    await seedBase();
    await idbPut('settings', { key: BACKUP_HISTORY_KEY, value: [{ id: 'mine' }] });
    const stale: BackupFile = {
      manifest: { version: 2, schemaVersion: 9, createdAt: T(0), counts: {}, omitted: {} },
      stores: {
        settings: [
          { key: BACKUP_HISTORY_KEY, value: [{ id: 'from_the_file' }] },
          { key: 'nsfwGlobalTier', value: 'ambiguous' },
        ],
      },
    };
    await restoreBackup(parseBackup(serializeBackup(stale)), T(1));
    const shelf = await idbGet<{ value: Array<{ id: string }> }>('settings', BACKUP_HISTORY_KEY);
    expect(shelf?.value).toEqual([{ id: 'mine' }]);
    // Ordinary settings still restore, so this is an exclusion, not a bypass.
    expect((await idbGet<{ value: string }>('settings', 'nsfwGlobalTier'))?.value).toBe('ambiguous');
  });
});

describe('④ 中断的恢复必须在下次启动被告知', () => {
  it('a marker left by a killed restore is reported, and only cleared on ack', async () => {
    await seedBase();
    // What phase 2 writes before it touches anything — a SIGKILL here (the
    // WebView reclaimed while writing 60MB of media) leaves exactly this row.
    await idbPut('settings', { key: RESTORE_IN_PROGRESS_KEY, value: T(42) });
    expect(await pendingRestoreAt()).toBe(T(42));
    await acknowledgePendingRestore();
    expect(await pendingRestoreAt()).toBe(0);
  });

  it('a restore that COMPLETED raises no alarm', async () => {
    await seedBase();
    const full = await exportBackup(T(1));
    await restoreBackup(parseBackup(serializeBackup(full)), T(2));
    expect(await pendingRestoreAt()).toBe(0);
    const inc = await exportBackup(T(3), undefined, { mode: 'incremental', since: {} });
    await applyIncrementalBackup(parseBackup(serializeBackup(inc)), T(4));
    expect(await pendingRestoreAt()).toBe(0);
  });

  it('the marker never travels — a restored file cannot fake an interruption', async () => {
    await seedBase();
    await idbPut('settings', { key: RESTORE_IN_PROGRESS_KEY, value: T(42) });
    const full = await exportBackup(T(100));
    expect(JSON.stringify(full.stores)).not.toContain(RESTORE_IN_PROGRESS_KEY);
  });

  it('it is actually WIRED — a marker nobody reads does nothing (CLAUDE.md §3.5)', () => {
    const runtime = readFileSync(resolve(root, 'src/app/useSchedulerRuntime.ts'), 'utf8');
    expect(runtime).toContain('pendingRestoreAt');
    expect(runtime).toContain('acknowledgePendingRestore');
    // Reuses the existing dialog host rather than a second notification system.
    expect(runtime).toContain('showConfirm');
    const page = readFileSync(resolve(root, 'src/features/settings/BackupPage.tsx'), 'utf8');
    expect(page).toContain('pendingRestoreAt');
  });
});

describe('⑤ 增量恢复必须有护栏（快照 + 标记 + 回滚）', () => {
  /** A package whose `contacts` row has no key: IDB rejects it at write time. */
  function poison(base: BackupFile): BackupFile {
    return {
      ...base,
      manifest: { ...base.manifest, mode: 'incremental', since: {} },
      stores: { ...base.stores, contacts: [{ name: '没有 id 的行' }] },
    };
  }

  it('a truncated increment does NOT silently take contacts / conversations / settings', async () => {
    await seedBase();
    await idbPut('contacts', { id: 'ai_b', type: 'ai', name: '波', avatarColor: 'c', avatarText: 'B' });
    const before = await idbGetAll('contacts');
    const inc = poison(await exportBackup(T(1), undefined, { mode: 'incremental', since: {} }));

    await expect(applyIncrementalBackup(inc, T(2))).rejects.toThrow(/回滚/);

    // The destructive clear happened; the rollback put it all back.
    expect(await idbGetAll('contacts')).toEqual(before);
    expect((await idbGetAll('conversations')).length).toBe(1);
    expect((await idbGet<{ value: string }>('settings', 'nsfwGlobalTier'))?.value).toBe('off');
    expect((await idbGetAll('messages')).length).toBe(4);
    // And it does not leave a false "interrupted" alarm behind.
    expect(await pendingRestoreAt()).toBe(0);
  });

  it('a rollback restores the backup base too — a failed restore changed nothing', async () => {
    await seedBase();
    await cutFull(T(1));
    const baseBefore = await loadBackupState();
    expect(baseBefore.digest).toBeDefined();

    const inc = poison(await exportBackup(T(2), undefined, { mode: 'incremental', since: {} }));
    await expect(applyIncrementalBackup(inc, T(3))).rejects.toThrow(/回滚/);

    const baseAfter = await loadBackupState();
    expect(baseAfter.watermarks).toEqual(baseBefore.watermarks);
    expect(baseAfter.digest).toEqual(baseBefore.digest);
  });

  it('a chain rolls back to BEFORE its base full, not to a half-applied middle', async () => {
    await seedBase();
    const full = await cutFull(T(1));
    await idbAdd('messages', message('c1', 8));
    const inc1 = await cutIncrement(T(2));
    const inc2 = poison(await cutIncrement(T(3)));

    // The real world this device was in before anyone pressed 恢复.
    await idbPut('contacts', { id: 'ai_live', type: 'ai', name: '现在的', avatarColor: 'c', avatarText: 'L' });
    const live = await idbGetAll<{ id: string }>('contacts');

    const { snapshot } = await restoreBackup(parseBackup(serializeBackup(full)), T(10));
    await applyIncrementalBackup(parseBackup(serializeBackup(inc1)), T(11), { snapshot });
    await expect(applyIncrementalBackup(inc2, T(12), { snapshot })).rejects.toThrow(/回滚/);

    // Not stranded between two versions of the history: all the way back.
    expect((await idbGetAll<{ id: string }>('contacts')).map((c) => c.id).sort()).toEqual(
      live.map((c) => c.id).sort(),
    );
  });
});

describe('⑥ 设备本地行：一份显式清单（守卫）', () => {
  it('notification permission facts never enter a package', async () => {
    await seedBase();
    await idbPut('settings', { key: NOTIFY_ASKED_KEY, value: true });
    await idbPut('settings', { key: NOTIFY_GRANTED_KEY, value: true });
    for (const mode of ['full', 'incremental'] as const) {
      const file = await exportBackup(T(1), undefined, { mode, since: {} });
      expect(JSON.stringify(file.stores)).not.toContain(NOTIFY_ASKED_KEY);
      expect(JSON.stringify(file.stores)).not.toContain(NOTIFY_GRANTED_KEY);
    }
  });

  it("restoring keeps THIS device's permission answer, not the backup's", async () => {
    await seedBase();
    // New phone: the OS said no (or was never asked).
    await idbPut('settings', { key: NOTIFY_GRANTED_KEY, value: false });
    const fromOldPhone: BackupFile = {
      manifest: { version: 2, schemaVersion: 9, createdAt: T(0), counts: {}, omitted: {} },
      stores: {
        settings: [
          { key: NOTIFY_ASKED_KEY, value: true },
          { key: NOTIFY_GRANTED_KEY, value: true },
        ],
      },
    };
    await restoreBackup(parseBackup(serializeBackup(fromOldPhone)), T(1));
    expect((await idbGet<{ value: boolean }>('settings', NOTIFY_GRANTED_KEY))?.value).toBe(false);
    // Never asked on this device ⇒ the first-run prompt must still happen.
    expect(await idbGet('settings', NOTIFY_ASKED_KEY)).toBeUndefined();
  });

  it('the list is the ONE list — every device-local constant is registered on it', () => {
    // The keys live at their home modules; if one is renamed there and not
    // here, it starts travelling in backups again — silently. Machine-enforced
    // rather than trusted to review.
    for (const key of [
      SQLITE_MIGRATED_AT_KEY,
      SQLITE_MIGRATE_PROGRESS_KEY,
      HISTORY_KEY_FROM_SHELF,
      COUNTER_KEY_FROM_AUTO,
      WATERMARKS_KEY_FROM_AUTO,
      '__crypto_master',
    ]) {
      expect(DEVICE_LOCAL_SETTING_KEYS.has(key)).toBe(true);
    }
    // Every entry states a home and a reason — the reason is what a future
    // reader needs to decide whether a new key belongs here.
    for (const entry of DEVICE_LOCAL_SETTINGS) {
      expect(['idb', 'live']).toContain(entry.home);
      expect(entry.why.length).toBeGreaterThan(8);
    }
    // A user PREFERENCE is not a device fact: the auto-backup frequency travels.
    expect(DEVICE_LOCAL_SETTING_KEYS.has('autoBackupFreq')).toBe(false);
    expect(isPortableSettingRow({ key: 'autoBackupFreq', value: 'daily' })).toBe(true);
    expect(isPortableSettingRow({ key: BACKUP_HISTORY_KEY, value: [] })).toBe(false);
  });

  it('no exclusion is judged at a call site any more', () => {
    // The three bugs all came from ad-hoc lists next to the code that filtered.
    const backup = readFileSync(resolve(root, 'src/lib/backup.ts'), 'utf8');
    expect(backup).toContain("from './device-local'");
    expect(backup).not.toContain('NEVER_EXPORT_SETTING_KEYS');
  });
});

describe('⑦ 手动导出：货架写失败时水位不得前进', () => {
  it('a failed shelf write leaves the base untouched', async () => {
    await seedBase();
    const { watermarks, digest } = await exportBackupWithState(T(1));
    const ok = await commitBackupState({ watermarks, digest }, async () => {
      throw new Error('磁盘满了');
    });
    expect(ok).toBe(false);
    // No base ⇒ runAutoBackup's next run is a FULL, and no increment is ever
    // cut against a full that is not on the shelf.
    expect(await loadBackupState()).toEqual({ watermarks: undefined, digest: undefined });
  });

  it('a successful shelf write advances both halves of the base together', async () => {
    await seedBase();
    const { watermarks, digest } = await exportBackupWithState(T(1));
    expect(await commitBackupState({ watermarks, digest }, async () => {})).toBe(true);
    const state = await loadBackupState();
    expect(state.watermarks).toEqual(watermarks);
    expect(state.digest).toEqual(digest);
  });

  it('the export page routes through it instead of swallowing the failure', () => {
    const page = readFileSync(resolve(root, 'src/features/settings/BackupPage.tsx'), 'utf8');
    expect(page).toContain('commitBackupState');
    // The old shape was `recordBackup(…).catch(() => {})` followed by an
    // unconditional `putSetting(BACKUP_WATERMARKS_KEY, …)`: the base advanced
    // whether or not the file reached the shelf.
    expect(page).not.toContain('BACKUP_WATERMARKS_KEY');
    expect(page).not.toMatch(/recordBackup\([\s\S]{0,400}?\.catch\(\(\) => \{\}\)/);
  });
});

describe('隐藏会话仍然是数据（备份保留，预览不泄漏）', () => {
  it('a hidden AI↔AI conversation is backed up but never in a visible count line', async () => {
    await seedBase();
    await idbPut('conversations', {
      id: 'dm_ai', type: 'single', peerId: 'ai_b', title: '阿↔波', avatarColor: 'c',
      avatarText: 'D', isPinned: false, isMuted: false, unreadCount: 0, mentionMe: false,
      isHidden: true,
    });
    await idbAdd('messages', message('dm_ai', 20, { content: '八卦内容' }));

    const full = await exportBackup(T(1));
    // It IS data — losing it would lose the gossip layer's history.
    expect(JSON.stringify(full.stores)).toContain('八卦内容');
    // …but the manifest, which is everything the UI is allowed to render, is
    // aggregate counts and store names only.
    expect(JSON.stringify(full.manifest)).not.toContain('八卦内容');
    expect(JSON.stringify(full.manifest)).not.toContain('阿↔波');
  });
});

describe('向后兼容：v2 / v1 包仍然可恢复', () => {
  it('a v2 increment (no digest, no tombstones) still applies by watermark', async () => {
    await seedBase();
    const full = await exportBackup(T(1));
    await idbAdd('messages', message('c1', 9));
    const v2inc = await exportBackup(T(2), undefined, {
      mode: 'incremental',
      since: full.manifest.watermarks,
    });
    (v2inc.manifest as { version: number }).version = 2;
    expect(v2inc.tombstones).toBeUndefined();

    for (const s of STORES) await idbClear(s.name);
    await restoreBackup(parseBackup(serializeBackup(full)), T(3));
    await applyIncrementalBackup(parseBackup(serializeBackup(v2inc)), T(4));
    expect((await idbGetAll('messages')).length).toBe(5);
  });

  it('an empty digest map means "the base had nothing", not "no base"', () => {
    const digest: RowDigest = { messages: {} };
    expect(incrementalRows('messages', [{ id: 1 }], 0, digest.messages)).toEqual([{ id: 1 }]);
    expect(deletedRowKeys('messages', [{ id: 1 }], digest.messages)).toEqual([]);
  });
});
