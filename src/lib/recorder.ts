/**
 * Microphone capture for hold-to-talk (M-I9).
 *
 * Thin, typed wrapper over getUserMedia + MediaRecorder (webm/opus where the
 * platform offers it). Everything here is UI-side hardware plumbing, so the
 * seeded-clock rules for engines don't apply — but two of this repo's other
 * laws very much do:
 *
 *   1. Graceful degradation is a FEATURE contract, not an accident: when the
 *      environment can't record (no mediaDevices in an old WebView, permission
 *      denied, mic already claimed), the caller gets a typed RecorderError and
 *      shows the stub toast — never a white screen mid-press.
 *   2. The mic must be RELEASED on every path (stop, cancel, error, auto-stop):
 *      a leaked MediaStreamTrack keeps Android's mic-in-use indicator on
 *      forever, which for this app reads as "微信在偷听" — instant trust loss.
 */

export type RecorderErrorKind =
  | 'unsupported' // no getUserMedia / no MediaRecorder in this WebView
  | 'denied' // user (or OS policy) refused the permission
  | 'busy' // hardware exists but could not start (in use / no device)
  | 'failed'; // anything else

export class RecorderError extends Error {
  constructor(
    public kind: RecorderErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'RecorderError';
  }
}

/** Feature-detect before touching hardware; callable synchronously from a press handler. */
export function isRecordingSupported(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof MediaRecorder !== 'undefined'
  );
}

/**
 * Preferred container in order: webm/opus (Chrome/Android WebView), then the
 * fallbacks Safari-family engines expose. '' lets MediaRecorder pick, which
 * still yields a playable (and transcribable) clip.
 */
export function pickAudioMime(): string {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported(c)) return c;
  }
  return '';
}

export interface RecordingHandle {
  /** Actual container mime (what the Blob will claim). */
  readonly mimeType: string;
  /** Finish and get the clip. Idempotent — later calls return the same Blob. */
  stop(): Promise<Blob>;
  /** Discard everything and release the mic immediately. */
  cancel(): void;
}

export interface StartRecordingOptions {
  /** Hard cap; recording stops itself at this point (default 60s, WeChat's cap). */
  maxMs?: number;
  /** Fired when the cap tripped — the UI flips to "松手" state on its own. */
  onAutoStop?: () => void;
}

const MAX_RECORD_MS = 60_000;

/**
 * Ask for the mic and start recording. Rejects with RecorderError; on success
 * the mic is LIVE until `stop()` or `cancel()` — callers must guarantee one of
 * them runs on every exit path (the UI ties cancel to pointercancel + dismiss).
 */
export async function startRecording(opts: StartRecordingOptions = {}): Promise<RecordingHandle> {
  if (!isRecordingSupported()) {
    throw new RecorderError('unsupported', '当前环境不支持录音（缺 MediaRecorder）');
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch (e) {
    const name = e instanceof DOMException ? e.name : '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new RecorderError('denied', '麦克风权限被拒绝——去系统设置里允许本应用使用麦克风');
    }
    if (name === 'NotFoundError' || name === 'NotReadableError' || name === 'AbortError') {
      throw new RecorderError('busy', '麦克风不可用（被占用或没有设备）');
    }
    throw new RecorderError('failed', e instanceof Error ? e.message : String(e));
  }

  const releaseMic = () => {
    for (const track of stream.getTracks()) track.stop();
  };

  const mime = pickAudioMime();
  let rec: MediaRecorder;
  try {
    rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  } catch (e) {
    releaseMic();
    throw new RecorderError('failed', e instanceof Error ? e.message : String(e));
  }

  const chunks: BlobPart[] = [];
  let cancelled = false;
  let settled: Blob | null = null;

  const done = new Promise<Blob>((resolve, reject) => {
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    rec.onstop = () => {
      releaseMic();
      clearTimeout(capTimer);
      if (cancelled) {
        reject(new RecorderError('failed', 'cancelled'));
        return;
      }
      settled = new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' });
      resolve(settled);
    };
    rec.onerror = () => {
      releaseMic();
      clearTimeout(capTimer);
      reject(new RecorderError('failed', '录音硬件报错'));
    };
  });
  // A cancelled recording rejects `done`; nobody awaits it in that flow, so
  // pre-catch to keep the orphan out of unhandled-rejection logs.
  done.catch(() => {});

  const capTimer = setTimeout(() => {
    if (rec.state !== 'inactive') {
      try {
        rec.stop();
      } catch {
        releaseMic();
      }
      opts.onAutoStop?.();
    }
  }, opts.maxMs ?? MAX_RECORD_MS);

  try {
    rec.start();
  } catch (e) {
    clearTimeout(capTimer);
    releaseMic();
    throw new RecorderError('failed', e instanceof Error ? e.message : String(e));
  }

  return {
    mimeType: rec.mimeType || mime || 'audio/webm',
    stop(): Promise<Blob> {
      if (settled) return Promise.resolve(settled);
      if (rec.state !== 'inactive') {
        try {
          rec.stop();
        } catch {
          releaseMic();
        }
      }
      return done;
    },
    cancel(): void {
      cancelled = true;
      clearTimeout(capTimer);
      if (rec.state !== 'inactive') {
        try {
          rec.stop();
        } catch {
          /* already stopping */
        }
      }
      // stop() → onstop also releases; belt-and-braces for exotic states.
      releaseMic();
    },
  };
}
