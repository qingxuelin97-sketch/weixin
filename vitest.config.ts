import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    // .tsx too (M-J11): component render tests live beside the pure ones and
    // opt into jsdom per-file with a `// @vitest-environment jsdom` docblock,
    // so the ~110 pure-function files keep the faster node environment.
    include: ['tests/unit/**/*.test.ts', 'tests/unit/**/*.test.tsx'],
    globals: false,
  },
});
