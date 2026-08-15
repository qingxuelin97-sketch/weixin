import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { webcrypto } from 'node:crypto';
import {
  openDB,
  idbPut,
  idbAdd,
  idbGet,
  idbClear,
  STORES,
  _closeDbForTests,
} from '../../src/db/idb';
import {
  exportBackup,
  restoreBackup,
  applyIncrementalBackup,
  incrementalRows,
  computeWatermarks,
  backupMode,
  backupFilename,
  parseBackup,
  serializeBackup,
  BACKUP_VERSION,
  type BackupFile,
} from '../../src/lib/backup';
import { resolveRestoreChain, type BackupHistoryEntry } from '../../src/lib/backup-history';
import {
  periodMs,
  nextAutoBackupAt,
  autoBackupActionId,
} from '../../src/ai/auto-backup';

/**
 * Backup v2 acceptance (转红 ③④): incremental packages must compose — full +
 * increments restores to EXACTLY what a direct full backup of the final state
 * would restore — and the device-local CryptoKey row must be filtered on the
 * incremental path just as it is on the full path.
 */

const T = (n: number) => 1_754_500_000_000 + n;

async function makeCryptoKey(): Promise<CryptoKey> {
  return (webcrypto as unknown as Crypto).subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  ) as Promise<CryptoKey>;
}

const message = (convId: string, i: number) => ({
  convId,
  senderId: i % 2 ? 'self' : 'ai_a',
  type: 'text',
  content: `m${i}`,
  status: 'sent',
  createdAt: T(i * 1000),
});

async function seedBase(): Promise<void> {
  await idbPut('contacts', { id: 'ai_a', type: 'ai', name: '阿', avatarColor: 'c', avatarText: 'A' });
  await idbPut('conversations', {
    id: 'c1', type: 'single', peerId: 'ai_a', title: '阿', avatarColor: 'c', avatarText: 'A',
    isPinned: false, isMuted: false, unreadCount: 0, mentionMe: false,
  });
  for (let i = 1; i <= 6; i++) await idbAdd('messages', message('c1', i));
  await idbPut('moments', { id: 'p1', authorId: 'ai_a', text: 'hi', imageRefs: [], isNsfw: false, createdAt: T(10) });
  await idbPut('moment_likes', { id: 'p1:self', momentId: 'p1', contactId: 'self', createdAt: T(11) });
  await idbPut('wallet_tx', { id: 'w1', kind: 'adjust', amountFen: 100, balanceAfterFen: 100, createdAt: T(12) });
  await idbPut('media', {
    id: 'md1', kind: 'photo', tags: [], mime: 'text/plain',
    blob: new Blob(['OLD_BYTES'], { type: 'text/plain' }), createdAt: T(13),
  });
  await idbPut('settings', { key: 'nsfwGlobalTier', value: 'off' });
}

/** The stores of an export, with restore-time bookkeeping rows filtered out. */
function comparable(file: BackupFile): Record<string, unknown[]> {
  const out = { ...file.stores };
  out.settings = (out.settings ?? []).filter(
    (r) => (r as { key?: string }).key !== 'lastForegroundAt',
  );
  return out;
}

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  _closeDbForTests();
  await openDB();
});

