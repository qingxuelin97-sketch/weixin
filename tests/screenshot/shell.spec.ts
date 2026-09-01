import { test, expect } from '@playwright/test';

/**
 * Golden screenshots for the core M1 screens. First run creates baselines under
 * tests/screenshot/shell.spec.ts-snapshots/. Calibrate these against the user's
 * real-device WeChat screenshots, then commit as the regression baseline.
 */

import { settle, SEED_EPOCH } from './helpers';

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(SEED_EPOCH);
});

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
  // 群公告弹窗 (M-J7): a fresh install has never seen this group's announcement,
  // so the popup is up on first open — by design. This shot is about the
  // THREAD, so acknowledge it first; leaving it would turn a golden that
  // watches the message list into one that watches a dialog.
  const ack = page.getByRole('button', { name: '我知道了' });
  if (await ack.isVisible().catch(() => false)) {
    await ack.click();
    await settle(page);
  }
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

test('search page (empty state)', async ({ page }) => {
  await page.goto('/#/search');
  await settle(page);
  await expect(page).toHaveScreenshot('search-empty.png', { fullPage: false });
});

test('search page with results', async ({ page }) => {
  await page.goto('/#/chats');
  await page.waitForTimeout(600); // let hydrate() seed the corpus
  await page.goto('/#/search');
  await settle(page);
  // 咖啡 hits a message body AND nothing else, so this golden covers the
  // 聊天记录 group — the path a name-only query never exercises.
  await page.getByLabel('搜索').fill('咖啡');
  await page.waitForTimeout(200);
  await expect(page).toHaveScreenshot('search-results.png', { fullPage: false });
});

test('settings page', async ({ page }) => {
  await page.goto('/#/settings');
  await settle(page);
  await expect(page).toHaveScreenshot('settings.png', { fullPage: false });
});

test('API config page', async ({ page }) => {
  await page.goto('/#/settings/api');
  await settle(page);
  await expect(page).toHaveScreenshot('settings-api.png', { fullPage: false });
});

test('persona edit page', async ({ page }) => {
  await page.goto('/#/chats');
  await page.waitForTimeout(600);
  await page.goto('/#/persona/ai_lin');
  await settle(page);
  await expect(page).toHaveScreenshot('persona-edit.png', { fullPage: false });
});

/**
 * The 行为 section, scrolled into view (M-I18).
 *
 * `fullPage: false` means every shot is one 390×844 viewport, and this page is
 * long — so the ENTIRE behaviour section (proactivity, typing speed, heartbeat,
 * 抢红包, and now 表情使用率) has never been in a golden. Adding a slider there
 * moved no pixels in `persona-edit.png`, which is how I noticed: the page was
 * "covered" while the half of it made of knobs was not.
 */
test('persona edit page — 行为 knobs', async ({ page }) => {
  await page.goto('/#/chats');
  await page.waitForTimeout(600);
  await page.goto('/#/persona/ai_lin');
  await settle(page);
  // Anchor on the section heading rather than a pixel offset: a row added
  // above it would silently slide a fixed scrollTop off target, and the shot
  // would keep passing while framing something else.
  await page.locator('.settings__group-title', { hasText: '行为' }).scrollIntoViewIfNeeded();
  await page.waitForTimeout(250);
  await expect(page).toHaveScreenshot('persona-edit-behavior.png', { fullPage: false });
});

test('red packet detail (手气榜)', async ({ page }) => {
  await page.goto('/#/chats');
  await page.waitForTimeout(600);
  await page.goto('/#/rp/rp_seed_group');
  await settle(page);
  await expect(page).toHaveScreenshot('rp-detail.png', { fullPage: false });
});
