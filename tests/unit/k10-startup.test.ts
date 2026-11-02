/**
 * 启动瘦身 (M-K10) 的结构守卫。
 *
 * 体积棘轮管的是数字；这里管的是**形状**——三条「冷启动不该付的钱」，各自
 * 一句话就能被悄悄加回来，而加回来的那一刻没有任何功能会坏：
 *
 * 1. App 静态 import 调度运行时 → 25 个 handler 与它们背后约 200KB 源码重回首屏；
 * 2. driver 静态 import SQLite 驱动 → Web 一辈子用不上的 11KB 回到每一次冷启动；
 * 3. react-virtuoso 重新进依赖图 → 主包里最大的一块应用依赖（gzip ~16KB）回来。
 *
 * 棘轮最终也会红，但它只说「多了 18KB」，不说是哪一行——这里直接指名。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(__dirname, '../../');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
/** 宪法 3.5：先剥注释——解释「为什么不静态导入」的注释本身就含有那句导入。 */
const code = (p: string) =>
  read(p)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');

/** 非 type-only 的静态 import/export-from 的模块说明符。 */
function staticImports(src: string): string[] {
  return [...src.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map(
    (m) => m[1],
  );
}

describe('冷启动不为调度运行时付费', () => {
  it('App 只挂薄壳 hook，不静态导入运行时核心', () => {
    const app = code('src/App.tsx');
    expect(staticImports(app)).not.toContain('./app/useSchedulerRuntime');
    expect(app).toMatch(/useSchedulerBoot\(hydrated\)/);
  });

  it('薄壳动态加载核心，并且只在加载完成且未卸载时启动', () => {
    const boot = code('src/app/useSchedulerBoot.ts');
    expect(staticImports(boot)).not.toContain('./useSchedulerRuntime');
    expect(boot).toContain("import('./useSchedulerRuntime')");
    expect(boot).toMatch(/if \(!disposed\) stop = core\.startSchedulerRuntime\(\)/);
  });

  it('核心先注册全部 handler 再启动调度器（排空永远看得见全部 handler）', () => {
    const core = code('src/app/useSchedulerRuntime.ts');
    const start = core.indexOf('export function startSchedulerRuntime');
    expect(start).toBeGreaterThan(-1);
    const body = core.slice(start);
    expect(body.indexOf('registerAllHandlers(deps)')).toBeGreaterThan(-1);
    expect(body.indexOf('registerAllHandlers(deps)')).toBeLessThan(body.indexOf('startScheduler()'));
  });
});

describe('Web 不为 SQLite 付费', () => {
  it('driver 对 ./sqlite 只有类型导入与动态导入', () => {
    const driver = code('src/db/driver.ts');
    expect(staticImports(driver)).not.toContain('./sqlite');
    expect(driver).toContain("import('./sqlite')");
  });

  it('设置页的迁移器也是点了才加载', () => {
    const page = code('src/features/settings/BackupPage.tsx');
    expect(staticImports(page)).not.toContain('../../db/migrate-to-sqlite');
  });
});

describe('常驻的通话胶囊不拖着通话引擎', () => {
  it('MiniCallPill 只依赖 call-store，不静态导入 call-host（那边挂着 CallSession 的构造）', () => {
    const pill = code('src/features/call/MiniCallPill.tsx');
    expect(staticImports(pill)).toContain('./call-store');
    expect(staticImports(pill)).not.toContain('./call-host');
    expect(staticImports(code('src/features/call/call-store.ts'))).not.toContain('../../ai/call-script');
  });
});

describe('会话列表不虚拟化', () => {
  it('src 里没有任何地方再导入 react-virtuoso', () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e.name) && staticImports(code(p)).includes('react-virtuoso')) hits.push(p);
      }
    };
    walk('src');
    expect(hits).toEqual([]);
  });
});
