import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Regression for a false accusation the diagnosis page printed on a real
 * device-adjacent run: opened in a plain browser (the GitHub Pages build), it
 * labelled stage ② "原生通道（App 发请求走的路）" and, when that stage failed,
 * concluded "是 App 的问题".
 *
 * That verdict is unreachable-by-construction wrong in a browser. `httpJson()`
 * only uses the native bridge when Capacitor reports a native platform; in a
 * browser it silently falls back to `fetch`. So stage ② there is a
 * CORS-constrained fetch — and for any provider that serves no CORS headers
 * (OpenCode Zen: its OPTIONS preflight 404s) it fails 100% of the time while
 * stage ②b's `no-cors` reachability probe succeeds. Every browser run of the
 * diagnosis therefore blamed the App.
 *
 * These tests pin both halves: the browser must NOT blame the App, and the
 * native path must keep its original verdict.
 */

const probeCatalog = vi.fn();
let native = false;

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => native },
}));

vi.mock('../../src/llm/presets', () => ({
  PRESETS: {},
  makeProvider: () => ({ probeCatalog }),
}));

vi.mock('../../src/lib/keystore', () => ({
  getSecret: vi.fn(async () => 'sk-test-not-a-real-key'),
}));

vi.mock('../../src/db/repo', () => ({ repo: {} }));

import { diagnoseProvider } from '../../src/llm/service';
import type { ProviderVM } from '../../src/data/types';

const vm = {
  id: 'p1',
  kind: 'zen',
  label: 'OpenCode Zen',
  baseUrl: 'https://opencode.ai/zen/v1',
  models: ['deepseek-v4-flash-free'],
  keyAlias: 'alias',
} as unknown as ProviderVM;

beforeEach(() => {
  probeCatalog.mockReset();
  // The exact shape of the reported failure: catalog GET blocked, host reachable.
  probeCatalog.mockResolvedValue({ ok: false, models: [], error: 'Failed to fetch' });
  // Stage ②b probes reachability with a no-cors fetch, which resolves opaquely.
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('diagnoseProvider transport labelling', () => {
  it('in a browser, never blames the App for a CORS-blocked catalog', async () => {
    native = false;
    const lines = await diagnoseProvider(vm);
    const text = lines.join('\n');

    expect(text).not.toContain('是 App 的问题');
    expect(text).toContain('浏览器 fetch 通道');
    expect(text).not.toContain('原生通道');
    // It must say why the split proves nothing here, and where the real test is.
    expect(text).toContain('没有原生桥可测');
    expect(text).toMatch(/CORS/);
  });

  it('surfaces the real failure reason instead of a bare 无目录', async () => {
    native = false;
    const text = (await diagnoseProvider(vm)).join('\n');
    // The old code collapsed every failure into null -> "无目录", which cannot
    // distinguish CORS from 401 from a timeout from an empty catalog.
    expect(text).toContain('Failed to fetch');
    expect(text).not.toContain('无目录');
  });

  it('propagates an HTTP status when the catalog answers with an error code', async () => {
    native = true;
    probeCatalog.mockResolvedValue({ ok: false, models: [], status: 401, error: 'HTTP 401' });
    const text = (await diagnoseProvider(vm)).join('\n');
    expect(text).toContain('HTTP 401');
  });

  it('on native, keeps the original "App 的问题" verdict', async () => {
    native = true;
    const text = (await diagnoseProvider(vm)).join('\n');
    expect(text).toContain('原生通道（App 发请求走的路）');
    expect(text).toContain('是 App 的问题');
  });

  it('on native, a working catalog does not trigger any transport verdict', async () => {
    native = true;
    probeCatalog.mockResolvedValue({ ok: true, models: ['a', 'b'], status: 200 });
    const text = (await diagnoseProvider(vm)).join('\n');
    expect(text).toContain('目录 2 个');
    expect(text).not.toContain('是 App 的问题');
  });
});
