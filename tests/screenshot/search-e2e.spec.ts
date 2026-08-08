import { test, expect } from '@playwright/test';

/**
 * Behavioural checks for search against the production build and real seeded
 * IndexedDB — the golden screenshots prove it *renders*, these prove it *works*.
 * Same approach as backup-e2e.spec.ts: semantic assertions, no pixels.
 */

async function openSearch(page: import('@playwright/test').Page) {
  await page.goto('/#/chats');
  await page.waitForTimeout(800); // hydrate() seeds on first run
  await page.getByLabel('搜索').first().click();
  await expect(page).toHaveURL(/#\/search$/);
}

test('the conversation-list search button opens search', async ({ page }) => {
  await openSearch(page);
  await expect(page.getByPlaceholder('搜索')).toBeFocused();
});

test('finds a contact and opens their conversation', async ({ page }) => {
  await openSearch(page);
  await page.getByPlaceholder('搜索').fill('林小雨');
  await expect(page.getByText('联系人')).toBeVisible();
  await page.locator('.search__row').first().click();
  // A contact with an existing chat opens the chat, not the persona editor.
  await expect(page).toHaveURL(/#\/chat\//);
});

test('finds text inside a message and opens that conversation', async ({ page }) => {
  await openSearch(page);
  await page.getByPlaceholder('搜索').fill('咖啡');
  await expect(page.getByText('聊天记录')).toBeVisible();
  await page.locator('.search__row').first().click();
  await expect(page).toHaveURL(/#\/chat\//);
});

test('highlights the matched substring, not the whole field', async ({ page }) => {
  await openSearch(page);
  await page.getByPlaceholder('搜索').fill('咖啡');
  const marks = page.locator('.search__hit');
  await expect(marks.first()).toHaveText('咖啡');
});

test('reports no results rather than showing an empty page', async ({ page }) => {
  await openSearch(page);
  await page.getByPlaceholder('搜索').fill('zzz这个词不存在zzz');
  await expect(page.getByText(/没有找到/)).toBeVisible();
  await expect(page.locator('.search__row')).toHaveCount(0);
});

test('clearing the query returns to the prompt', async ({ page }) => {
  await openSearch(page);
  await page.getByPlaceholder('搜索').fill('咖啡');
  await expect(page.locator('.search__row').first()).toBeVisible();
  await page.getByLabel('清除').click();
  await expect(page.getByText('搜索聊天记录、联系人、朋友圈')).toBeVisible();
});