describe('增量+全量 == 直接全量 (转红 ③)', () => {
  it('restoring the full then layering the increment reproduces the final state', async () => {
    await seedBase();
    const full = await exportBackup(T(100_000));
    expect(backupMode(full)).toBe('full');
    expect(full.manifest.watermarks?.messages).toBe(6);

    // Life goes on after the full backup: appends AND in-place edits.
    await idbAdd('messages', message('c1', 7));
    await idbAdd('messages', message('c1', 8));
    // A recall EDITS a row below the watermark — the classic increment killer.
    const recalled = { ...message('c1', 2), id: 2, isRecalled: true };
    await idbPut('messages', recalled);
    await idbPut('moments', { id: 'p2', authorId: 'ai_a', text: 'new', imageRefs: [], isNsfw: false, createdAt: T(20_000) });
    await idbPut('moment_likes', { id: 'p2:self', momentId: 'p2', contactId: 'self', createdAt: T(20_001) });
    await idbPut('wallet_tx', { id: 'w2', kind: 'rp_in', amountFen: 88, balanceAfterFen: 188, createdAt: T(20_002) });
    await idbPut('media', {
      id: 'md2', kind: 'photo', tags: [], mime: 'text/plain',
      blob: new Blob(['NEW_BYTES'], { type: 'text/plain' }), createdAt: T(20_003),
    });
    await idbPut('contacts', { id: 'ai_b', type: 'ai', name: '波', avatarColor: 'c', avatarText: 'B' });
    await idbPut('conversations', {
      id: 'c1', type: 'single', peerId: 'ai_a', title: '改名了', avatarColor: 'c', avatarText: 'A',
      isPinned: true, isMuted: false, unreadCount: 0, mentionMe: false,
    });
    await idbPut('settings', { key: 'nsfwGlobalTier', value: 'ambiguous' });

    const inc = await exportBackup(T(200_000), undefined, {
      mode: 'incremental',
      since: full.manifest.watermarks,
    });
    expect(backupMode(inc)).toBe('incremental');
    // Watermark stores carry only the delta (plus the recalled old row)…
    expect((inc.stores.messages as Array<{ id: number }>).map((m) => m.id).sort((a, b) => a - b)).toEqual([2, 7, 8]);
    expect((inc.stores.moments as Array<{ id: string }>).map((m) => m.id)).toEqual(['p2']);
    expect((inc.stores.wallet_tx as Array<{ id: string }>).map((m) => m.id)).toEqual(['w2']);
    expect((inc.stores.media as Array<{ id: string }>).map((m) => m.id)).toEqual(['md2']);
    // …while mutable stores are snapshotted whole.
    expect(inc.stores.contacts).toHaveLength(2);
    expect((inc.stores.conversations as Array<{ title: string }>)[0].title).toBe('改名了');

    const reference = await exportBackup(T(300_000));

    // Disaster: everything gone. Restore full, layer the increment.
    for (const s of STORES) await idbClear(s.name);
    await restoreBackup(parseBackup(serializeBackup(full)), T(400_000));
    await applyIncrementalBackup(parseBackup(serializeBackup(inc)), T(400_001));

    const after = await exportBackup(T(300_000));
    expect(comparable(after)).toEqual(comparable(reference));
    // Spot checks the diff above could hide: the recall landed, ids intact.
    const msgs = after.stores.messages as Array<{ id: number; isRecalled?: boolean }>;
    expect(msgs.map((m) => m.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(msgs.find((m) => m.id === 2)?.isRecalled).toBe(true);
  });

  it('restoreBackup refuses an incremental package instead of half-restoring', async () => {
    await seedBase();
    const inc = await exportBackup(T(1), undefined, { mode: 'incremental', since: {} });
    await expect(restoreBackup(inc, T(2))).rejects.toThrow(/增量/);
  });
});

describe('设备密钥行的增量过滤 (转红 ④)', () => {
  it('the CryptoKey settings row never enters an incremental package', async () => {
    await seedBase();
    await idbPut('settings', { key: '__crypto_master', value: await makeCryptoKey() });
    const inc = await exportBackup(T(1), undefined, { mode: 'incremental', since: {} });
    expect(JSON.stringify(inc.stores)).not.toContain('__crypto_master');
    expect((inc.stores.settings as Array<{ key: string }>).map((r) => r.key)).toEqual([
      'nsfwGlobalTier',
    ]);
    // …and a CryptoKey row under a DIFFERENT key is caught by instanceof, not
    // by the name list (a husk `{}` is truthy; a live key is not stringifiable).
    await idbPut('settings', { key: 'someOtherKey', value: await makeCryptoKey() });
    const inc2 = await exportBackup(T(2), undefined, { mode: 'incremental', since: {} });
    expect((inc2.stores.settings as Array<{ key: string }>).some((r) => r.key === 'someOtherKey')).toBe(false);
  });

  it('applying an increment keeps THIS device master key', async () => {
    await seedBase();
    const key = await makeCryptoKey();
    await idbPut('settings', { key: '__crypto_master', value: key });
    const inc = await exportBackup(T(1), undefined, { mode: 'incremental', since: {} });
    await applyIncrementalBackup(inc, T(2));
    const master = await idbGet<{ key: string; value: unknown }>('settings', '__crypto_master');
    expect(master?.value).toBeInstanceOf(CryptoKey);
  });
});

describe('format v2 plumbing', () => {
  it('v1 files (no mode) parse as full and still restore', async () => {
    const v1: BackupFile = {
      manifest: { version: 1, schemaVersion: 8, createdAt: T(0), counts: {}, omitted: {} },
      stores: { contacts: [{ id: 'ai_z', type: 'ai', name: 'Z', avatarColor: 'c', avatarText: 'Z' }] },
    };
    const parsed = parseBackup(serializeBackup(v1));
    expect(backupMode(parsed)).toBe('full');
    await restoreBackup(parsed, T(5));
    expect(await idbGet('contacts', 'ai_z')).toBeDefined();
  });

  it('rejects files from a newer format', () => {
    const future: BackupFile = {
      manifest: { version: BACKUP_VERSION + 1, schemaVersion: 8, createdAt: T(0), counts: {}, omitted: {} },
      stores: {},
    };
    expect(() => parseBackup(serializeBackup(future))).toThrow(/更新的版本/);
  });

  it('incremental filenames carry the -inc marker', () => {
    expect(backupFilename(new Date(2026, 7, 8, 14, 30).getTime(), 'incremental')).toBe(
      'weixin-ai-20260808-1430-inc.aiwx',
    );
    expect(backupFilename(new Date(2026, 7, 8, 14, 30).getTime())).toBe(
      'weixin-ai-20260808-1430.aiwx',
    );
  });

  it('incrementalRows and computeWatermarks are exact and monotonic', () => {
    const rows = [
      { id: 1, isRecalled: true },
      { id: 2 },
      { id: 3 },
    ];
    expect(incrementalRows('messages', rows, 2)).toEqual([{ id: 1, isRecalled: true }, { id: 3 }]);
    expect(incrementalRows('moments', [{ createdAt: 5 }, { createdAt: 9 }], 5)).toEqual([
      { createdAt: 9 },
    ]);
    // Unknown store: passes through untouched (snapshot semantics).
    expect(incrementalRows('contacts', rows, 99)).toEqual(rows);

    const w = computeWatermarks({ messages: rows, moments: [{ createdAt: 7 }] });
    expect(w.messages).toBe(3);
    expect(w.moments).toBe(7);
    // Never backwards: an emptied store keeps its previous mark.
    const w2 = computeWatermarks({ messages: [] }, { messages: 10 });
    expect(w2.messages).toBe(10);
  });
});

describe('restore chain resolution (备份历史)', () => {
  const e = (id: string, mode: 'full' | 'incremental', at: number): BackupHistoryEntry => ({
    id,
    name: id,
    createdAt: at,
    bytes: 1,
    mode,
    source: 'auto',
  });

  it('an increment resolves to its base full plus every increment up to it', () => {
    const entries = [e('f1', 'full', 10), e('i1', 'incremental', 20), e('i2', 'incremental', 30), e('f2', 'full', 40), e('i3', 'incremental', 50)];
    expect(resolveRestoreChain(entries, 'i2')!.map((x) => x.id)).toEqual(['f1', 'i1', 'i2']);
    expect(resolveRestoreChain(entries, 'i3')!.map((x) => x.id)).toEqual(['f2', 'i3']);
    expect(resolveRestoreChain(entries, 'f2')!.map((x) => x.id)).toEqual(['f2']);
  });

  it('an orphan increment (no covering full) resolves to null', () => {
    expect(resolveRestoreChain([e('i1', 'incremental', 20)], 'i1')).toBeNull();
    expect(resolveRestoreChain([], 'nope')).toBeNull();
  });
});

describe('auto-backup planning (铁律 4: injected time, stable ids)', () => {
  it('period math and per-period ids are deterministic', () => {
    expect(periodMs('daily')).toBe(86_400_000);
    expect(periodMs('weekly')).toBe(7 * 86_400_000);
    const now = T(0);
    expect(nextAutoBackupAt('daily', now)).toBe(now + 86_400_000);
    const fireAt = nextAutoBackupAt('daily', now);
    // Same period → same id (upsert-stable); next period → different id.
    expect(autoBackupActionId('daily', fireAt)).toBe(autoBackupActionId('daily', fireAt + 1));
    expect(autoBackupActionId('daily', fireAt)).not.toBe(
      autoBackupActionId('daily', fireAt + 86_400_000),
    );
  });
});
