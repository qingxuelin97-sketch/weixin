import { test, expect, type Page } from '@playwright/test';
import { smokePaths } from '../lib/route-ledger';

/**
 * 走查门禁 (M-L0)：三个探测器走遍路由台账里的每一条路由。
 *
 * golden 只拍得到有 golden 的那一屏、那一种状态；这三类问题却是**每一屏、每一种
 * 字号与主题**都可能有的，而且都不报错：
 *
 * 1. **深色亮补丁**：深色下一块还是浅色底的区域（某个语义 token 在深色块里漏了表态）。
 * 2. **横向溢出**：最大字号（1.75×）× 320 宽的窄屏上，任何滚动容器变成可以横滑——
 *    整页能左右晃，或者一段内容被挤出屏幕。
 * 3. **文字纵向裁切**：同样的最大字号下，定高的盒子把变大的字切掉一截。
 *
 * M-K 收官时这三个探测器作为一次性脚本跑过 70 条路由，结果几乎全零——那正说明它们该
 * 变成门禁：此刻的干净要靠它们一直保持。每一趟开头先在一条路由上**注入一个故意坏掉的
 * 对照元素**，断言探测器真的会报——否则选择器写错、页面结构一变，门禁就会安安静静地
 * 永远为绿（K-round 写这几个探测器时，前两版正是这样：一版被自己的排除规则吃掉了对照，
 * 一版的对照在 flex 行里被压缩到根本不溢出）。
 *
 * 路由清单只来自 tests/lib/route-ledger.ts，和冒烟走查同一份（守卫在 route-goldens.test.ts）。
 */

/**
 * 深色下有意保持浅色的小部件（按类名），每一条写明为什么。它们的 token 在深色下
 * 仍是浅色——开关圆钮 `--color-switch-knob` 登记为深浅一致（白），滑杆圆钮
 * `--color-slider-thumb` 在深色块里取 `--wxd-fg-0`（白 80%）——这里只是让探测器认得它们。
 */
const INTENDED_LIGHT: Record<string, string> = {
  slider__thumb: '滑杆圆钮深浅都是白（WeUI 同款），落在深色轨道上本来就该亮',
  'step-slider__thumb': '分档滑杆（字体大小）的圆钮，同上',
  switch__knob: '开关圆钮深浅都是白（M-K12），同上',
};

/** 有意横向滚动的容器（按类名），每一条写明为什么它本来就该能横滑。 */
const INTENDED_HSCROLL: Record<string, string> = {
  favorites__filters: '收藏页的类型筛选条：九个类型的胶囊排成一行横滑，微信同款',
  sgraph: '剧情页的节点图：图天然比屏宽，横滑看全图',
};

/* ------------------------- 探测器（在页面里执行） ------------------------- */
// page.evaluate 序列化函数源码：这几个函数不许引用任何外部变量。

function lightPatches(intended: string[]): string[] {
  const out: string[] = [];
  const lum = (c: string) => {
    const m = c.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const [r, g, b, a = 1] = m[1].split(',').map((x) => parseFloat(x));
    if (a < 0.6) return null;
    return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  };
  const root = document.querySelector('.page-stack__page:last-child') ?? document.body;
  for (const el of [root, ...root.querySelectorAll('*')]) {
    const L = lum(getComputedStyle(el).backgroundColor);
    if (L == null || L < 0.8) continue;
    const r = el.getBoundingClientRect();
    if (r.width * r.height < 600 || r.bottom < 0 || r.top > innerHeight) continue;
    // Data-driven colours (avatars, photo placeholders, chat backgrounds) are
    // content, painted inline — not a token that forgot its dark value.
    if (el.closest('img, svg, [style*="background"], [class*="avatar"]')) continue;
    const cls = typeof el.className === 'string' && el.className ? el.className.split(' ')[0] : el.tagName;
    if (intended.includes(cls)) continue;
    out.push(`亮补丁 .${cls} ${Math.round(r.width)}×${Math.round(r.height)}`);
  }
  return [...new Set(out)];
}

function overflows(intended: string[]): string[] {
  const out: string[] = [];
  const W = innerWidth;
  const root = document.querySelector('.page-stack__page:last-child') ?? document.body;
  const first = (el: Element) =>
    typeof el.className === 'string' && el.className ? el.className.split(' ')[0] : el.tagName;
  for (const el of [root, ...root.querySelectorAll('*')]) {
    if (!/(auto|scroll)/.test(getComputedStyle(el).overflowX)) continue;
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    if (intended.includes(first(el))) continue;
    // Name the culprit: the descendant reaching furthest right.
    let worst: Element | null = null;
    let right = 0;
    for (const c of el.querySelectorAll('*')) {
      const r = c.getBoundingClientRect();
      if (r.width > 0 && r.right > right) {
        right = r.right;
        worst = c;
      }
    }
    out.push(`可横滑 .${first(el)} ${el.scrollWidth}/${el.clientWidth}（最宽的是 .${worst ? first(worst) : '?'}）`);
  }
  for (const el of root.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || r.right <= W + 1) continue;
    if (getComputedStyle(el).position === 'fixed') continue;
    let clipped = false;
    for (let a = el.parentElement; a; a = a.parentElement) {
      if (getComputedStyle(a).overflowX !== 'visible') {
        clipped = true;
        break;
      }
    }
    if (!clipped) out.push(`出屏 .${first(el)} right=${Math.round(r.right)}`);
  }
  return [...new Set(out)];
}

