// @vitest-environment jsdom
/**
 * 动效与手感 (M-K12)。
 *
 * 写在最前面的是这一期的发现方式：气泡按压的两个 token（`--color-bubble-self-pressed`
 * / `--color-bubble-other-pressed`）从 M1 起就定义在 tokens.css 里，深浅两套都有，
 * **全仓没有一处用过**——按住气泡从来不会变色。J13 的守卫管「用了却没定义」（画不出来、
 * 不报错），反过来的「定义了却没人用」同样不报错：它就是「写了没接线」在样式层的样子。
 * 所以这里补上另一半：每一个 `--color-*` 都必须有人用，动态拼出来的前缀走有名有由的台账。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { render, cleanup, act } from '@testing-library/react';

// vi.hoisted: the vi.mock factories below are hoisted above every top-level
// declaration, so whatever they close over must be hoisted with them.
const { native, impact } = vi.hoisted(() => ({ native: { on: true }, impact: vi.fn(async () => {}) }));
vi.mock('@capacitor/core', async (orig) => {
  const real = await orig<typeof import('@capacitor/core')>();
  return { ...real, Capacitor: { ...real.Capacitor, isNativePlatform: () => native.on } };
});
vi.mock('@capacitor/haptics', () => ({ Haptics: { impact }, ImpactStyle: { Light: 'LIGHT' } }));

import { pressHaptic, setVibrateEnabled } from '../../src/lib/sound';
import { LongPressMenu } from '../../src/components/LongPressMenu';

const ROOT = resolve(__dirname, '../../');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');

afterEach(cleanup);
beforeEach(() => {
  impact.mockClear();
  native.on = true;
  localStorage.clear();
});

describe('定义了却没人用的颜色 token 不许存在（J13 的另一半）', () => {
  /** 前缀 → 谁在运行时拼出它。拼出来的引用源码扫描看不见，所以必须点名。 */
  const DYNAMIC: Record<string, { file: string; literal: string }> = {
    '--color-chatbg-': { file: 'src/lib/chat-bg.ts', literal: 'var(--color-chatbg-${' },
  };

  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.(css|tsx?)$/.test(e.name) && !p.endsWith('tokens.css')) out.push(p);
    }
    return out;
  }

  it('每个 --color-* 都有人引用', () => {
    const tokens = strip(read('src/styles/tokens.css'));
    const defined = new Set([...tokens.matchAll(/(--color-[\w-]+)\s*:/g)].map((m) => m[1]));
    // References inside tokens.css count too (a semantic alias of an alias),
    // but not the definition itself.
    const corpus =
      walk('src').map((f) => strip(read(f))).join('\n') + tokens.replace(/(--color-[\w-]+)\s*:/g, '');
    const unused = [...defined].filter(
      (t) => !corpus.includes(t) && !Object.keys(DYNAMIC).some((p) => t.startsWith(p)),
    );
    expect(unused, '这些 token 定义了却从没被用过——要么接上，要么删掉').toEqual([]);
  });

  it('台账里的动态前缀还真的被那样拼着（否则台账在撒谎）', () => {
    for (const [prefix, { file, literal }] of Object.entries(DYNAMIC)) {
      expect(read(file), `${prefix} 的动态引用不在 ${file} 了`).toContain(literal);
    }
  });
});

describe('气泡按压', () => {
  const css = strip(read('src/features/chat/chat.css'));

  it('气泡与尾巴都读 --bubble-bg（默认回落到本色）', () => {
    for (const side of ['self', 'other']) {
      expect(css).toMatch(new RegExp(`\\.bubble--${side} \\{[^}]*background: var\\(--bubble-bg, var\\(--color-bubble-${side}\\)\\)`));
      expect(css).toMatch(new RegExp(`\\.bubble--${side}::before \\{[^}]*var\\(--bubble-bg, var\\(--color-bubble-${side}\\)\\)`));
    }
  });

  it('按住与长按菜单开着时（.msg-held）换成 pressed 色', () => {
    for (const side of ['self', 'other']) {
      expect(css).toMatch(
        new RegExp(
          `\\.bubble--${side}:active,\\s*\\.msg-held \\.bubble--${side} \\{\\s*--bubble-bg: var\\(--color-bubble-${side}-pressed\\);`,
        ),
      );
    }
  });

  it('线程区给菜单指着的那一行加 msg-held；页面把菜单的目标传下去', () => {
    expect(read('src/features/chat/ChatThread.tsx')).toContain("heldId === row.msg.id && 'msg-held'");
    expect(read('src/features/chat/ChatPage.tsx')).toContain('heldId={menu?.msg.id ?? null}');
  });
});

describe('长按触感', () => {
  it('菜单每打开一次轻震一下', async () => {
    setVibrateEnabled(true);
    await act(async () => {
      render(<LongPressMenu items={[{ label: '复制', onSelect: () => {} }]} at={{ x: 10, y: 10 }} onClose={() => {}} />);
    });
    expect(impact).toHaveBeenCalledTimes(1);
  });

  it('关了「振动」就一下都不震；网页端从不震', () => {
    setVibrateEnabled(false);
    pressHaptic();
    expect(impact).not.toHaveBeenCalled();
    setVibrateEnabled(true);
    native.on = false;
    pressHaptic();
    expect(impact).not.toHaveBeenCalled();
    native.on = true;
    pressHaptic();
    expect(impact).toHaveBeenCalledTimes(1);
  });
});

describe('开关圆钮', () => {
  it('有自己的 token，不再借 cell 底色（深色下是一颗黑扣子）', () => {
    const css = strip(read('src/features/settings/settings.css'));
    expect(css).toMatch(/\.switch__knob \{[^}]*background: var\(--color-switch-knob\)/);
    expect(strip(read('src/styles/tokens.css'))).toMatch(/--color-switch-knob: var\(--wx-white\)/);
  });
});
