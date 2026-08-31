/**
 * Native SSE bridge, JS side (M-J5).
 *
 * The Kotlin half (android/.../aiwx/SseBridge.kt) runs an OkHttp streaming
 * POST on a background thread and fires ONE shared Capacitor event channel:
 *
 *   { id, open: true, status }   response head arrived (status known)
 *   { id, line }                 one raw response line (SSE frame / body line)
 *   { id, done: true, status }   server closed the stream normally
 *   { id, error }                transport failure (incl. cancel + timeouts)
 *
 * This file turns that firehose back into per-request `AsyncIterable<string>`s
 * and installs itself into the llm layer's sse-transport seam (the dependency
 * direction is `native → llm`, so the provider cannot import us — same setter
 * pattern as the router's cost-gate preflight).
 *
 * Two constitution traps are load-bearing:
 *  - Timeouts are REAL rejections (3.5): the bridge call races `withDeadline`,
 *    the response head races an open deadline, and every parked pull races a
 *    stall timer that REJECTS. A dead bridge can therefore never leave a turn
 *    awaiting forever — which is exactly what CapacitorHttp did and why native
 *    never streamed before this file.
 *  - Backpressure is pull-promise shaped: lines queue up at network speed and
 *    the consumer takes them at its own pace; at most one pull is parked per
 *    channel (for-await semantics), and a parked pull settles from dispatch.
 */
import {
  addSseLineListener,
  sseCancel,
  sseStart,
  sseSupported,
} from './bridge';
import {
  setNativeSseTransport,
  type SseStreamHandle,
  type SseStreamRequest,
} from '../llm/sse-transport';

/** Response head must arrive within this. Native connect timeout is 20s; the
 * margin covers TLS + bridge dispatch. Fires as a REAL rejection. */
export const SSE_OPEN_TIMEOUT_MS = 25_000;
/** Max silence between events once open. Native read timeout is 60s and fires
 * first (as an `error` event); this JS-side timer only catches a dead bridge. */
export const SSE_STALL_TIMEOUT_MS = 90_000;

/** Shape of one `sseLine` event. Extra/missing fields are tolerated: the
 * payload crosses a process boundary and is validated here, not trusted. */
export interface SseLineEvent {
  id?: unknown;
  open?: unknown;
  line?: unknown;
  done?: unknown;
  status?: unknown;
  error?: unknown;
}

interface Waiter {
  resolve: (r: IteratorResult<string, undefined>) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface Channel {
  queue: string[];
  /** At most one under for-await, but kept as a list so a misuse cannot hang. */
  waiters: Waiter[];
  ended: boolean;
  endError: unknown;
  openSettled: boolean;
  openResolve: (status: number) => void;
  openReject: (e: unknown) => void;
  opened: Promise<number>;
  openTimer: ReturnType<typeof setTimeout> | undefined;
}

export interface SseChannelHandle {
  /** Resolves with the HTTP status once the response head arrives. */
  opened: Promise<number>;
  lines: AsyncIterable<string>;
}

/**
 * Pure event→AsyncIterable demultiplexer. No Capacitor in here — the plugin
 * listener calls `dispatch`, tests call it directly.
 */
export class SseHub {
  private chans = new Map<string, Channel>();

  constructor(
    private openTimeoutMs = SSE_OPEN_TIMEOUT_MS,
    private stallTimeoutMs = SSE_STALL_TIMEOUT_MS,
  ) {}

  /** Channels currently held — the leak guard tests watch this. */
  size(): number {
    return this.chans.size;
  }

  create(id: string): SseChannelHandle {
    let openResolve!: (s: number) => void;
    let openReject!: (e: unknown) => void;
    const opened = new Promise<number>((res, rej) => {
      openResolve = res;
      openReject = rej;
    });
    // A caller that fails before awaiting `opened` (sseStart rejected) must
    // not leave an unhandled rejection behind; extra consumers still see it.
    opened.catch(() => {});
    const ch: Channel = {
      queue: [],
      waiters: [],
      ended: false,
      endError: null,
      openSettled: false,
      openResolve,
      openReject,
      opened,
      openTimer: setTimeout(() => {
        this.fail(id, new Error(`sse ${id}: no response head after ${this.openTimeoutMs}ms`));
      }, this.openTimeoutMs),
    };
    this.chans.set(id, ch);
    const lines: AsyncIterable<string> = {
      [Symbol.asyncIterator]: () => ({
        next: () => this.pull(id),
        // for-await break/throw: tear the channel down so late events drop.
        return: async () => {
          this.drop(id);
          return { value: undefined, done: true as const };
        },
      }),
    };
    return { opened, lines };
  }

  /** Route one bridge event. Unknown/late ids are DROPPED — a cancelled turn's
   * stragglers must not detonate anything. */
  dispatch(raw: unknown): void {
    const ev = (raw ?? {}) as SseLineEvent;
    const id = typeof ev.id === 'string' ? ev.id : null;
    if (!id) return;
    const ch = this.chans.get(id);
    if (!ch || ch.ended) return;
    if (ev.open === true) {
      this.settleOpen(ch, typeof ev.status === 'number' ? ev.status : 0);
    }
    if (typeof ev.line === 'string') {
      const w = ch.waiters.shift();
      if (w) {
        clearWaiter(w);
        w.resolve({ value: ev.line, done: false });
      } else {
        ch.queue.push(ev.line);
      }
    }
    if (typeof ev.error === 'string' && ev.error) {
      this.fail(id, new Error(`sse ${id}: ${ev.error}`));
      return;
    }
    if (ev.done === true) {
      // Defensive: a stream that closed before its head event still resolves
      // `opened` (with the final status) instead of stranding the open await.
      this.settleOpen(ch, typeof ev.status === 'number' ? ev.status : 0);
      ch.ended = true;
      this.flushEnd(ch);
    }
  }

