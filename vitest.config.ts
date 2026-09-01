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
    /**
     * 覆盖率 (M-J11)：**先观测，不阻塞**。
     *
     * 不设门槛是刻意的。一个一上来就卡在 80% 的门禁，第一件促成的事是有人去给
     * 好测的纯函数补几条凑数的用例——而这个仓库真正没被覆盖的是 .tsx 与原生桥，
     * 那两块补起来最慢、收益最不直接。先让数字可见几轮，看清它在哪儿低、为什么低，
     * 再谈要不要卡。
     *
     * 排除项：测试自身、类型声明、seed 数据（那是数据不是逻辑）、以及原生桥的
     * JS 侧（它的对手在 Kotlin 里，本容器跑不了，覆盖率数字只会误导）。
     */
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.d.ts',
        'src/data/seed*.ts',
        'src/native/**',
        'src/main.tsx',
      ],
    },
  },
});
