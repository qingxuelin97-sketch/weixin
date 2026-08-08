import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: true,
    port: 5173,
  },
  // Relative asset URLs, so the same dist/ works both at the root (Capacitor
  // serves it from http://localhost/) and under a sub-path
  // (GitHub Pages serves it from /weixin/). Safe because the app uses
  // HashRouter — the document path never changes, so `./` never drifts.
  base: './',
  build: {
    // Capacitor serves from `dist/`; keep assets relative for file:// origin.
    outDir: 'dist',
    sourcemap: true,
  },
});
