import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 「写了没接线 = 没做」(constitution 3.5) — the repo's signature failure mode,
 * now with a native twist: Kotlin code that no JS ever drives, or JS wrappers
 * no page ever mounts, would pass every other test. These assertions go RED if
 * any M-I10 surface is unplugged, and RED if the CI workflows drift back to
 * regenerating android/ from the template (which would silently drop every
 * hand-written native file from the APK).
 */
const ROOT = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

describe('native wiring (M-I10)', () => {
  it('the reply queue is drained on the foreground path', () => {
    const src = read('src/app/useSchedulerRuntime.ts');
    expect(src).toMatch(/from '\.\.\/native\/reply-drain'/);
    expect(src).toMatch(/drainNativeReplies\(\)/);
  });

  it('the widget is fed on foreground AND on backgrounding', () => {
    const src = read('src/app/useSchedulerRuntime.ts');
    expect(src).toMatch(/from '\.\.\/native\/widget-sync'/);
    expect(src).toMatch(/onBackground:.*syncWidget/s);
  });

  it('the background watcher (notification/bubble/call) is started with the scheduler', () => {
    const src = read('src/app/useSchedulerRuntime.ts');
    expect(src).toMatch(/startBackgroundNotify\(\)/);
    // …and stopped on teardown, or a hot remount would double-notify.
    expect(src).toMatch(/stopBackgroundNotify\(\)/);
  });

  it('deep links are mounted inside the router', () => {
    const app = read('src/App.tsx');
    expect(app).toMatch(/<DeepLinkBridge \/>/);
    expect(app).toMatch(/useDeepLinks/);
    // The two M-I10 pages are reachable:
    expect(app).toMatch(/\/settings\/native/);
    expect(app).toMatch(/\/settings\/battery/);
  });

  it('CallPage really implements the incoming side the deep link promises', () => {
    const call = read('src/features/call/CallPage.tsx');
    expect(call).toMatch(/incoming/);
    expect(call).toMatch(/'接听'|aria-label="接听"/);
    expect(call).toMatch(/direction: incoming \? 'in' : 'out'/);
  });

  it('CI builds from the COMMITTED android/, never `cap add` (would drop our Kotlin)', () => {
    for (const wf of [
      '.github/workflows/release.yml',
      '.github/workflows/device-test.yml',
      '.github/workflows/apk-remote.yml',
    ]) {
      const y = read(wf);
      expect(y, `${wf} must not regenerate android/`).not.toMatch(/cap add android/);
      expect(y, `${wf} must sync the committed android/`).toMatch(/cap sync android/);
    }
  });

  it('the committed native project actually contains the M-I10 Kotlin layer', () => {
    const base = 'android/app/src/main/java/com/personal/weixinai';
    for (const f of [
      'MainActivity.kt',
      'aiwx/AiwxNativePlugin.kt',
      'aiwx/BubbleService.kt',
      'aiwx/ReplyReceiver.kt',
      'aiwx/ReplyQueue.kt',
      'aiwx/Notifier.kt',
      'aiwx/AiwxWidgetProvider.kt',
    ]) {
      expect(() => read(`${base}/${f}`), `${f} missing`).not.toThrow();
    }
    // The manifest declares every component the Kotlin layer needs:
    const manifest = read('android/app/src/main/AndroidManifest.xml');
    for (const needle of [
      'SYSTEM_ALERT_WINDOW',
      'USE_FULL_SCREEN_INTENT',
      'REQUEST_IGNORE_BATTERY_OPTIMIZATIONS',
      'POST_NOTIFICATIONS',
      '.aiwx.BubbleService',
      '.aiwx.ReplyReceiver',
      '.aiwx.AiwxWidgetProvider',
      'android:scheme="aiwx"',
    ]) {
      expect(manifest).toContain(needle);
    }
  });

  it('generated gradle files stay OUT of git (machine-specific pnpm paths)', () => {
    const ignore = read('android/.gitignore');
    expect(ignore).toMatch(/^capacitor\.settings\.gradle$/m);
    expect(ignore).toMatch(/^app\/capacitor\.build\.gradle$/m);
  });
});