function clippedText(): string[] {
  const out: string[] = [];
  const root = document.querySelector('.page-stack__page:last-child') ?? document.body;
  for (const el of root.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (!/(hidden|clip)/.test(cs.overflowY)) continue;
    if (cs.webkitLineClamp && cs.webkitLineClamp !== 'none') continue; // an intended clamp
    const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim());
    if (!ownText || el.scrollHeight <= el.clientHeight + 2) continue;
    if (!el.getBoundingClientRect().height) continue;
    const cls = typeof el.className === 'string' && el.className ? el.className.split(' ')[0] : el.tagName;
    out.push(`字被切 .${cls} ${el.scrollHeight}/${el.clientHeight}「${(el.textContent ?? '').trim().slice(0, 10)}」`);
  }
  return [...new Set(out)];
}

/* ------------------------------ 走一遍 ------------------------------ */

async function visit(page: Page, route: string) {
  await page.goto(`/#${route}`);
  // The push transition keeps two pages mounted; scan only once it is over.
  await page
    .waitForFunction(() => !document.querySelector('.page-stack--busy'), null, { timeout: 3000 })
    .catch(() => {});
  await page.waitForTimeout(300);
}

/** Inject a deliberately broken element into the current page (a positive control). */
async function inject(page: Page, css: string, cls: string, text = '对照') {
  await page.evaluate(
    ({ css, cls, text }) => {
      const st = document.createElement('style');
      st.textContent = css;
      document.head.appendChild(st);
      const d = document.createElement('div');
      d.className = cls;
      d.textContent = text;
      const host =
        document.querySelector('.page-stack__page:last-child .settings__row') ??
        document.querySelector('.page-stack__page:last-child');
      host?.appendChild(d);
    },
    { css, cls, text },
  );
}

const CONTROL_ROUTE = '/settings/notify';

test.describe('深色走查', () => {
  test.use({ colorScheme: 'dark' });

  test('深色下没有一块亮补丁', async ({ page }) => {
    test.setTimeout(Math.max(30_000, smokePaths().length * 1_500));
    const intended = Object.keys(INTENDED_LIGHT);
    await visit(page, CONTROL_ROUTE);
    await inject(page, '.sweep-control-light{flex:none;width:200px;height:80px;background:#fff}', 'sweep-control-light');
    expect(await page.evaluate(lightPatches, intended), '亮补丁探测器认不出对照元素——门禁失明了').toContainEqual(
      expect.stringContaining('sweep-control-light'),
    );

    const problems: string[] = [];
    for (const route of smokePaths()) {
      await visit(page, route);
      for (const p of await page.evaluate(lightPatches, intended)) problems.push(`${route}  ${p}`);
    }
    expect(problems, '深色下还有浅色底——某个语义 token 在深色块里没表态').toEqual([]);
  });
});

test.describe('大字号 × 窄屏走查', () => {
  test.use({ viewport: { width: 320, height: 640 } });

  test('最大字号的 320 宽屏上：不横滑、不出屏、字不被切', async ({ page }) => {
    test.setTimeout(Math.max(30_000, smokePaths().length * 1_500));
    // The first-paint script reads this before the app runs (M-K5): every page
    // loads at the largest step, exactly as a user who set it would see it.
    await page.addInitScript(() => localStorage.setItem('ui.fontScale', '7'));
    const intended = Object.keys(INTENDED_HSCROLL);

    // One control per visit: two controls in one row would make each the other's
    // culprit (the overflow report names the descendant reaching furthest right).
    await visit(page, CONTROL_ROUTE);
    await inject(page, '.sweep-control-wide{flex:none;width:600px}', 'sweep-control-wide');
    expect(await page.evaluate(overflows, intended), '溢出探测器认不出对照元素——门禁失明了').toContainEqual(
      expect.stringContaining('最宽的是 .sweep-control-wide'),
    );
    await visit(page, CONTROL_ROUTE);
    await inject(page, '.sweep-control-clip{flex:none;height:16px;overflow:hidden;font-size:30px}', 'sweep-control-clip', '裁切');
    expect(await page.evaluate(clippedText), '裁切探测器认不出对照元素——门禁失明了').toContainEqual(
      expect.stringContaining('sweep-control-clip'),
    );

    const problems: string[] = [];
    for (const route of smokePaths()) {
      await visit(page, route);
      for (const p of await page.evaluate(overflows, intended)) problems.push(`${route}  ${p}`);
      for (const p of await page.evaluate(clippedText)) problems.push(`${route}  ${p}`);
    }
    expect(problems, '大字号或窄屏下有页面崩了版式').toEqual([]);
  });
});
