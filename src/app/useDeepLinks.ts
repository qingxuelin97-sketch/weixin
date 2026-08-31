/**
 * Deep-link routing (M-I10): aiwx:// VIEW intents → in-app navigation.
 *
 * Two delivery paths, both handled:
 *  - warm: the activity is alive (launchMode singleTask), Android calls
 *    onNewIntent, Capacitor emits `appUrlOpen`;
 *  - cold: the intent LAUNCHED the app — no appUrlOpen is guaranteed to fire
 *    before this hook subscribes, so getLaunchUrl() is read once after mount.
 *
 * Must be mounted INSIDE the router (it navigates); see <DeepLinkBridge/> in
 * src/App.tsx. Parsing + allowlisting live in src/native/deep-link.ts (pure).
 */
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { App as CapApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { parseDeepLink } from '../native/deep-link';
import { onNotificationTap } from '../lib/notify';

export function useDeepLinks(): void {
  const navigate = useNavigate();

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let disposed = false;
    // The cold-start URL and the first appUrlOpen can be the SAME intent —
    // navigating twice pushes a duplicate history entry, and hardware back
    // would then need two presses. Dedupe on the exact route within a window.
    let lastRoute = '';
    let lastAt = 0;

    const open = (url: string | undefined | null) => {
      if (disposed || !url) return;
      const route = parseDeepLink(url);
      if (!route) return;
      const now = Date.now();
      if (route === lastRoute && now - lastAt < 3_000) return;
      lastRoute = route;
      lastAt = now;
      navigate(route);
    };

    let removeListener: (() => void) | undefined;
    void CapApp.addListener('appUrlOpen', (ev) => open(ev.url)).then((handle) => {
      if (disposed) void handle.remove();
      else removeListener = () => void handle.remove();
    });

    void CapApp.getLaunchUrl()
      .then((r) => open(r?.url))
      .catch(() => {
        /* no launch url — normal start */
      });

    // A PRE-SCHEDULED notification (lib/notify.ts) is delivered by
    // LocalNotifications, not as a VIEW intent, so its tap never reaches
    // appUrlOpen. Without this listener those notifications had no destination
    // at all — the 朋友圈 like/comment ones landed the user wherever the app
    // last was, holding a momentId that had been discarded at schedule time.
    // Same `open()`, so the same allowlist and the same dedupe apply.
    let removeTapListener: (() => void) | undefined;
    void onNotificationTap((route) => open(route)).then((off) => {
      if (disposed) off();
      else removeTapListener = off;
    });

    return () => {
      disposed = true;
      removeListener?.();
      removeTapListener?.();
    };
  }, [navigate]);
}
