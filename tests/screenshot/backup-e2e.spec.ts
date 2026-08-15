import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * Export → wipe → restore, driven through the real UI against a real IndexedDB.
 *
 * The unit tests cover the serializer in isolation; this is the only place the
 * actual store round-trip is proven, and the only place the claim "导出→恢复零差异"
 * is actually checked. It runs against the production build (that's what the
 * preview server serves), so it uses plain browser APIs rather than importing
 * app modules — which also means it exercises the same code path a user does.
 */

/** Dump every object store via raw IndexedDB, so no app module is needed. */
const DUMP = `
  new Promise((resolve, reject) => {
    const req = indexedDB.open('weixin-ai');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const names = Array.from(db.objectStoreNames);
      if (!names.length) return resolve({});
      const out = {};
      const tx = db.transaction(names, 'readonly');
      let left = names.length;
      for (const n of names) {
        const r = tx.objectStore(n).getAll();
        r.onsuccess = () => {
          out[n] = r.result;
          if (--left === 0) resolve(out);
        };
        r.onerror = () => reject(r.error);
      }
    };
  })
`;

const CLEAR_ALL = `
  new Promise((resolve, reject) => {
    const req = indexedDB.open('weixin-ai');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const names = Array.from(db.objectStoreNames);
      const tx = db.transaction(names, 'readwrite');
      for (const n of names) tx.objectStore(n).clear();
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    };
  })
`;

/** Rows the backup deliberately does not carry, excluded from the comparison. */
function comparable(dump: Record<string, unknown[]>): Record<string, unknown[]> {
  const { tts_cache: _omitted, settings = [], ...rest } = dump;
  // Device-local settings rows are non-portable BY DESIGN (H3): the crypto
  // master key never travels, and restore re-arms the backfill barrier at
  // restore time. Everything else must round-trip exactly.
  return {
    ...rest,
    settings: (settings as Array<{ key?: string }>).filter(
      // Device-local runtime state, not user data: the crypto key, the backfill
      // barrier, and the in-flight-restore marker a restore necessarily writes.
      (r) =>
        r.key !== '__crypto_master' &&
        r.key !== 'lastForegroundAt' &&
        r.key !== 'restoreInProgress',
    ),
  };
}

test('export → wipe → restore round-trips the real database', async ({ page }) => {
  await page.goto('/#/chats');
  await page.waitForTimeout(800); // hydrate() seeds on first run

  const before = comparable(await page.evaluate(DUMP));
  expect(Object.keys(before.conversations ?? []).length).toBeGreaterThan(0);
  expect((before.messages ?? []).length).toBeGreaterThan(0);
  expect((before.moments ?? []).length).toBeGreaterThan(0);

  // Export through the UI and capture the downloaded file.
  await page.goto('/#/settings/backup');
  await page.waitForTimeout(200);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByText('导出备份').click(),
  ]);
  const path = await download.path();
  expect(download.suggestedFilename()).toMatch(/^weixin-ai-\d{8}-\d{4}\.aiwx$/);
  const backupJson = readFileSync(path, 'utf8');

  // Wipe everything, and prove it's actually gone before restoring.
  await page.evaluate(CLEAR_ALL);
  const wiped = comparable(await page.evaluate(DUMP));
  expect(wiped.messages).toEqual([]);
  expect(wiped.conversations).toEqual([]);

  // Restore through the UI: pick the file, then confirm.
  await page.goto('/#/settings/backup');
  await page.waitForTimeout(200);
  await page.locator('input[type=file]').setInputFiles({
    name: 'restore.aiwx',
    mimeType: 'application/json',
    buffer: Buffer.from(backupJson),
  });
  await page.getByRole('button', { name: '确认恢复' }).click();
  await expect(page.getByText(/恢复完成/)).toBeVisible({ timeout: 10_000 });

  const after = comparable(await page.evaluate(DUMP));
  // Zero difference: same stores, same rows, same ids — including the
  // autoincrement message ids, which must survive so rowid order is preserved.
  expect(after).toEqual(before);
});

test('a restore confirmation states what it is about to replace', async ({ page }) => {
  await page.goto('/#/chats');
  await page.waitForTimeout(800);
  await page.goto('/#/settings/backup');
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByText('导出备份').click(),
  ]);
  const backupJson = readFileSync(await download.path(), 'utf8');

  await page.locator('input[type=file]').setInputFiles({
    name: 'restore.aiwx',
    mimeType: 'application/json',
    buffer: Buffer.from(backupJson),
  });
  // The user confirms against real row counts, not a bare yes/no. Since M-I17
  // the export summary ("已导出：…会话 N…") stays on the page behind the
  // dialog, so the counts assertion must not be ambiguous across both.
  await expect(page.getByText(/该备份创建于/)).toBeVisible();
  await expect(page.getByText(/整库替换/)).toBeVisible();
  await expect(page.getByText(/会话 \d+/).first()).toBeVisible();
});

test('a corrupt backup file is rejected with a readable reason', async ({ page }) => {
  await page.goto('/#/settings/backup');
  await page.waitForTimeout(300);
  await page.locator('input[type=file]').setInputFiles({
    name: 'broken.aiwx',
    mimeType: 'application/json',
    buffer: Buffer.from('this is not json'),
  });
  await expect(page.getByText(/不是有效的备份格式/)).toBeVisible();
  // And it must NOT offer to restore from it.
  await expect(page.getByRole('button', { name: '确认恢复' })).toHaveCount(0);
});

test('an export never carries an API key out of the device', async ({ page }) => {
  await page.goto('/#/chats');
  await page.waitForTimeout(800);

  // Plant a provider row with a stray key, as a buggy write might.
  await page.evaluate(`
    new Promise((resolve, reject) => {
      const req = indexedDB.open('weixin-ai');
      req.onsuccess = () => {
        const tx = req.result.transaction('providers', 'readwrite');
        tx.objectStore('providers').put({
          id: 'p_test', kind: 'custom', label: 't',
          baseUrl: 'https://example.invalid', keyAlias: 'alias_only',
          models: ['m'], enabled: true,
          apiKey: 'sk-SHOULD-NOT-BE-EXPORTED',
        });
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    })
  `);

  await page.goto('/#/settings/backup');
  await page.waitForTimeout(200);
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByText('导出备份').click(),
  ]);
  const json = readFileSync(await download.path(), 'utf8');

  expect(json).not.toContain('sk-SHOULD-NOT-BE-EXPORTED');

  // Assert on the rows themselves: the string "apiKey" legitimately appears in
  // the manifest's `omitted` map, which documents the exclusion.
  const providers = JSON.parse(json).stores.providers as Array<Record<string, unknown>>;
  const planted = providers.find((p) => p.id === 'p_test');
  expect(planted).toBeDefined();
  expect(Object.keys(planted!)).not.toContain('apiKey');
  // The slot config itself must survive, so a restore can ask for the key again.
  expect(planted!.keyAlias).toBe('alias_only');
  expect(planted!.baseUrl).toBe('https://example.invalid');
});
