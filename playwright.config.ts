import { defineConfig, devices } from '@playwright/test';
import { existsSync, readdirSync } from 'node:fs';

/**
 * Resolve a pre-installed full Chromium binary. In this managed environment the
 * browser is provided under PLAYWRIGHT_BROWSERS_PATH but may be a different build
 * number than the installed @playwright/test pins, so we point at it directly
 * instead of downloading. Falls back to Playwright's own resolution locally.
 */
function resolveChromium(): string | undefined {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !existsSync(root)) return undefined;
  const dir = readdirSync(root).find((d) => d.startsWith('chromium-'));
  if (!dir) return undefined;
  const bin = `${root}/${dir}/chrome-linux/chrome`;
  return existsSync(bin) ? bin : undefined;
}
const chromiumPath = resolveChromium();

/**
 * Screenshot golden pipeline. Renders the app in headless Chromium at a fixed
 * 390×844 @3x (the calibration device frame) so goldens are byte-stable. The
 * same engine ships in the Android WebView, so CI pixels ≈ device pixels —
 * PROVIDED the CI container has the same CJK font as the device (see specs).
 *
 * These goldens are the AI's self-check filter; the final 1:1 verdict is the
 * user's real-device screenshot overlay.
 */
export default defineConfig({
  testDir: './tests/screenshot',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  expect: {
    toHaveScreenshot: {
      // Tight on purpose. Goldens are saved CSS-scaled (390×844 ≈ 329k px), so the
      // old 1% ratio allowed ~3.3k differing pixels — a changed word (~100px) hid
      // under it completely, which is exactly the regression these exist to catch.
      // `threshold` is the per-pixel color tolerance; the 0.2 default discounts
      // anti-aliased glyph edges, so it has to come down too or text changes slip by.
      // Rendering inside one container is deterministic, so this is stable; the CI
      // screenshot job stays advisory for cross-environment font differences.
      threshold: 0.1,
      maxDiffPixels: 40,
    },
  },
  use: {
    baseURL: 'http://localhost:4173',
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 390, height: 844 },
        deviceScaleFactor: 3,
        launchOptions: chromiumPath ? { executablePath: chromiumPath } : {},
      },
    },
  ],
  webServer: {
    command: 'pnpm build && pnpm preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
