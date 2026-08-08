import { test, expect } from '@playwright/test';

/**
 * Golden screenshots for the core M1 screens. First run creates baselines under
 * tests/screenshot/shell.spec.ts-snapshots/. Calibrate these against the user's
 * real-device WeChat screenshots, then commit as the regression baseline.
 */

async function settle(page: import('@playwright/test').Page) {
  // Wait for fonts + layout to settle so pixels are stable.
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(150);
}

test('conversation list', async ({ page }) => {
  await page.goto('/#/chats');
  await settle(page);
  await expect(page).toHaveScreenshot('chat-list.png', { fullPage: false });
});

test('single chat page', async ({ page }) => {
  await page.goto('/#/chat/conv_lin');
  await settle(page);
  await expect(page).toHaveScreenshot('chat-single.png', { fullPage: false });
});

test('group chat page', async ({ page }) => {
  await page.goto('/#/chat/conv_group');
  await settle(page);
  await expect(page).toHaveScreenshot('chat-group.png', { fullPage: false });
});

test('contacts page', async ({ page }) => {
  await page.goto('/#/contacts');
  await settle(page);
  await expect(page).toHaveScreenshot('contacts.png', { fullPage: false });
});

test('discover page', async ({ page }) => {
  await page.goto('/#/discover');
  await settle(page);
  await expect(page).toHaveScreenshot('discover.png', { fullPage: false });
});

test('me page', async ({ page }) => {
  await page.goto('/#/me');
  await settle(page);
  await expect(page).toHaveScreenshot('me.png', { fullPage: false });
});

test('red packet send page', async ({ page }) => {
  await page.goto('/#/rp/send/conv_group');
  await settle(page);
  await expect(page).toHaveScreenshot('rp-send.png', { fullPage: false });
});

test('red packet open overlay', async ({ page }) => {
  await page.goto('/#/rp/open/rp_seed_group');
  await settle(page);
  await expect(page).toHaveScreenshot('rp-open.png', { fullPage: false });
});

test('transfer send page', async ({ page }) => {
  await page.goto('/#/transfer/conv_lin');
  await settle(page);
  await expect(page).toHaveScreenshot('transfer-send.png', { fullPage: false });
});

test('wallet page', async ({ page }) => {
  await page.goto('/#/wallet');
  await settle(page);
  await expect(page).toHaveScreenshot('wallet.png', { fullPage: false });
});

test('composer: emoji panel open (keyboard⇄panel prototype)', async ({ page }) => {
  await page.goto('/#/chat/conv_lin');
  await settle(page);
  await page.getByLabel('表情').click();
  await page.waitForTimeout(200);
  await expect(page).toHaveScreenshot('composer-emoji.png', { fullPage: false });
});

test('composer: plus panel open', async ({ page }) => {
  await page.goto('/#/chat/conv_lin');
  await settle(page);
  await page.getByLabel('更多').last().click();
  await page.waitForTimeout(200);
  await expect(page).toHaveScreenshot('composer-plus.png', { fullPage: false });
});

test('moments feed', async ({ page }) => {
  await page.goto('/#/moments');
  await settle(page);
  await expect(page).toHaveScreenshot('moments-feed.png', { fullPage: false });
});

test('moments feed scrolled (nav fades to solid)', async ({ page }) => {
  await page.goto('/#/moments');
  await settle(page);
  await page.locator('.moments__scroll').evaluate((el) => (el.scrollTop = 320));
  await page.waitForTimeout(250);
  await expect(page).toHaveScreenshot('moments-feed-scrolled.png', { fullPage: false });
});

test('moments publish page', async ({ page }) => {
  await page.goto('/#/moments/publish');
  await settle(page);
  await expect(page).toHaveScreenshot('moments-publish.png', { fullPage: false });
});

test('backup & restore page', async ({ page }) => {
  await page.goto('/#/settings/backup');
  await settle(page);
  await expect(page).toHaveScreenshot('backup.png', { fullPage: false });
});
