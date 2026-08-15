/**
 * Android hardware back button (M-I0).
 *
 * Unhandled until now: `@capacitor/app` was only used for appStateChange, so
 * on a real phone the system back button killed the app from ANY page — the
 * single most jarring thing an Android app can do.
 *
 * The order is fixed and shared with the edge-swipe gesture and the navbar
 * arrow, so all three ways of going back agree:
 *
 *   1. topmost overlay closes (dismiss stack — dialogs, sheets, viewers);
 *   2. off a tab root: the page stack pops (same navigate(-1) the gesture uses);
 *   3. on a tab root with nothing open: background the app on the first press
 *      — WeChat minimizes, it does not exit, and neither do we. `exitApp` is
 *      deliberately never called.
 */
import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { popDismiss } from './dismiss-stack';
import { logError } from '../lib/errlog';

const TAB_PATHS = new Set(['/chats', '/contacts', '/discover', '/me', '/']);

export function useBackButton(): void {
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    // The listener re-registers per location so `canGoBack` reflects the page
    // we are actually on; Capacitor replaces rather than stacks same-source
    // listeners only if we remove ours, hence the cleanup below.
    const sub = CapApp.addListener('backButton', () => {
      if (popDismiss()) return;
      if (!TAB_PATHS.has(location.pathname)) {
        navigate(-1);
        return;
      }
      void CapApp.minimizeApp().catch((e) => logError('back.minimize', e));
    });
    return () => {
      void sub.then((h) => h.remove()).catch(() => {});
    };
  }, [navigate, location.pathname]);
}
