/**
 * Foreground transitions.
 *
 * M4 built the backfill barrier but only ever ran it once, from the scheduler
 * effect at hydrate. On a phone that is the *rare* path: the common one is
 * background → foreground within a live session, where the WebView keeps
 * running, no effect re-runs, and the whole "while you were away" machinery
 * never fired. This hook is what makes it fire.
 *
 * On every return to the foreground:
 *   1. backfill the gap that just opened (moves the barrier forward),
 *   2. drop every pending notification and rebuild it — anything still queued
 *      was written against a world the user has now moved past.
 *
 * Both web (`visibilitychange`) and native (`@capacitor/app` appStateChange) are
 * wired, because the web build is a first-class target, not just a dev harness.
 */
import { useEffect } from 'react';
import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';

export interface ForegroundHandlers {
  onForeground: () => Promise<void> | void;
  /** Called when the app goes to the background — last chance to persist. */
  onBackground?: () => Promise<void> | void;
}

/**
 * Ignore transitions closer together than this. Android fires appStateChange
 * alongside visibilitychange, and a permission dialog can bounce the app twice
 * in a second; without a floor, each bounce would run another backfill.
 */
const MIN_GAP_MS = 3_000;

export function useForegroundLifecycle(enabled: boolean, handlers: ForegroundHandlers): void {
  useEffect(() => {
    if (!enabled) return;
    let lastRun = 0;
    let disposed = false;

    const toForeground = () => {
      const now = Date.now();
      if (now - lastRun < MIN_GAP_MS) return;
      lastRun = now;
      void Promise.resolve(handlers.onForeground()).catch(() => {
        // A failed foreground pass must never break the app; the next
        // transition retries, and the barrier is only advanced on success.
      });
    };

    const toBackground = () => {
      void Promise.resolve(handlers.onBackground?.()).catch(() => {});
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible') toForeground();
      else toBackground();
    };
    document.addEventListener('visibilitychange', onVisibility);

    // Native gives a truer signal than visibilitychange (which Android WebViews
    // report inconsistently), so listen to both and let MIN_GAP_MS dedupe them.
    let removeNative: (() => void) | undefined;
    if (Capacitor.isNativePlatform()) {
      void CapApp.addListener('appStateChange', ({ isActive }) => {
        if (disposed) return;
        if (isActive) toForeground();
        else toBackground();
      }).then((handle) => {
        if (disposed) void handle.remove();
        else removeNative = () => void handle.remove();
      });
    }

    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      removeNative?.();
    };
    // Handlers are read through a stable closure created once per `enabled`
    // flip; re-subscribing on every render would drop events mid-transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
}
