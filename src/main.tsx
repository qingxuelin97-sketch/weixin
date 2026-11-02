import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/tokens.css';
import './styles/reset.css';
import './styles/app.css';
import './styles/motion.css';
import { App } from './App';
import { unlockAudio } from './lib/sound';
import { installGlobalErrorCapture } from './lib/errlog';
import { armSelftest } from './lib/selftest';
import { installNativeSse } from './native/sse-bridge';
import { installThemeWatcher } from './lib/theme';
import { applyFontScale } from './lib/font-scale';
import { installSystemBarsSync } from './native/system-bars';

// Mobile browsers gate audio behind a user gesture; unlock on the first tap.
window.addEventListener('pointerdown', () => unlockAudio(), { once: true });

// A phone has no console: capture what would otherwise vanish (see errlog.ts).
// Installed before render so a failure during boot is recorded too.
installGlobalErrorCapture();

// On native, the device reports its own transport matrix a few seconds after
// boot — to logcat for the CI emulator, and to EnvDiagPage on a real phone.
// Web builds skip it (see lib/selftest.ts).
armSelftest();

// Native SSE (M-J5): hand the OkHttp streaming bridge to the llm layer's
// transport seam. A no-op on web (the provider streams over fetch there), but
// it must run BEFORE the first canStream() ask — install at boot, not lazily.
installNativeSse();

// 主题 (M-K0)：index.html 的首帧脚本已经写好 data-theme；这里接管运行时——
// 跟随系统时监听日落自动切换，并把状态栏/导航栏颜色同步给原生层。
// 订阅先于 install：install 内的首次 apply 就要把颜色送到原生层。
installSystemBarsSync();
installThemeWatcher();
// 字体大小 (M-K5)：首帧脚本已写过一次；这里幂等再写，保证与 font-scale.ts 的解析一致。
applyFontScale();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
