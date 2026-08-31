import { test, expect } from '@playwright/test';

/**
 * 朋友圈单条详情页 (M-J12) — behavioural checks against the production build
 * and real seeded IndexedDB, same discipline as search-e2e.spec.ts: semantic
 * assertions, no pixels. These are the two红线 the milestone names:
 *
 *   1. a nonexistent id renders the graceful empty state (a stale deep link
 *      must never white-screen or crash);
 *   2. a search hit on a Moment lands on THAT post's detail page — the URL
 *      carries the matched id, and the page shows the matched text.
 */

test('a nonexistent moment id renders the empty state, not a crash', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/#/moments/mo_definitely_not_real');
  await expect(page.getByText('这条动态不存在了')).toBeVisible();
  expect(errors).toEqual([]);
});

test('a search hit on a Moment opens the detail page with the matched id', async ({ page }) => {
  await page.goto('/#/chats');
  await page.waitForTimeout(800); // hydrate() seeds on first run
  await page.getByLabel('搜索').first().click();
  // 「收工」 appears only in the seeded post mo_seed_lin.
  await page.getByPlaceholder('搜索').fill('收工');
  await expect(page.getByText('朋友圈').first()).toBeVisible();
  await page.locator('.search__row').last().click();
  await expect(page).toHaveURL(/#\/moments\/mo_seed_lin$/);
  // Scoped to the card's own paragraph: during the push transition the search
  // page is still in the DOM, and its result row contains the same excerpt.
  await expect(page.locator('.moment__text')).toContainText('终于收工');
});

test('the detail page shows the post with its likes and comments in full', async ({ page }) => {
  await page.goto('/#/moments/mo_seed_lin');
  await page.waitForTimeout(800);
  await expect(page.getByText(/终于收工/)).toBeVisible();
  // Seeded social rows: likes from Ada and 陈叔 render in the reaction block.
  await expect(page.locator('.moment__likes')).toBeVisible();
  await expect(page.locator('.moment__comment').first()).toBeVisible();
});

test('tapping a post body in the feed opens its detail page', async ({ page }) => {
  await page.goto('/#/moments');
  await page.waitForTimeout(800);
  await page.getByText(/终于收工/).first().click();
  await expect(page).toHaveURL(/#\/moments\/mo_seed_lin$/);
});
