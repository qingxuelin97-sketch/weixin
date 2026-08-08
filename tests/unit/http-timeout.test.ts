import { describe, it, expect, vi, afterEach } from 'vitest';
import { httpJson } from '../../src/llm/http';
import { LlmError } from '../../src/llm/types';

/**
 * Regression for real-device bug #4 ("测试连接永远卡着"): the native
 * CapacitorHttp bridge cannot be aborted from JS, and its old timeout guard
 * was an empty no-op — a hung plugin call awaited forever. These tests pin
 * the fix: the JS side enforces the deadline itself, so a request that never
 * settles MUST reject with a timeout instead of spinning eternally.
 */

vi.mock('@capacitor/core', () => ({
  CapacitorHttp: {
    // A bridge call that never settles — the pathological case from the device.
    request: vi.fn(() => new Promise(() => {})),
  },
}));

type G = { Capacitor?: { isNativePlatform?: () => boolean } };

afterEach(() => {
  delete (globalThis as G).Capacitor;
});

describe('httpJson on the native bridge', () => {
  it('rejects boundedly when fetch fails and the bridge never settles', async () => {
    (globalThis as G).Capacitor = { isNativePlatform: () => true };
    const t0 = Date.now();
    // New transport policy: fetch-first, bridge-fallback. When BOTH die the
    // error is kind 'network' and carries each channel's own message so
    // neither failure masks the other.
    await expect(
      httpJson({ url: 'https://api.example.test/v1/chat', timeoutMs: 80 }),
    ).rejects.toMatchObject({ name: 'LlmError', kind: 'network' });
    // Must fail around the deadline, not the 60s default and never "never".
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it('rejects promptly when the caller aborts mid-flight', async () => {
    (globalThis as G).Capacitor = { isNativePlatform: () => true };
    const ctrl = new AbortController();
    const p = httpJson({
      url: 'https://api.example.test/v1/chat',
      timeoutMs: 30_000,
      signal: ctrl.signal,
    });
    ctrl.abort();
    await expect(p).rejects.toBeInstanceOf(LlmError);
  });

  it('a settling bridge response still passes through untouched', async () => {
    (globalThis as G).Capacitor = { isNativePlatform: () => true };
    const { CapacitorHttp } = await import('@capacitor/core');
    (CapacitorHttp.request as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      status: 200,
      data: { ok: true },
    });
    const res = await httpJson({ url: 'https://api.example.test/v1/chat', timeoutMs: 5_000 });
    expect(res).toEqual({ status: 200, data: { ok: true } });
  });
});