  /** Local failure injection: abort, bridge rejection, deadline. Queued lines
   * ahead of the failure still deliver; only the END of the stream is an error. */
  fail(id: string, e: unknown): void {
    const ch = this.chans.get(id);
    if (!ch || ch.ended) return;
    if (!ch.openSettled) {
      ch.openSettled = true;
      clearTimeout(ch.openTimer);
      ch.openReject(e);
    }
    ch.ended = true;
    ch.endError = e;
    this.flushEnd(ch);
  }

  /** Forget a channel entirely; subsequent events for the id are dropped. */
  drop(id: string): void {
    const ch = this.chans.get(id);
    if (!ch) return;
    this.chans.delete(id);
    clearTimeout(ch.openTimer);
    if (!ch.openSettled) {
      ch.openSettled = true;
      ch.openReject(new Error(`sse ${id}: dropped`));
    }
    // Graceful teardown FROM the consumer: parked pulls finish `done`, not
    // rejected — the consumer chose to leave, nothing failed.
    ch.ended = true;
    for (const w of ch.waiters.splice(0)) {
      clearWaiter(w);
      w.resolve({ value: undefined, done: true });
    }
  }

  private settleOpen(ch: Channel, status: number): void {
    if (ch.openSettled) return;
    ch.openSettled = true;
    clearTimeout(ch.openTimer);
    ch.openResolve(status);
  }

  private flushEnd(ch: Channel): void {
    // Waiters only exist when the queue is empty, so ending flushes them all.
    for (const w of ch.waiters.splice(0)) {
      clearWaiter(w);
      if (ch.endError != null) w.reject(ch.endError);
      else w.resolve({ value: undefined, done: true });
    }
  }

  private pull(id: string): Promise<IteratorResult<string, undefined>> {
    const ch = this.chans.get(id);
    if (!ch) return Promise.resolve({ value: undefined, done: true });
    if (ch.queue.length > 0) {
      return Promise.resolve({ value: ch.queue.shift() as string, done: false });
    }
    if (ch.ended) {
      return ch.endError != null
        ? Promise.reject(ch.endError)
        : Promise.resolve({ value: undefined, done: true });
    }
    return new Promise<IteratorResult<string, undefined>>((resolve, reject) => {
      const w: Waiter = {
        resolve,
        reject,
        // The stall guard: if neither a line nor an end arrives, this pull
        // REJECTS (never hangs) and the channel dies with it.
        timer: setTimeout(() => {
          this.fail(id, new Error(`sse ${id}: no data for ${this.stallTimeoutMs}ms`));
        }, this.stallTimeoutMs),
      };
      ch.waiters.push(w);
    });
  }
}

function clearWaiter(w: Waiter): void {
  if (w.timer !== undefined) clearTimeout(w.timer);
  w.timer = undefined;
}

/* ------------------------------------------------------------------ glue */

let hub: SseHub | null = null;
let seq = 0;

function ensureHub(): SseHub {
  if (!hub) {
    const h = new SseHub();
    hub = h;
    // One listener for the process lifetime; per-request channels come and go.
    addSseLineListener((ev) => h.dispatch(ev));
  }
  return hub;
}

/**
 * Open one native streaming POST and hand back a transport-agnostic handle.
 * Cancellation is two-sided: `signal.abort` (and `cancel()`) closes the OkHttp
 * call natively AND ends the local channel immediately — the consumer never
 * waits a round-trip to learn its own abort happened.
 */
export async function openNativeSse(req: SseStreamRequest): Promise<SseStreamHandle> {
  const h = ensureHub();
  const id = `sse_${++seq}_${Date.now().toString(36)}`;
  const ch = h.create(id);
  const onAbort = () => {
    void sseCancel(id);
    h.fail(id, new Error('aborted'));
  };
  req.signal?.addEventListener('abort', onAbort);
  const cancel = () => {
    req.signal?.removeEventListener('abort', onAbort);
    void sseCancel(id);
    h.drop(id);
  };
  try {
    if (req.signal?.aborted) throw new Error('aborted');
    await sseStart({
      id,
      url: req.url,
      headersJson: JSON.stringify(req.headers ?? {}),
      bodyJson: JSON.stringify(req.body ?? {}),
    });
    const status = await ch.opened; // rejected by the hub's own open deadline
    return { status, lines: ch.lines, cancel };
  } catch (e) {
    cancel();
    throw e;
  }
}

/**
 * Boot wiring (called from main.tsx): put the native transport into the llm
 * seam. On web `sseSupported()` is false, so installing is always safe — the
 * provider keeps streaming over the browser's own fetch.
 */
export function installNativeSse(): void {
  setNativeSseTransport({
    available: () => sseSupported(),
    open: (req) => openNativeSse(req),
  });
}
