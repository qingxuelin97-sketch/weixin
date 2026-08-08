import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles/tokens.css';
import './styles/reset.css';
import './styles/app.css';
import './styles/motion.css';
import { App } from './App';
import { unlockAudio } from './lib/sound';

// Mobile browsers gate audio behind a user gesture; unlock on the first tap.
window.addEventListener('pointerdown', () => unlockAudio(), { once: true });

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
