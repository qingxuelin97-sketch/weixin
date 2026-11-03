import { test, expect } from '@playwright/test';
import { settle, SEED_EPOCH } from './helpers';

/**
 * 深色模式 golden (M-K0)。
 *
 * 走的是默认的「跟随系统」路径：只把浏览器的 prefers-color-scheme 切成 dark，
 * 不碰 localStorage——于是 index.html 的首帧脚本与 lib/theme.ts 的解析都在被测
 * 范围内。挑的是每天都会看见的面：四个 tab、单聊、朋友圈、设置、零钱。
 *
 * 深色色值目前以 WeUI 深色色板为准（还没有真机深色截图）；这些基线守的是
 * 「token 层没有漏表态」——一个漏掉的语义 token 在这里会是一块亮白补丁。
 */
test.use({ colorScheme: 'dark' });

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(SEED_EPOCH);
});

const DARK_SHOTS: Array<[name: string, path: string]> = [
  ['dark-chat-list', '/chats'],
  ['dark-chat-single', '/chat/conv_lin'],
  ['dark-contacts', '/contacts'],
  ['dark-discover', '/discover'],
  ['dark-me', '/me'],
  ['dark-moments-feed', '/moments'],
  ['dark-settings', '/settings'],
  ['dark-wallet', '/wallet'],
  // 带开关的页 (M-K12)：深色下的开关圆钮曾借 cell 底色（#191919），是一颗黑扣子，
  // 关着时几乎看不见——而上面没有一张深色基线里有开关，门禁看不见它。
  ['dark-settings-notify', '/settings/notify'],
];

for (const [name, path] of DARK_SHOTS) {
  test(`dark: ${name}`, async ({ page }) => {
    await page.goto(`/#${path}`);
    await settle(page);
    await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: false });
  });
}

test('首帧就是深色：data-theme 在任何应用代码运行之前已写好', async ({ page }) => {
  // 只能靠拦掉应用包来证明：module 脚本是 defer 的，会在 DOMContentLoaded **之前**
  // 跑完——不拦的话 theme.ts 自己也会把 data-theme 写好，删掉首帧脚本这条照样绿
  // （第一版就是这么写的，变异验证时才发现它什么也没守）。拦掉之后，能写这个
  // 属性的只剩 index.html 里那段同步脚本——深色手机冷启动不闪白靠的正是它。
  await page.route('**/assets/*.js', (r) => r.abort());
  await page.goto('/#/chats', { waitUntil: 'domcontentloaded' });
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
});

test('手动选了普通模式就压过系统深色', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('ui.theme', 'light'));
  await page.goto('/#/chats');
  await settle(page);
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light');
});
