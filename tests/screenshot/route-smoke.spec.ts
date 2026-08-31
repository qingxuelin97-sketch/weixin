import { test, expect } from '@playwright/test';
import { smokePaths, smokeSkips } from '../lib/route-ledger';

/**
 * 每条路由都能起来 (M-I18; ledger-derived since M-J0).
 *
 * The golden suite proves pages LOOK right, but only for routes that have a
 * golden; the route ledger lets a route be exempt from one, and an exempt route
 * that white-screens is invisible to every other gate. Unit tests cannot see it
 * either — the crash is in React, at runtime, in a production build.
 *
 * That failure mode is the one the constitution warns about by name: a zustand
 * selector returning a fresh array makes `useSyncExternalStore` loop forever and
 * the production build renders nothing (React #185). It has happened here, and
 * the symptom is a blank screen on ONE page while every test stays green.
 *
 * So this walks every route the ledger lists and asserts three things a real
 * user would notice immediately: no unhandled exception, no console error, and
 * the body is not empty.
 *
 * The URLs come from tests/lib/route-ledger.ts — the SAME ledger the golden
 * suite audits. This file must not keep a route list of its own (a unit guard
 * in route-goldens.test.ts checks exactly that): a route added to the app gets
 * onto this walk by getting a ledger row, or the ledger tests go red first.
 */

/**
 * The browser asks for /favicon.ico on its own and this app ships none — a
 * Capacitor WebView never makes that request, so it is noise here rather than a
 * missing asset. Anything ELSE that 404s is a real broken reference.
 */
const isFaviconNoise = (text: string) =>
  text.includes('Failed to load resource') && !text.includes('assets/');

test('every route boots: no crash, no console error, no blank screen', async ({ page }) => {
  const problems: string[] = [];
  let current = '';
  page.on('console', (m) => {
    if (m.type() === 'error' && !isFaviconNoise(m.text())) {
      problems.push(`console.error @ ${current}: ${m.text().slice(0, 300)}`);
    }
  });
  page.on('pageerror', (e) => problems.push(`pageerror @ ${current}: ${String(e).slice(0, 300)}`));

  for (const route of smokePaths()) {
    current = route;
    await page.goto(`/#${route}`);
    await page.waitForTimeout(450);
    const text = (await page.locator('body').innerText().catch(() => '')) ?? '';
    if (text.trim().length === 0) problems.push(`BLANK PAGE: ${route}`);
  }

  for (const { route, reason } of smokeSkips()) {
    console.log(`[route-smoke] skipped ${route}: ${reason}`);
  }

  expect(problems, '有路由起不来——白屏或运行期异常，其它门禁都看不见这一类').toEqual([]);
});
