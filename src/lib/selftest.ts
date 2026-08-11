/**
 * Device transport self-test (M-E device loop).
 *
 * The real-device bug has survived several rounds for one reason: every symptom
 * came back through a human as a one-line report ("无效", "没报错"), which is
 * debugging over a telephone. This module makes the DEVICE report — the same
 * build that runs on the user's phone runs in a CI emulator, and both speak
 * the same machine-readable line.
 *
 * The probe is KEYLESS by design. Hitting each provider origin with a bogus
 * bearer token cannot succeed as an API call, but that is exactly the point:
 * any HTTP status coming back — 401, 404, anything — proves DNS + TLS + HTTP
 * + (for the WebView channel) CORS all worked end to end. Only a thrown fetch
 * ("failed to fetch", timeout) means the transport itself is broken. So the
 * matrix {endpoint × channel → status|error} is obtainable with no secrets,
 * in CI and on the user's phone alike.
 *
 * DELIBERATELY self-contained: it does not reuse `llm/http.ts`. That module
 * blends the two channels (primary + fallback), and the whole question here is
 * which CHANNEL works. A diagnostic must not share the code under suspicion.
 *
 * Output goes three places:
 *   1. `console.log('AIWX-SELFTEST ' + json)` — Capacitor forwards WebView
 *      console lines to logcat in debug builds, so CI greps logcat for it.
 *   2. A settings row, so EnvDiagPage shows the latest matrix on a real phone.
 *   3. The return value, for anything that wants to await it.
 */
import { Capacitor } from '@capacitor/core';
import { repo } from '../db/repo';
import { logError } from './errlog';

/** The three preset origins. Kept literal — this file must not import presets
 *  (which pull in the provider machinery this test exists to bypass). */
const TARGETS = [
  { id: 'deepseek', url: 'https://api.deepseek.com/models' },
  { id: 'minimax', url: 'https://api.minimaxi.com/v1/models' },
  { id: 'zen', url: 'https://opencode.ai/zen/v1/models' },
] as const;

export interface ProbeOutcome {
  /** HTTP status when the request completed; the error text when it did not. */
  status?: number;
  error?: string;
  ms: number;
}

export interface SelftestReport {
  at: number;
  platform: string;
  origin: string;
  online: boolean;
  /** endpoint id → channel → outcome */
  results: Record<string, { webFetch: ProbeOutcome; bridge: ProbeOutcome }>;
  /** The verdict CI asserts on: every endpoint reachable via ≥1 channel. */
  allReachable: boolean;
}

export const SELFTEST_SETTING_KEY = 'lastSelftest';
/** The grep target. One token, never reworded — CI and EnvDiag both key on it. */
export const SELFTEST_TAG = 'AIWX-SELFTEST';

const PROBE_TIMEOUT_MS = 10_000;

/** WebView-fetch channel: subject to CORS, aborted by a real timer. */
async function probeWebFetch(url: string): Promise<ProbeOutcome> {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Authorization: 'Bearer selftest-invalid-key' },
      signal: ctrl.signal,
    });
    return { status: res.status, ms: Date.now() - t0 };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}

/** Native-bridge channel. Raced against a REJECTING timer — the bridge cannot
 *  be aborted from JS, and a bare await on a hung bridge waits forever
 *  (the original "测试连接卡死" bug, re-learned once already). */
async function probeBridge(url: string): Promise<ProbeOutcome> {
  const t0 = Date.now();
  try {
    const mod = await import('@capacitor/core');
    const native = (
      mod as unknown as {
        CapacitorHttp: { request: (o: unknown) => Promise<{ status: number }> };
      }
    ).CapacitorHttp;
    const res = await Promise.race([
      native.request({
        url,
        method: 'GET',
        headers: { Authorization: 'Bearer selftest-invalid-key' },
        connectTimeout: PROBE_TIMEOUT_MS,
        readTimeout: PROBE_TIMEOUT_MS,
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`bridge timeout ${PROBE_TIMEOUT_MS}ms`)), PROBE_TIMEOUT_MS + 2_000),
      ),
    ]);
    return { status: res.status, ms: Date.now() - t0 };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 };
  }
}

/** An outcome counts as "the transport works" iff an HTTP status came back. */
export function reachable(o: ProbeOutcome): boolean {
  return typeof o.status === 'number';
}

/** Run the full matrix. Pure I/O, no app state touched beyond the report row. */
export async function runSelftest(now: number): Promise<SelftestReport> {
  const results: SelftestReport['results'] = {};
  // Sequential per endpoint (channels in parallel): six concurrent sockets on
  // a cold WebView have produced flaky timeouts that read as failures.
  for (const t of TARGETS) {
    const [webFetch, bridge] = await Promise.all([probeWebFetch(t.url), probeBridge(t.url)]);
    results[t.id] = { webFetch, bridge };
  }
  const report: SelftestReport = {
    at: now,
    platform: Capacitor.isNativePlatform() ? Capacitor.getPlatform() : 'web',
    origin: typeof location !== 'undefined' ? location.origin : '',
    online: typeof navigator !== 'undefined' ? navigator.onLine : true,
    results,
    allReachable: TARGETS.every((t) => {
      const r = results[t.id];
      return reachable(r.webFetch) || reachable(r.bridge);
    }),
  };

  // One line, one token, machine-readable — CI's grep and nothing else.
  try {
    console.log(`${SELFTEST_TAG} ${JSON.stringify(report)}`);
  } catch {
    /* console must never break the app */
  }
  try {
    await repo.putSetting(SELFTEST_SETTING_KEY, report);
  } catch (e) {
    logError('selftest.store', e);
  }
  return report;
}

let scheduled = false;

/**
 * Arm the self-test on a native cold start. A few seconds after mount so it
 * never competes with hydration; once per process. Web builds skip it — the
 * browser is the environment that already works, and probing from there would
 * only add CORS noise to the report the user sees.
 */
export function armSelftest(): void {
  if (scheduled || !Capacitor.isNativePlatform()) return;
  scheduled = true;
  setTimeout(() => {
    void runSelftest(Date.now()).catch((e) => logError('selftest.run', e));
  }, 2_500);
}

/** The latest stored report, for EnvDiagPage. */
export async function getLastSelftest(): Promise<SelftestReport | undefined> {
  try {
    const row = await repo.getSetting<SelftestReport>(SELFTEST_SETTING_KEY);
    return row && typeof row.at === 'number' ? row : undefined;
  } catch {
    return undefined;
  }
}
