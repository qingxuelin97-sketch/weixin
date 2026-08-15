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

    return () => {
      disposed = true;
      removeListener?.();
    };
  }, [navigate]);
}
