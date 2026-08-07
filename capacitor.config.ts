import type { CapacitorConfig } from '@capacitor/cli';
import { KeyboardResize } from '@capacitor/keyboard';

const config: CapacitorConfig = {
  appId: 'com.personal.weixinai',
  appName: '微信',
  webDir: 'dist',
  android: {
    // All LLM endpoints are https; no cleartext needed. Keystore is managed in CI (see specs/build-distribution.md).
    allowMixedContent: false,
  },
  plugins: {
    Keyboard: {
      // We drive the input-bar/panel layout ourselves via visualViewport; the WebView must not resize.
      resize: KeyboardResize.None,
    },
  },
};

export default config;
