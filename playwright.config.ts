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
 * PROVIDED the renderer matches: same CJK font AND same Chromium build.
 *
 * That second half is why `resolveChromium()` above matters more than it looks.
 * This container supplies its own Chromium under PLAYWRIGHT_BROWSERS_PATH, a
 * different build from the one `playwright install` pins in CI, and two builds
 * rasterize glyph edges differently. Baselines generated here therefore CANNOT
 * match CI even with identical fonts — measured: 30 of 52 shots red. So the
 * committed goldens are minted by CI's own `regen-goldens` job, and a local
 * `test:screenshot` run is a fast smoke check, not the gate.
 *
 * These goldens are the AI's self-check filter; the final 1:1 verdict is the
 * user's real-device screenshot overlay.
 */
export default defineConfig({
  testDir: './tests/screenshot',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // In CI the github reporter annotates the run, but it writes NO files — so the
  // "upload playwright-report/" step silently uploaded nothing for the whole
  // life of the job, and a red golden could not be looked at. The html reporter
  // rides alongside it to make the artifact real (M-I11).
  reporter: process.env.CI
    ? [['github'], ['html', { outputFolder: 'playwright-report', open: 'never' }]]
    : 'list',
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
