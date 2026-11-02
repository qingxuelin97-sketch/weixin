// @vitest-environment jsdom
/**
 * 字体大小 + 聊天背景 (M-K5)。
 *
 * 字体大小那条真坑写在最前面：`Number(null)` 是 0，而 0 号档是**最小**档——首帧
 * 脚本和 parseFontIndex 的第一版都把「没设过」读成了「设成了最小」，每一个新装的
 * 用户都会看见一号小字。截图门禁抓不到它：标准档不写内联值，所以基线一像素不动，
 * 错的只是首帧脚本那条分支——只有在 jsdom 里真的跑一遍那段脚本才看得见。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  FONT_SCALES,
  FONT_SCALE_KEY,
  STANDARD_INDEX,
  parseFontIndex,
  setFontIndex,
  getFontIndex,
} from '../../src/lib/font-scale';
import {
  CHAT_BG_PRESETS,
  chatBgStyle,
  parseChatBg,
  resolveChatBg,
} from '../../src/lib/chat-bg';

const ROOT = resolve(__dirname, '../../');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const TOKENS = read('src/styles/tokens.css').replace(/\/\*[\s\S]*?\*\//g, '');

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('style');
});

describe('字体大小：档位解析', () => {
  it('没设过 / 空串 / 越界 / 非数字 → 标准档（不是 0 号最小档）', () => {
    expect(parseFontIndex(null)).toBe(STANDARD_INDEX);
    expect(parseFontIndex(undefined)).toBe(STANDARD_INDEX);
    expect(parseFontIndex('')).toBe(STANDARD_INDEX);
    expect(parseFontIndex('9')).toBe(STANDARD_INDEX);
    expect(parseFontIndex('-1')).toBe(STANDARD_INDEX);
    expect(parseFontIndex('1.5')).toBe(STANDARD_INDEX);
    expect(parseFontIndex('abc')).toBe(STANDARD_INDEX);
    expect(parseFontIndex('0')).toBe(0);
    expect(parseFontIndex('7')).toBe(7);
  });

  it('标准档是 ×1，且档位单调递增', () => {
    expect(FONT_SCALES[STANDARD_INDEX]).toBe(1);
    for (let i = 1; i < FONT_SCALES.length; i++) expect(FONT_SCALES[i]).toBeGreaterThan(FONT_SCALES[i - 1]);
  });

  it('改档：写键 + 写内联 --fs-scale；回到标准档 = 删键 + 删内联值（DOM 与新装一致）', () => {
    setFontIndex(5);
    expect(localStorage.getItem(FONT_SCALE_KEY)).toBe('5');
    expect(document.documentElement.style.getPropertyValue('--fs-scale')).toBe(String(FONT_SCALES[5]));
    expect(getFontIndex()).toBe(5);
    setFontIndex(STANDARD_INDEX);
    expect(localStorage.getItem(FONT_SCALE_KEY)).toBeNull();
    expect(document.documentElement.style.getPropertyValue('--fs-scale')).toBe('');
  });
});

describe('字体大小：token 层', () => {
  const fsDecls = [...TOKENS.matchAll(/(--fs-[\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()] as const);

  it('解析器读到了全部字号 token', () => {
    expect(fsDecls.length).toBeGreaterThanOrEqual(12);
  });

  it('除了未读角标，每个 --fs-* 都乘 --fs-scale', () => {
    const fixed = fsDecls.filter(
      ([name, v]) => name !== '--fs-scale' && name !== '--fs-badge' && !/calc\(\s*\d+px \* var\(--fs-scale\)\s*\)/.test(v),
    );
    expect(fixed, '这些字号不会跟着「字体大小」变').toEqual([]);
  });

  it('角标刻意不缩放（定尺寸的圆，字变大就撑破）', () => {
    expect(fsDecls.find(([n]) => n === '--fs-badge')?.[1]).toBe('11px');
  });
});

describe('字体大小：首帧脚本', () => {
  const html = read('index.html');
  const inline = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';

  it('与 font-scale.ts 同一个键、同一张档位表', () => {
    expect(inline).toContain(`'${FONT_SCALE_KEY}'`);
    expect(inline).toContain(`[${FONT_SCALES.join(', ')}]`);
  });

  /** 在 jsdom 里真的跑一遍首帧脚本。 */
  const runInline = () => new Function(inline)();

  it('没设过时什么都不写（Number(null)===0 的坑）', () => {
    runInline();
    expect(document.documentElement.style.getPropertyValue('--fs-scale')).toBe('');
  });

  it('设过时在首帧就写好内联值', () => {
    localStorage.setItem(FONT_SCALE_KEY, '6');
    runInline();
    expect(document.documentElement.style.getPropertyValue('--fs-scale')).toBe(String(FONT_SCALES[6]));
  });
});

describe('聊天背景', () => {
  it('存储里的脏数据一律当没设过', () => {
    expect(parseChatBg(null)).toBeUndefined();
    expect(parseChatBg('mist')).toBeUndefined();
    expect(parseChatBg({ kind: 'preset', id: 'no-such' })).toBeUndefined();
    expect(parseChatBg({ kind: 'image', ref: '' })).toBeUndefined();
    expect(parseChatBg({ kind: 'preset', id: 'mint' })).toEqual({ kind: 'preset', id: 'mint' });
    expect(parseChatBg({ kind: 'none' })).toEqual({ kind: 'none' });
  });

  it('会话自己的压过全局；会话明确选「无」也压过全局；都没有 = 无', () => {
    const g = { kind: 'preset', id: 'sky' } as const;
    expect(resolveChatBg(undefined, g)).toEqual(g);
    expect(resolveChatBg({ kind: 'preset', id: 'mint' }, g)).toEqual({ kind: 'preset', id: 'mint' });
    expect(resolveChatBg({ kind: 'none' }, g)).toEqual({ kind: 'none' });
    expect(resolveChatBg(undefined, undefined)).toEqual({ kind: 'none' });
  });

  it('无背景不写任何样式（聊天页 DOM 与从没设过时完全一致）', () => {
    expect(chatBgStyle({ kind: 'none' })).toBeUndefined();
  });

  it('每个预置都有浅色 token，且在深色块里也重定义了（否则深色下是一张亮图）', () => {
    const darkStart = TOKENS.indexOf(":root[data-theme='dark']");
    const light = TOKENS.slice(0, darkStart);
    const dark = TOKENS.slice(darkStart);
    for (const id of CHAT_BG_PRESETS) {
      const style = chatBgStyle({ kind: 'preset', id });
      expect(style?.background).toBe(`var(--color-chatbg-${id})`);
      expect(light, `缺浅色 --color-chatbg-${id}`).toContain(`--color-chatbg-${id}:`);
      expect(dark, `缺深色 --color-chatbg-${id}`).toContain(`--color-chatbg-${id}:`);
    }
  });

  it('两个设置键都登记进了删除级联台账（会话级的随会话消亡）', () => {
    const repo = read('src/db/repo.ts');
    expect(repo).toMatch(/'chatBg:':\s*\{\s*scope: 'conv',\s*row: 'cascade'/);
    expect(repo).toMatch(/chatBgDefault:\s*\{\s*scope: 'global'/);
  });
});
