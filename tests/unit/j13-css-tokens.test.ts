/**
 * 终局加固 (M-J13)：CSS 变量必须真的存在。
 *
 * 铁律 1 的守卫（`check-no-hardcoded-colors.mjs`）管的是「有没有人写死颜色」。
 * 它管不了反过来那半边：**引用了一个不存在的 token**。
 * `background: var(--color-cell-pressed)` 里那个 token 从来没定义过——CSS 不会
 * 报错，它只是什么也不画；按下态于是静默消失，颜色检查照样绿，截图门禁
 * 也未必覆盖到那个瞬时状态。我在 M-J7 写语音模式时刚踩了一次，是顺手 grep
 * tokens.css 才发现的，不是任何门禁告诉我的。
 *
 * 所以这条守的是「token 名字打错/改名后遗留」这一整类静默失效。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const ROOT = resolve(__dirname, '../../');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

function cssFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.css')) out.push(p);
    }
  };
  walk('src');
  return out;
}

/** Every `--name:` declared anywhere (tokens.css and any local definitions). */
function declaredVars(files: string[]): Set<string> {
  const set = new Set<string>();
  for (const f of files) {
    for (const m of read(f).matchAll(/(--[\w-]+)\s*:/g)) set.add(m[1]);
  }
  return set;
}

/**
 * Every `var(--name)` reference WITHOUT a fallback.
 *
 * `var(--x, something)` is excluded on purpose: a fallback is an explicit
 * decision about what happens when the token is absent, which is the opposite
 * of the silent failure this test exists to catch.
 */
function referencedVars(files: string[]): Array<{ file: string; name: string }> {
  const out: Array<{ file: string; name: string }> = [];
  for (const f of files) {
    for (const m of read(f).matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) out.push({ file: f, name: m[1] });
  }
  return out;
}

/**
 * Custom properties that are SET AT RUNTIME (inline styles / JS), so they never
 * appear as a `--x:` declaration in any stylesheet — and must not be reported.
 *
 * A ledger rather than a pattern match, for the usual reason: each of these is
 * a claim that something really does set it, and a typo'd runtime var fails
 * exactly as silently as a typo'd token.
 */
const RUNTIME_SET_VARS: Record<string, string> = {
  '--i': 'voice-input 波形第 n 根柱子的序号，由 VoiceInput 逐条内联设置',
  '--nav-alpha': '朋友圈导航栏随滚动的不透明度，由 MomentsPage 在滚动回调里设置',
  '--roll-delay': '红包金额数字滚动的逐位延迟，由 money 页内联设置',
  '--msg-origin': '气泡进场动画的 transform-origin，由 MessageBubble 按左右内联设置',
  '--stagger-delay': '列表错峰进场的第 n 项延迟，由列表容器内联设置',
  '--chip-tint': '微信「状态」胶囊/格子的色调（M-J7），由 StatusSetPage/MePage/资料页内联设置',
  '--status-tint': '头像状态圈的色调（M-J7），由 Avatar 按 status.tint 内联设置',
  '--quota-pct': '存储配额条的填充百分比（M-J10），由 StoragePage 按 estimate() 内联设置',
};

describe('CSS 变量引用完整性', () => {
  const files = cssFiles();

  it('扫到了 CSS（守卫不能空转）', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => f.endsWith('tokens.css'))).toBe(true);
  });

  it('运行时变量台账里每一条都真的有人在设它（幽灵条目要摘掉）', () => {
    const tsxSrc = (() => {
      const acc: string[] = [];
      const walk = (dir: string) => {
        for (const e of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
          const p = join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name.endsWith('.tsx') || e.name.endsWith('.ts')) acc.push(read(p));
        }
      };
      walk('src');
      return acc.join('\n');
    })();
    for (const name of Object.keys(RUNTIME_SET_VARS)) {
      expect(tsxSrc, `${name} 声称由运行时设置，但源码里没人设它`).toContain(`'${name}'`);
    }
  });

  it('每个 var(--x) 引用的 token 都真的被定义过', () => {
    const declared = declaredVars(files);
    const missing = referencedVars(files)
      .filter(({ name }) => !declared.has(name) && !(name in RUNTIME_SET_VARS))
      .map(({ file, name }) => `${file} 引用了未定义的 ${name}`);
    expect(
      missing,
      '未定义的 CSS 变量不会报错，只会什么都不画——按下态/边框/阴影就这么静默消失了',
    ).toEqual([]);
  });

  // 内联样式里的 var() 同样会静默失效，而 .tsx 不在上面的扫描范围里。
  it('组件内联样式引用的 token 也必须存在', () => {
    const declared = declaredVars(files);
    const tsx: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.tsx')) tsx.push(p);
      }
    };
    walk('src');
    const missing: string[] = [];
    for (const f of tsx) {
      for (const m of read(f).matchAll(/var\(\s*(--[\w-]+)\s*\)/g)) {
        if (!declared.has(m[1]) && !(m[1] in RUNTIME_SET_VARS)) {
          missing.push(`${f} 引用了未定义的 ${m[1]}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
