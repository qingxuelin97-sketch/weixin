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

/** Lazily resolve the native bridge; returns null in web/test contexts. */
async function nativeHttp(): Promise<null | {
  request: (o: unknown) => Promise<{ status: number; data: unknown }>;
}> {
  try {
    const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
    if (!cap?.isNativePlatform?.()) return null;
    const mod = await import('@capacitor/core');
    // CapacitorHttp is part of @capacitor/core.
    return (mod as unknown as { CapacitorHttp: { request: (o: unknown) => Promise<{ status: number; data: unknown }> } })
      .CapacitorHttp;
  } catch {
    return null;
  }
}

export async function httpJson(req: HttpRequest): Promise<HttpResponse> {
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT;
  const native = await nativeHttp();

  if (native) {
    const timeout = withTimeout(timeoutMs, req.signal);
    try {
      const res = await native.request({
        url: req.url,
        method: req.method ?? 'POST',
        headers: { 'Content-Type': 'application/json', ...req.headers },
        data: req.body,
        connectTimeout: timeoutMs,
        readTimeout: timeoutMs,
      });
      timeout.clear();
      return { status: res.status, data: res.data };
    } catch (e) {
      timeout.clear();
      throw normalizeTransportError(e);
    }
  }

  // Web / dev / test path.
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

function withTimeout(ms: number, signal?: AbortSignal) {
  // Native bridge honors its own connect/read timeouts; this only guards the JS await.
  const id = setTimeout(() => {
    if (!signal?.aborted) {
      // Native request cannot be aborted mid-flight from here; timeout surfaces on settle.
    }
  }, ms);
  return { clear: () => clearTimeout(id) };
}

function normalizeTransportError(e: unknown): LlmError {
  if (e instanceof LlmError) return e;
  const msg = e instanceof Error ? e.message : String(e);
  return new LlmError('network', msg);
}
