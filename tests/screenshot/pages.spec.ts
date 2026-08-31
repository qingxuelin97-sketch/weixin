import { test, expect } from '@playwright/test';
import { settle, SEED_EPOCH } from './helpers';

/**
 * Golden coverage for every route shell.spec.ts left out (M-I11). One shot per
 * page, seeded state, clock pinned at the seed epoch — the same discipline as
 * the core screens. The route ledger (tests/lib/route-ledger.ts) turns
 * red when a route exists with neither a golden here nor a recorded exemption,
 * so a new page cannot silently ship outside the gate.
 */

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(SEED_EPOCH);
});

const SHOTS: Array<[name: string, path: string]> = [
  ['profile', '/profile'],
  ['favorites', '/favorites'],
  ['story-list', '/story'],
  ['report', '/report'],
  ['contact-profile', '/contact/ai_lin'],
  ['status', '/status/ai_lin'],
  ['memory', '/memory/ai_lin'],
  ['chat-info', '/chat/conv_lin/info'],
  ['moments-album', '/moments/album/ai_lin'],
  ['settings-worldbook', '/settings/worldbook'],
  ['settings-usage', '/settings/usage'],
  ['settings-prompt-lab', '/settings/prompt-lab'],
  ['settings-media', '/settings/media'],
  ['settings-native', '/settings/native'],
  ['settings-battery', '/settings/battery'],
  ['settings-asr', '/settings/asr'],
  ['settings-tts', '/settings/tts'],
  ['settings-notify-test', '/settings/notify-test'],
  ['moment-detail', '/moments/mo_seed_lin'],
];

for (const [name, path] of SHOTS) {
  test(`page: ${name}`, async ({ page }) => {
    await page.goto(`/#${path}`);
    await settle(page);
    await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: false });
  });
}
