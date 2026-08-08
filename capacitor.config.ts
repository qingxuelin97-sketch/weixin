import type { CapacitorConfig } from '@capacitor/cli';
import { KeyboardResize } from '@capacitor/keyboard';

// Optional: make the WebView load the app from a remote https origin instead of
// the bundled dist/. Set by `.github/workflows/apk-remote.yml` to the GitHub
// Pages copy, so a real device can be tested against a real server-served
// origin rather than Capacitor's local http://localhost. Unset (the normal
// case) => fully offline bundle, unchanged behaviour.
const remoteUrl = process.env.CAP_SERVER_URL?.trim();

const config: CapacitorConfig = {
  appId: 'com.personal.weixinai',
  appName: '微信',
  webDir: 'dist',
  android: {
    // All LLM endpoints are https; no cleartext needed. Keystore is managed in CI (see specs/build-distribution.md).
    allowMixedContent: false,
  },
  ...(remoteUrl
    ? {
        server: {
          url: remoteUrl,
          // Pages is https; only a LAN/dev http:// URL would need cleartext.
          cleartext: remoteUrl.startsWith('http://'),
        },
      }
    : {}),
  plugins: {
    Keyboard: {
      // We drive the input-bar/panel layout ourselves via visualViewport; the WebView must not resize.
      resize: KeyboardResize.None,
    },
  },
};

export default config;
