import type { Page } from '@playwright/test';

/**
 * Shared golden-screenshot plumbing (extracted from shell.spec.ts in M-I11 so
 * pages.spec.ts uses the SAME settle semantics — two copies would drift and a
 * drifted settle produces flaky goldens, which teach you to ignore the gate).
 */
export async function settle(page: Page) {
  // Wait for the route transition to finish first (M-H3).
  //
  // Two route trees are on screen while a page slides in, which is the whole
  // point of the transition — and it means the outgoing page's controls are
  // still queryable. Without this a `getByLabel('搜索')` matched the button on
  // the page being LEFT as well as the input on the page being entered.
  await page
    .waitForFunction(() => !document.querySelector('.page-stack--busy'), null, { timeout: 3000 })
    .catch(() => {});

  // Wait for fonts + layout to settle so pixels are stable.
  await page.evaluate(() => document.fonts.ready);

  // Then wait for the page to stop CHANGING.
  //
  // A fixed delay stopped being a settle point in M-G2: a chat thread loads
  // from IndexedDB when the page opens, photos are materialized on demand, and
  // the anchoring scroll runs in an effect after React commits. Each of those
  // lands on its own schedule, so under parallel workers a fixed wait captured
  // a half-built page maybe one run in three — and a flaky golden is worse
  // than no golden, because it teaches you to ignore the gate.
  //
  // Quiescence is the honest condition: the DOM has stopped growing and
  // nothing is still scrolling. It does not care WHICH async thing was late.
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const sample = () => {
          const el = document.querySelector('[data-thread-ready], .moments__scroll, .app-shell');
          return [
            document.body.innerHTML.length,
            el?.scrollTop ?? 0,
            el?.scrollHeight ?? 0,
            document.querySelectorAll('img').length,
          ].join(':');
        };
        let last = sample();
        let stable = 0;
        const deadline = performance.now() + 4000;
        const tick = () => {
          const now = sample();
          stable = now === last ? stable + 1 : 0;
          last = now;
          // Three consecutive quiet samples ≈ 150ms of no change.
          if (stable >= 3 || performance.now() > deadline) return resolve();
          setTimeout(tick, 50);
        };
        setTimeout(tick, 50);
      }),
  );

  // Quiescence says "nothing is changing"; it does not say "the chat is
  // anchored". A thread that settled one frame short of the bottom is stable
  // AND wrong, so assert the invariant the shot depends on. Safe to combine
  // now that `data-thread-ready` is derived from the store — an empty
  // container can no longer satisfy "at bottom" before the messages exist.
  const ready = page.locator('[data-thread-ready="1"]');
  if (await ready.count()) {
    await ready.evaluate(
      (el) =>
        new Promise<void>((resolve) => {
          const deadline = performance.now() + 3000;
          const tick = () => {
            const off = el.scrollHeight - el.scrollTop - el.clientHeight;
            if (off <= 2 || performance.now() > deadline) return resolve();
            el.scrollTop = el.scrollHeight;
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
    );
  }
  await page.waitForTimeout(100);
}

/**
 * The app renders real wall-clock time (M-B fixed the frozen-clock bug), so
 * golden determinism now lives here: pin Date at the seed-data epoch. Timers
 * keep running — only Date.now()/new Date() are fixed.
 */
export const SEED_EPOCH = 1_754_500_000_000; // ~2025-08-06, same base as src/data/seed.ts
