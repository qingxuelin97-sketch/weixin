/**
 * HTTP transport abstraction. On a real device we prefer Capacitor's native
 * HTTP bridge (bypasses CORS, which blocks direct browser calls to DeepSeek et al.);
 * in the browser/dev/test we fall back to fetch. Callers never see the difference.
 */
import { LlmError } from './types';

export interface HttpRequest {
  url: string;
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface HttpResponse {
  status: number;
  data: unknown;
}

const DEFAULT_TIMEOUT = 60_000;

/** The one shape callers check for "this was cancelled, not broken". */
function abortError(): LlmError {
  return new LlmError('network', 'aborted');
}

/**
 * Lazily resolve the native bridge; returns null in web/test contexts.
 *
 * THE BUG THAT KILLED EVERY APK BUILD (found 2026-08-11 via the device's own
 * error log): this used to `return mod.CapacitorHttp` — the plugin PROXY —
 * from an async function. Capacitor plugin objects forward ANY property access
 * as a native method call, and JS promise resolution probes `.then` on every
 * returned value to decide if it is a thenable. So resolving with the proxy
 * made the runtime call the native method literally named "then", Android
 * answered `"CapacitorHttp.then()" is not implemented`, and the promise
 * REJECTED — every `await nativeHttp()` on a real device threw before any
 * request was even attempted, on every build since M2. Web never touched the
 * proxy (isNativePlatform false → early null), which is exactly why the
 * browser always worked while the APK was totally dead.
 *
 * RULE, now enforced by tests/unit/plugin-proxy.test.ts: a Capacitor plugin
 * proxy must NEVER be the resolution value of a promise. Wrap it in a plain
 * object whose methods close over the proxy.
 */
async function nativeHttp(): Promise<null | {
  request: (o: unknown) => Promise<{ status: number; data: unknown }>;
}> {
  try {
    const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
    if (!cap?.isNativePlatform?.()) return null;
    const mod = await import('@capacitor/core');
    const proxy = (
      mod as unknown as {
        CapacitorHttp: { request: (o: unknown) => Promise<{ status: number; data: unknown }> };
      }
    ).CapacitorHttp;
    // A plain object has no `then`, so promise assimilation cannot detonate.
    return { request: (o: unknown) => proxy.request(o) };
  } catch {
    return null;
  }
}

export async function httpJson(req: HttpRequest): Promise<HttpResponse> {
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT;
  // Already cancelled before we start? Then don't start. `nativeHttp()` awaits a
  // dynamic import, and the bridge below cannot be interrupted once dispatched —
  // so an abort that landed while the user was typing their next message still
  // produced a full, billed request whose answer nobody would ever read.
  if (req.signal?.aborted) throw abortError();
  const native = await nativeHttp();
  if (req.signal?.aborted) throw abortError();

  if (native) {
    // TRANSPORT POLICY (M-D device verdict): the WebView's own fetch is the
    // PRIMARY transport even on native. Live-device diagnosis proved the
    // CapacitorHttp bridge can fail/hang while in-app fetch works, and both
    // mainland providers (DeepSeek/MiniMax) serve full CORS today (preflight
    // verified). The bridge stays as FALLBACK for no-CORS gateways (Zen's
    // OPTIONS answers 404) — a CORS failure rejects fast, so the fallback
    // costs nothing when fetch could never have worked.
    let fetchErr: unknown;
    try {
      return await webFetch(req, timeoutMs);
    } catch (e) {
      fetchErr = e;
    }
    try {
      // The bridge cannot be aborted mid-flight, so the JS side must enforce the
      // deadline itself: race the plugin promise against a real rejecting timer.
      // Without this a hung native call awaits forever (the "测试永远卡着" bug).
      const res = await raceDeadline(
        native.request({
          url: req.url,
          method: req.method ?? 'POST',
          headers: { 'Content-Type': 'application/json', ...req.headers },
          data: req.body,
          connectTimeout: timeoutMs,
          readTimeout: timeoutMs,
        }),
        timeoutMs,
        req.signal,
      );
      return { status: res.status, data: res.data };
    } catch (bridgeErr) {
      // An abort is not a transport failure: reporting it as "both channels
      // down" made every interrupted turn look like a network outage in the
      // error log, drowning the real ones.
      if (req.signal?.aborted) throw abortError();
      const fe = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      const be = bridgeErr instanceof Error ? bridgeErr.message : String(bridgeErr);
      throw new LlmError('network', `网页通道: ${fe}；原生通道: ${be}`);
    }
  }

  return webFetch(req, timeoutMs);
}

/** The WebView/browser transport, shared by web builds and the native-primary path. */
async function webFetch(req: HttpRequest, timeoutMs: number): Promise<HttpResponse> {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  req.signal?.addEventListener('abort', onAbort);
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(req.url, {
      method: req.method ?? 'POST',
      headers: { 'Content-Type': 'application/json', ...req.headers },
      body: req.body != null ? JSON.stringify(req.body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* leave as text */
    }
    return { status: res.status, data };
  } catch (e) {
    if (ctrl.signal.aborted && !req.signal?.aborted) {
      throw new LlmError('timeout', `request timed out after ${timeoutMs}ms`);
    }
    throw normalizeTransportError(e);
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener('abort', onAbort);
  }
}

/** Settle with the request, a timeout rejection, or an abort — whichever is first. */
function raceDeadline<T>(p: Promise<T>, ms: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const timer = setTimeout(() => {
      done();
      reject(new LlmError('timeout', `request timed out after ${ms}ms`));
    }, ms);
    function onAbort() {
      done();
      reject(new LlmError('unknown', 'aborted'));
    }
    signal?.addEventListener('abort', onAbort);
    if (signal?.aborted) onAbort();
    p.then(
      (v) => {
        done();
        resolve(v);
      },
      (e) => {
        done();
        reject(e as Error);
      },
    );
  });
}

function normalizeTransportError(e: unknown): LlmError {
  if (e instanceof LlmError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  return new LlmError('network', msg);
}
