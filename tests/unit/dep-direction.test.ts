import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { join } from 'node:path';

/**
 * 宪法 §1 依赖方向的「守卫的守卫」(M-J0)。
 *
 * 执法者是 .eslintrc.cjs 里的四个 no-restricted-imports override——真正拦下
 * 反向 import 的是 `pnpm lint`。但 eslint 配置本身没有任何东西守着：删掉一个
 * override，lint 依旧全绿（违规 import 还没写出来呢），保护就无声消失了。
 * 这份测试断言四条边界仍然在配置里，且方向和宪法写的一致。
 */

type PatternGroup = { group: string[]; allowTypeImports?: boolean; message?: string };
type Override = {
  files: string[];
  rules: Record<string, [string, { patterns: PatternGroup[] }]>;
};

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const cfg = require(join(__dirname, '..', '..', '.eslintrc.cjs')) as { overrides?: Override[] };

/** 宪法 §1 的四条已知反向，缺一不可。 */
const REQUIRED_BOUNDARIES: Record<string, string[]> = {
  'src/lib/**/*': ['**/features/**', '**/store/**', '**/ai/**', '**/llm/**'],
  'src/ai/**/*': ['**/features/**', '**/store/**'],
  'src/llm/**/*': ['**/ai/**', '**/features/**'],
  'src/components/**/*': ['**/features/**'],
};

function boundaryFor(files: string): PatternGroup | undefined {
  const ov = (cfg.overrides ?? []).find((o) => o.files.includes(files));
  const rule = ov?.rules['@typescript-eslint/no-restricted-imports'];
  if (!rule || rule[0] !== 'error') return undefined;
  return rule[1].patterns[0];
}

describe('宪法 §1 依赖方向 — eslint 配置守卫', () => {
  for (const [files, groups] of Object.entries(REQUIRED_BOUNDARIES)) {
    it(`${files} 锁死 ${groups.join(' / ')}`, () => {
      const p = boundaryFor(files);
      expect(p, `${files} 的 no-restricted-imports override 被删了`).toBeDefined();
      for (const g of groups) {
        expect(p!.group, `${files} 少了对 ${g} 的封锁`).toContain(g);
      }
    });
  }

  it('type-only import 的豁免是显式声明的（防止有人误以为可以删）', () => {
    for (const files of Object.keys(REQUIRED_BOUNDARIES)) {
      expect(boundaryFor(files)!.allowTypeImports).toBe(true);
    }
  });
});
