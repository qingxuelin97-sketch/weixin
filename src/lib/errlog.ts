/**
 * In-app error log (M-D hotfix). The device symptom that cost us a day was
 * "nothing happens at all": an exception in an un-guarded await chain became an
 * unhandled rejection, and with no console on a phone it was invisible.
 *
 * Everything here is best-effort and NEVER throws: the log is a diagnostic aid,
 * so it must not become a second source of failure. Memory-first (works even if
 * localStorage is unavailable — which is itself one of the things we suspect).
 */

export interface ErrEntry {
  at: number;
  scope: string;
  message: string;
}

const MAX = 60;
const buffer: ErrEntry[] = [];
const LS_KEY = 'aiwx_errlog';

function persist(): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(buffer.slice(-MAX)));
  } catch {
    /* storage unavailable — memory copy still works for this session */
  }
}

export function logError(scope: string, err: unknown): void {
  try {
    const message =
      err instanceof Error ? `${err.name}: ${err.message}` : typeof err === 'string' ? err : JSON.stringify(err);
    buffer.push({ at: Date.now(), scope, message: message.slice(0, 300) });
    if (buffer.length > MAX) buffer.splice(0, buffer.length - MAX);
    persist();
  } catch {
    /* never let logging break the caller */
  }
}

export function getErrors(): ErrEntry[] {
  if (buffer.length === 0) {
    try {
      const raw = localStorage.getItem(LS_KEY);
      // Storage keeps oldest-first (append order); reverse to match the
      // in-memory path. This branch shipped un-reversed, so the diagnostics
      // page — read most often right after a restart, off exactly this path —
      // showed the OLDEST errors on top while claiming newest-first.
      if (raw) return (JSON.parse(raw) as ErrEntry[]).reverse();
    } catch {
      /* ignore */
    }
  }
  return [...buffer].reverse(); // newest first
}

export function clearErrors(): void {
  buffer.length = 0;
  try {
    localStorage.removeItem(LS_KEY);
  } catch {
    /* ignore */
  }
}

/** Catch what would otherwise vanish silently on a phone. */
export function installGlobalErrorCapture(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('unhandledrejection', (e) => logError('unhandledrejection', e.reason));
  window.addEventListener('error', (e) => logError('window.error', e.message || e.error));
}
