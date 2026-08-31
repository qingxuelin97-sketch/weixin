/**
 * Native SSE transport seam (M-J5).
 *
 * On a device the WebView CAN stream a cross-origin fetch only when the
 * endpoint serves CORS; the no-CORS gateways (Zen) that the permissive channel
 * depends on need the native OkHttp bridge. That bridge lives in
 * `src/native/sse-bridge.ts` — and the dependency direction is `native → llm`,
 * never the reverse (constitution §1), so the provider cannot import it.
 * Same solution as the router's cost-gate preflight: the native layer INSTALLS
 * itself here at boot, and `openai-compatible.ts` only ever reads the seam.
 *
 * The transport is a dumb pipe on purpose: it carries exactly the URL, headers
 * and body the provider hands it, and hands back raw response lines. Endpoint
 * choice, tier routing (rule #6) and the degradation ladder all stay above it
 * in the router — a transport that picked its own endpoints would be a second
 * channel around the NSFW routing gate.
 */

export interface SseStreamRequest {
  url: string;
  headers: Record<string, string>;
  /** JSON-serializable request body; the bridge stringifies it exactly once. */
  body: unknown;
  signal?: AbortSignal;
}

export interface SseStreamHandle {
  /** HTTP status from the response head — known BEFORE any line is consumed. */
  status: number;
  /**
   * Raw response lines (SSE frames on 2xx, the error body on 4xx/5xx), without
   * trailing newlines. Throws on a mid-stream transport error; ends normally
   * when the server closes the stream.
   */
  lines: AsyncIterable<string>;
  /** Close the connection and drop the local channel. Idempotent. */
  cancel: () => void;
}

export interface NativeSseTransport {
  /** True only when the platform is native AND the bridge plugin is present. */
  available(): boolean;
  /**
   * Open a streaming POST. Resolves once the response HEAD arrived (status
   * known); rejects on connect failure/timeout. Callers must `cancel()` the
   * handle when done — including on early exit.
   */
  open(req: SseStreamRequest): Promise<SseStreamHandle>;
}

let transport: NativeSseTransport | null = null;

/** Installed by src/native/sse-bridge.ts at boot; null = web / bridge absent. */
export function setNativeSseTransport(t: NativeSseTransport | null): void {
  transport = t;
}

export function getNativeSseTransport(): NativeSseTransport | null {
  return transport;
}
