/**
 * The one way an async click is allowed to reach the UI.
 *
 * `onClick={() => void save()}` looks safe and is not: `void` discards the
 * promise, so a rejection becomes an unhandled rejection. On a phone there is
 * no console, so the entire failure is: nothing happens. That is the exact
 * symptom that cost this project a day of debugging in M-D, and the audit found
 * a dozen more instances of it — every one of them a button that silently does
 * nothing when storage or the network misbehaves.
 *
 * `guard` makes the failure land somewhere a human can see: a toast now, and a
 * line in the in-app error log for the diagnostics page later.
 */
import { useCallback } from 'react';
import { useAppStore } from '../store/appStore';
import { logError } from '../lib/errlog';

export interface GuardOptions {
  /** Shown instead of the raw error text. The raw text still reaches the log. */
  message?: string;
  /** Runs after logging, whether or not a toast was shown (e.g. reset a busy flag). */
  onError?: (e: unknown) => void;
}

export type GuardFn = (scope: string, fn: () => Promise<unknown>, opts?: GuardOptions) => void;

export function useGuard(): GuardFn {
  const showToast = useAppStore((s) => s.showToast);
  return useCallback(
    (scope, fn, opts = {}) => {
      void (async () => {
        try {
          await fn();
        } catch (e) {
          logError(scope, e);
          showToast(opts.message ?? `操作失败：${e instanceof Error ? e.message : String(e)}`);
          opts.onError?.(e);
        }
      })();
    },
    [showToast],
  );
}
