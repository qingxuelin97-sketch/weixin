import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression for H3 — the restore-bricks-the-keystore bug.
 *
 * The WebCrypto master key (settings row `__crypto_master`) is non-extractable
 * and device-local. JSON.stringify flattens it to `{}`; a restore that wrote
 * that husk back made every later encrypt throw, so no API key could ever be
 * saved again. The rules pinned here:
 *
 *   1. export never carries the master-key row,
 *   2. restore preserves THIS device's master key and discards any incoming one,
 *   3. restore re-arms the backfill barrier (an old backup's timestamp must not
 *      open a giant "while you were away" fabrication window),
 *   4. the keystore self-heals if a `{}` husk is already in place.
 */

// In-memory stand-in for the idb module: Map-of-Maps, same call surface.
vi.mock('../../src/db/idb', () => {
  const stores = new Map<string, Map<unknown, Record<string, unknown>>>();
  const s = (n: string) => {
    if (!stores.has(n)) stores.set(n, new Map());
    return stores.get(n)!;
  };
  return {
    STORES: [
      { name: 'contacts', keyPath: 'id' },
      { name: 'settings', keyPath: 'key' },
    ],
    idbGetAll: async (n: string) => [...s(n).values()],
    idbGet: async (n: string, k: unknown) => s(n).get(k),
    idbPut: async (n: string, row: Record<string, unknown>) => {
      s(n).set((row.key ?? row.id) as unknown, row);
    },
    idbClear: async (n: string) => s(n).clear(),
    openDB: async () => ({ version: 4 }),
    // The mocked module is shared by src/db/repo.ts, driver.ts and sqlite.ts
    // (backup v2 reads through the driver dispatch), so every named export
    // those modules import must exist here — vitest hard-fails on missing ones.
    idbDelete: async (n: string, k: unknown) => void s(n).delete(k),
    idbBulkPut: async (n: string, rows: Record<string, unknown>[]) => {
      for (const row of rows) s(n).set((row.key ?? row.id) as unknown, row);
    },
    idbAdd: async (n: string, row: Record<string, unknown>) => {
      const id = s(n).size + 1;
      s(n).set(id, { ...row, id });
      return id;
    },
    idbBulkAdd: async () => {},
    idbCount: async (n: string) => s(n).size,
    idbQueryByIndex: async () => [],
    idbGetAllByIndex: async () => [],
    idbDeleteByIndex: async () => 0,
    idbPageDesc: async () => [],
    idbFirstByIndex: async () => undefined,
    idbRangeByIndex: async () => [],
    __stores: stores,
  };
});

import { exportBackup, restoreBackup, type BackupFile } from '../../src/lib/backup';
import * as idb from '../../src/db/idb';

const NOW = new Date(2026, 7, 8, 12, 0, 0).getTime();
const raw = (idb as unknown as { __stores: Map<string, Map<unknown, Record<string, unknown>>> })
  .__stores;

beforeEach(() => {
  raw.clear();
});

async function seedLocal() {
  await idb.idbPut('settings', { key: '__crypto_master', value: 'LOCAL_KEY_OBJECT' });
  await idb.idbPut('settings', { key: 'nsfwGlobalTier', value: 'off' });
  await idb.idbPut('contacts', { id: 'self', name: '我' });
}

describe('export key isolation', () => {
  it('never includes the crypto master row', async () => {
    await seedLocal();
    const file = await exportBackup(NOW);
    // The manifest MENTIONS the exclusion (that's the point); the data must not.
    expect(JSON.stringify(file.stores)).not.toContain('__crypto_master');
    expect(file.stores.settings).toEqual([{ key: 'nsfwGlobalTier', value: 'off' }]);
    expect(file.manifest.counts.settings).toBe(1);
    expect(file.manifest.omitted['settings.__crypto_master']).toBeTruthy();
  });
});

describe('restore key isolation', () => {
  const incoming = (settings: unknown[]): BackupFile => ({
    manifest: {
      version: 1,
      schemaVersion: 4,
      createdAt: NOW - 7 * 86_400_000, // a week-old backup
      counts: {},
      omitted: {},
    },
    stores: { settings, contacts: [{ id: 'self', name: '备份里的我' }] },
  });

  it("keeps THIS device's master key and drops the backup's husk", async () => {
    await seedLocal();
    await restoreBackup(
      incoming([{ key: '__crypto_master', value: {} }, { key: 'x', value: 1 }]),
      NOW,
    );
    const settings = await idb.idbGetAll<{ key: string; value: unknown }>('settings');
    const master = settings.find((r) => r.key === '__crypto_master');
    expect(master?.value).toBe('LOCAL_KEY_OBJECT');
    expect(settings.find((r) => r.key === 'x')?.value).toBe(1);
  });

  it('re-arms the backfill barrier at restore time, not the backup age', async () => {
    await seedLocal();
    await restoreBackup(incoming([{ key: 'lastForegroundAt', value: NOW - 7 * 86_400_000 }]), NOW);
    const settings = await idb.idbGetAll<{ key: string; value: unknown }>('settings');
    expect(settings.find((r) => r.key === 'lastForegroundAt')?.value).toBe(NOW);
  });

  it('restore still replaces ordinary stores wholesale', async () => {
    await seedLocal();
    await restoreBackup(incoming([]), NOW);
    expect(await idb.idbGetAll('contacts')).toEqual([{ id: 'self', name: '备份里的我' }]);
  });
});

describe('keystore self-heal', () => {
  it('setSecret works even when a `{}` husk sits where the CryptoKey should be', async () => {
    // A device already bricked by the old bug: the husk row is in place.
    await idb.idbPut('settings', { key: '__crypto_master', value: {} });

    // keystore needs localStorage; node has none — a Map-backed stub suffices.
    const ls = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => ls.get(k) ?? null,
      setItem: (k: string, v: string) => void ls.set(k, v),
      removeItem: (k: string) => void ls.delete(k),
    });
    try {
      const { setSecret, getSecret } = await import('../../src/lib/keystore');
      await setSecret('key_test', 'sk-plaintext');
      expect(await getSecret('key_test')).toBe('sk-plaintext');
      // The husk was replaced with a real key.
      const row = await idb.idbGet<{ key: string; value: unknown }>('settings', '__crypto_master');
      expect(row?.value).toBeInstanceOf(CryptoKey);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
