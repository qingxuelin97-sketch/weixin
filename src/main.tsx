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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
