import { test, expect } from '@playwright/test';

/**
 * The hidden AI↔AI DM conversation must be invisible on every user surface —
 * chat list, unread badge, search — while its rows really exist in the DB.
 * Runs against the production build + real IndexedDB (backup-e2e pattern).
 */

/**
 * Plant a hidden DM conversation with one juicy message, as runAgentDm would.
 *
 * `isMuted: false` on purpose. It used to be true, which made the badge
 * assertion below unfalsifiable: muted threads are excluded for a completely
 * different reason, so the test would stay green with the `isHidden` rule
 * deleted. A hidden thread carrying unread is the normal state anyway —
 * `bumpUnread` runs on the ordinary append path and knows nothing about
 * hiding.
 */
const PLANT_DM = `
  new Promise((resolve, reject) => {
    const req = indexedDB.open('weixin-ai');
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(['conversations', 'messages'], 'readwrite');
      tx.objectStore('conversations').put({
        id: 'dm_ai_ada_ai_lin', type: 'single', title: '林小雨、Ada',
        avatarColor: '#000', avatarText: '雨', memberIds: ['ai_ada', 'ai_lin'],
        isPinned: false, isMuted: false, isHidden: true,
        unreadCount: 99, mentionMe: false,
        lastMsgPreview: '这句私聊绝不能被看到', lastMsgAt: Date.now(),
      });
      tx.objectStore('messages').add({
        convId: 'dm_ai_ada_ai_lin', senderId: 'ai_lin', type: 'text',
        content: '这句私聊绝不能被看到', status: 'sent', createdAt: Date.now(),
      });
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    };
  })
`;

test('a hidden DM is absent from list, badge and search — but present in the DB', async ({ page }) => {
  await page.goto('/#/chats');
  await page.waitForTimeout(800); // hydrate seeds

  // The badge BEFORE planting is the reference. A hard-coded number would only
  // assert what the seed happens to contain today.
  const tabBadge = page.locator('.tabbar__badge');
  const listTitle = page.locator('.navbar__title').first();
  const read = async () => ({
    badge: (await tabBadge.count()) ? ((await tabBadge.first().innerText()) ?? '').trim() : '',
    title: ((await listTitle.innerText().catch(() => '')) ?? '').trim(),
  });
  const before = await read();

  await page.evaluate(PLANT_DM);
  // Reload so hydrate() picks the planted conversation up like a real boot.
  await page.reload();
  await page.waitForTimeout(800);

  // 1) Chat list: the DM row must not render.
  await expect(page.getByText('林小雨、Ada')).toHaveCount(0);
  await expect(page.getByText('这句私聊绝不能被看到')).toHaveCount(0);

  // 1.5) The unread badge: 99 unread on a hidden thread must move NOTHING —
  // neither the tab badge nor the 微信(N) title on the list. This is the
  // permanently-on-screen leak the other assertions do not cover: search needs
  // a query that happens to hit the DM, the badge is on screen always.
  const after = await read();
  expect(after, '隐藏会话的未读漏进了角标/标题——泄漏即穿帮').toEqual(before);
  // Belt and braces, independent of the seed: the leak adds 99, and Badge caps
  // its display at 99 — so a leaked total renders as "99+" whatever the seed is.
  expect(after.badge).not.toContain('99');
  expect(Number(after.badge || '0')).toBeLessThan(99);

  // 2) Search: neither the title nor the message text may surface.
  await page.getByLabel('搜索').first().click();
  await page.getByPlaceholder('搜索').fill('绝不能被看到');
  await expect(page.getByText(/没有找到/)).toBeVisible();
  await expect(page.locator('.search__row')).toHaveCount(0);

  // 3) The rows genuinely exist — invisibility is filtering, not data loss.
  const inDb = await page.evaluate(`
    new Promise((resolve) => {
      const req = indexedDB.open('weixin-ai');
      req.onsuccess = () => {
        const tx = req.result.transaction(['conversations','messages'], 'readonly');
        const g = tx.objectStore('conversations').get('dm_ai_ada_ai_lin');
        g.onsuccess = () => {
          const all = tx.objectStore('messages').getAll();
          all.onsuccess = () => resolve({
            conv: Boolean(g.result?.isHidden),
            msg: all.result.some((m) => m.convId === 'dm_ai_ada_ai_lin'),
          });
        };
      };
    })
  `);
  expect(inDb).toEqual({ conv: true, msg: true });
});
