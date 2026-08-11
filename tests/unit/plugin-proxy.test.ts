import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The bug that killed every APK build (found 2026-08-11, via the device's own
 * error log — `"CapacitorHttp.then()" is not implemented on android`).
 *
 * Capacitor plugin objects are proxies that forward ANY property access as a
 * native method call. JS promise resolution probes `.then` on every resolved
 * value to decide whether it is a thenable. Put together: an async function
 * that resolves WITH a plugin proxy makes the runtime call the native method
 * literally named "then" — which does not exist — and the promise rejects.
 *
 * `nativeHttp()` did exactly that since M2, so on a real device every request
 * died before touching the network, while the browser (which never loads the
 * proxy) worked perfectly. Three weeks of "web 有效 / APK 全灭" in one line.
 *
 * This suite pins the rule: a plugin proxy must never be a promise's
 * resolution value. The fake proxy below DETONATES if anything probes `.then`,
 * exactly like the real bridge does.
 */

/** Mimics a Capacitor plugin proxy: every unknown property is a native call. */
function makeBoobyTrappedPlugin<T extends Record<string, (...a: never[]) => unknown>>(
  real: T,
  name: string,
): T {
  return new Proxy(real, {
    get(target, prop) {
      if (prop in target) return target[prop as keyof T];
      // The real bridge forwards ANY name — including "then" — as a native
      // method and rejects with exactly this message. Pre-caught so the orphan
      // doesn't trip vitest's unhandled-rejection detector — on the device that
      // orphan is precisely what showed up in the user's error log.
      return () => {
        const rejected = Promise.reject(
          new Error(`"${name}.${String(prop)}()" is not implemented on android`),
        );
        rejected.catch(() => {});
        return rejected;
      };
    },
  });
}

const nativeEnv = { Capacitor: { isNativePlatform: () => true } };

describe('the thenable-proxy trap', () => {
  it('demonstrates the failure mode itself (control case)', async () => {
    const proxy = makeBoobyTrappedPlugin({ request: async () => ({ status: 200, data: {} }) }, 'CapacitorHttp');
    // Resolving a promise WITH the proxy assimilates it as a thenable: JS calls
    // `proxy.then(resolve, reject)`. The bridge rejects the promise THAT CALL
    // returns (an orphan — the device's unhandledrejection log line), while the
    // passed-in resolve/reject are never invoked — so the assimilated promise
    // HANGS FOREVER. Worse than throwing: it is invisible without a deadline,
    // which is exactly why the symptom was "等待 20s 无响应" rather than an error.
    const settled = Promise.race([
      Promise.resolve(proxy).then(
        () => 'settled',
        () => 'settled',
      ),
      new Promise((r) => setTimeout(() => r('hung'), 150)),
    ]);
    await expect(settled).resolves.toBe('hung');
  });
});

describe('httpJson survives a booby-trapped CapacitorHttp', () => {
  beforeEach(() => {
    vi.resetModules();
    (globalThis as Record<string, unknown>).Capacitor = nativeEnv.Capacitor;
    vi.doMock('@capacitor/core', () => ({
      CapacitorHttp: makeBoobyTrappedPlugin(
        {
          request: async (o: { url: string }) => ({ status: 401, data: { probed: o.url } }),
        },
        'CapacitorHttp',
      ),
      Capacitor: nativeEnv.Capacitor,
    }));
  });
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).Capacitor;
    vi.doUnmock('@capacitor/core');
    vi.resetModules();
  });

  it('reaches the bridge without ever probing the proxy’s then', async () => {
    // Web fetch fails first (no server in tests) → httpJson falls back to the
    // bridge. Pre-fix this threw `"CapacitorHttp.then()" is not implemented`
    // at the top of httpJson, before any channel was even tried.
    const { httpJson } = await import('../../src/llm/http');
    const res = await httpJson({ url: 'https://api.example.test/models', method: 'GET' });
    expect(res.status).toBe(401);
  });
});

describe('notify’s plugin wrapper', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock('@capacitor/core', () => ({
      Capacitor: nativeEnv.Capacitor,
      // notify.ts imports Capacitor statically from core.
    }));
    vi.doMock('@capacitor/local-notifications', () => ({
      LocalNotifications: makeBoobyTrappedPlugin(
        {
          requestPermissions: async () => ({ display: 'granted' }),
          schedule: async () => ({}),
          cancel: async () => undefined,
          getPending: async () => ({ notifications: [] }),
        },
        'LocalNotifications',
      ),
    }));
  });
  afterEach(() => {
    vi.doUnmock('@capacitor/core');
    vi.doUnmock('@capacitor/local-notifications');
    vi.resetModules();
  });

  it('requests permission without detonating the proxy', async () => {
    const { requestPermission } = await import('../../src/lib/notify');
    // Pre-fix: nativePlugin() resolved with the proxy → assimilation called
    // `LocalNotifications.then()` → rejection → notifications silently dead
    // on every device build.
    await expect(requestPermission()).resolves.toBe(true);
  });
});
