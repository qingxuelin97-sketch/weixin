import { test, expect } from '@playwright/test';

/**
 * Real-device bug #7: the unread badge never cleared (and never incremented) —
 * it was frozen seed data. These prove the full chain against the production
 * build + real IndexedDB: enter clears, leave with text parks a draft.
 * Same semantic-assertion pattern as backup-e2e.spec.ts.
 */

async function boot(page: import('@playwright/test').Page) {
  await page.goto('/#/chats');
  await page.waitForTimeout(800); // hydrate() seeds on first run
}

test('entering a conversation clears its unread badge for good', async ({ page }) => {
  await boot(page);
  // The seeded 林小雨 conversation carries unread > 0 on first run.
  const row = page.locator('.conv-row', { hasText: '林小雨' }).first();
  await expect(row.locator('.conv-row__badge')).toBeVisible();

  await row.click();
  await expect(page).toHaveURL(/#\/chat\//);
  await page.waitForTimeout(300);
  await page.locator('.chat-nav__back').click();

  await expect(page).toHaveURL(/#\/chats$/);
  await expect(row.locator('.conv-row__badge')).toHaveCount(0);

  // Cleared in the DB, not just in view — survives a full reload.
  await page.reload();
  await page.waitForTimeout(800);
  await expect(
    page.locator('.conv-row', { hasText: '林小雨' }).first().locator('.conv-row__badge'),
  ).toHaveCount(0);
});

test('leaving with unsent text parks it as a [草稿] and restores it on return', async ({ page }) => {
  await boot(page);
  const row = page.locator('.conv-row', { hasText: '林小雨' }).first();
  await row.click();
  await page.locator('.composer__input').fill('还没说完的话');
  await page.locator('.chat-nav__back').click();

  await expect(row.locator('.conv-row__draft')).toContainText('[草稿]');
  await expect(row).toContainText('还没说完的话');

  // Re-entering puts the text back in the composer; sending is still possible.
  await row.click();
  await expect(page.locator('.composer__input')).toHaveValue('还没说完的话');

  // Clearing the text and leaving again removes the draft marker.
  await page.locator('.composer__input').fill('');
  await page.locator('.chat-nav__back').click();
  await expect(row.locator('.conv-row__draft')).toHaveCount(0);
});
