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

// Mobile browsers gate audio behind a user gesture; unlock on the first tap.
window.addEventListener('pointerdown', () => unlockAudio(), { once: true });

// A phone has no console: capture what would otherwise vanish (see errlog.ts).
// Installed before render so a failure during boot is recorded too.
installGlobalErrorCapture();

// On native, the device reports its own transport matrix a few seconds after
// boot — to logcat for the CI emulator, and to EnvDiagPage on a real phone.
// Web builds skip it (see lib/selftest.ts).
armSelftest();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
