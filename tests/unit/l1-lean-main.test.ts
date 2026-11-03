/**
 * 冷启动主包不为 LLM 运行时付费 (M-L1)——用**真的静态导入图**守。
 *
 * K11 的守卫只看「ai/ 之外谁静态导入了 ai/engine」，于是它看不见一条传递路径：
 * 发朋友圈页 → moments-service → moments-engine → engine。K11 的提交说「引擎树离开了
 * 冷启动主包」，实际上单聊引擎一直在里面，直到 M-L1 拿 source map 量主包时才发现。
 * 「谁导入了 X」这类守卫天生只看一层；这里改问正确的问题：**从 src/main.tsx 出发，只沿
 * 静态 import（不算 `import type`、不算动态 `import()`）走，能不能走到 X。**
 *
 * 走得到 = X 在冷启动主包里。棘轮最终也会红，但它只说「多了 30KB」，这里直接打印路径。
 */
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';

const ROOT = resolve(__dirname, '../../');
/** 宪法 3.5：先剥注释——解释「为什么不静态导入」的注释本身就含有那句导入。 */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

function resolveSpec(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  for (const ext of ['', '.ts', '.tsx', '/index.ts', '/index.tsx']) {
    const p = base + ext;
    if (existsSync(p) && statSync(p).isFile() && /\.(ts|tsx)$/.test(p)) return p;
  }
  return null;
}

/** Static, value-level import specifiers of one file. */
function staticSpecs(file: string): string[] {
  const src = strip(readFileSync(file, 'utf8'));
  const out: string[] = [];
  for (const m of src.matchAll(/^\s*(?:import|export)\s+(?!type\b)([^'";]*?)\s*from\s+['"]([^'"]+)['"]/gm)) {
    // `import { type A, type B } from …` is erased at build time.
    if (/^\{\s*(type\s+\w+\s*,?\s*)+\}$/.test(m[1].trim())) continue;
    out.push(m[2]);
  }
  for (const m of src.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) out.push(m[1]);
  return out;
}

/** BFS over static imports from `entry`; returns predecessor links and packages seen. */
function walk(entry: string) {
  const prev = new Map<string, string | null>([[entry, null]]);
  const pkgs = new Map<string, string>();
  const q = [entry];
  while (q.length) {
    const f = q.shift()!;
    for (const spec of staticSpecs(f)) {
      if (!spec.startsWith('.')) {
        if (!pkgs.has(spec)) pkgs.set(spec, f);
        continue;
      }
      const r = resolveSpec(f, spec);
      if (!r || prev.has(r)) continue;
      prev.set(r, f);
      q.push(r);
    }
  }
  return { prev, pkgs };
}

const rel = (f: string) => relative(ROOT, f);
function chain(prev: Map<string, string | null>, target: string): string {
  const out: string[] = [];
  for (let f: string | null | undefined = target; f; f = prev.get(f)) out.push(rel(f));
  return out.reverse().join(' → ');
}

const MAIN = resolve(ROOT, 'src/main.tsx');
const { prev, pkgs } = walk(MAIN);

describe('冷启动主包里没有 LLM 运行时（静态导入图）', () => {
  it('图是活的：主包确实走得到 App、store 与 ChatPage', () => {
    for (const f of ['src/App.tsx', 'src/store/appStore.ts', 'src/features/chat/ChatPage.tsx']) {
      expect(prev.has(resolve(ROOT, f)), `${f} 不在图里——解析器坏了，下面的断言会空转`).toBe(true);
    }
    expect(prev.size).toBeGreaterThan(150);
  });

  /** 这些只许出现在懒 chunk 里。每一条写明它是什么、为什么不该在首屏。 */
  const HEAVY: Record<string, string> = {
    'src/ai/engine.ts': '单聊引擎（prompt 分层、记忆、二十几个指令模块的入口）',
    'src/ai/moments-engine.ts': '朋友圈生成（拖着 engine 与 prompt）',
    'src/llm/service.ts': '配置 → Provider → 路由器的接线',
    'src/llm/router.ts': '路由与三级降级',
    'src/llm/openai-compatible.ts': 'Provider 基类',
    'src/llm/types.ts': 'BubbleSchema（zod）',
    'src/ai/story-schema.ts': '剧本 zod 校验',
    'src/ai/story-generate.ts': '剧本生成器（靠 zod 校验输出）',
  };
  for (const [file, what] of Object.entries(HEAVY)) {
    it(`${file} 不在主包里（${what}）`, () => {
      const abs = resolve(ROOT, file);
      expect(prev.has(abs), `走得到：${prev.has(abs) ? chain(prev, abs) : ''}`).toBe(false);
    });
  }

  it('zod 不在主包里', () => {
    expect(pkgs.has('zod'), `zod 由 ${pkgs.get('zod') && rel(pkgs.get('zod')!)} 带进主包`).toBe(false);
  });
});

describe('轻量模块保持轻量', () => {
  const LIGHT = ['src/llm/config.ts', 'src/llm/errors.ts', 'src/llm/preflight.ts', 'src/llm/preset-data.ts'];
  for (const file of LIGHT) {
    it(`${file} 的静态闭包里没有路由器、Provider、bubbles 或 zod`, () => {
      const w = walk(resolve(ROOT, file));
      const bad = ['src/llm/router.ts', 'src/llm/service.ts', 'src/llm/openai-compatible.ts', 'src/llm/types.ts', 'src/llm/bubbles.ts']
        .map((f) => resolve(ROOT, f))
        .filter((f) => w.prev.has(f))
        .map((f) => chain(w.prev, f));
      expect(bad).toEqual([]);
      expect(w.pkgs.has('zod')).toBe(false);
    });
  }
});

describe('配置页不导入路由器也能让它重建', () => {
  it('config.invalidateRouter 之后，getRouter 交出一个新的路由器', async () => {
    const { getRouter } = await import('../../src/llm/service');
    const { invalidateRouter } = await import('../../src/llm/config');
    const a = getRouter();
    expect(getRouter()).toBe(a); // singleton while nothing changed
    invalidateRouter();
    const b = getRouter();
    expect(b).not.toBe(a);
    await Promise.allSettled([a, b]);
  });

  it('service 仍转导出轻量那一半（老的导入点不必全改）', async () => {
    const svc = await import('../../src/llm/service');
    const cfg = await import('../../src/llm/config');
    expect(svc.hasUsableProvider).toBe(cfg.hasUsableProvider);
    expect(svc.invalidateRouter).toBe(cfg.invalidateRouter);
    expect(svc.withDeadline).toBe(cfg.withDeadline);
  });
});
