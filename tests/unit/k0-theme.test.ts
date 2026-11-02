// @vitest-environment jsdom
/**
 * 深色模式 (M-K0) 的三道守卫 + 主题引擎的行为测试。
 *
 * 1. **每个语义 token 都在深色下表态**：要么在 `[data-theme='dark']` 块里重定义，
 *    要么登记在 THEME_INVARIANT 并写明「为什么深浅一致」。漏表态的 token 在深色下
 *    保持浅色值——一块亮白补丁，而 CSS 不会报任何错（与 J13 的未定义变量同一类
 *    静默失效）。这与 NOTIFY_STANCE / SETTINGS_KEY_CASCADE 是同一个形状：
 *    **新增 token 不表态即转红**。
 * 2. **组件不许绕过语义层直接引用原始色板**：`var(--wx-page)` 写进组件，深色下
 *    就是一块 #EDEDED。只有图标色相（深浅主题一致的那几种）在白名单里。
 * 3. **首帧脚本与引擎同一套规则**：index.html 硬编码了 localStorage 键与媒体查询，
 *    改了一边忘了另一边，冷启动就会先闪一下错的主题。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  THEME_KEY,
  parseThemePref,
  resolveTheme,
  setThemePref,
  getThemePref,
  applyTheme,
  subscribeTheme,
} from '../../src/lib/theme';

const ROOT = resolve(__dirname, '../../');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const TOKENS = read('src/styles/tokens.css');

/** 剥注释（宪法 3.5：源码文本守卫必须先剥注释——解释 X 的注释本身含有 X）。 */
const stripCssComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');

function darkBlock(): string {
  const src = stripCssComments(TOKENS);
  const start = src.indexOf(":root[data-theme='dark']");
  expect(start, "tokens.css 里没有 :root[data-theme='dark'] 块").toBeGreaterThan(-1);
  const open = src.indexOf('{', start);
  const close = src.indexOf('\n}', open);
  return src.slice(open + 1, close);
}

const declared = (block: string, prefix: string) =>
  new Set([...block.matchAll(new RegExp(`(${prefix}[\\w-]*)\\s*:`, 'g'))].map((m) => m[1]));

/** 浅色语义层：全文件里的 --color-* 声明，减去深色块里的那些。 */
function lightSemantic(): Set<string> {
  const src = stripCssComments(TOKENS);
  const dark = darkBlock();
  return declared(src.replace(dark, ''), '--color-');
}

/**
 * 深浅一致的语义 token —— 每一条都是一个「为什么」。
 *
 * 判据只有一条：它画在一个**自带底色**的面上（品牌绿按钮、红包、通话页、年度报告、
 * 一张图片），而那个面本身不随主题变。画在页面底色上的东西不许进这张表。
 */
const THEME_INVARIANT: Record<string, string> = {
  '--color-text-on-brand': '白字压在品牌绿 / 彩色按钮上，底色不变字也不变',
  '--color-brand': '品牌绿 #07C160 —— WeUI 深浅两套同值',
  '--color-brand-pressed': '品牌绿的按下态，随品牌绿',
  '--color-badge': '未读红点 —— WeUI RED 深浅同值',
  '--color-wxstatus-blue': '状态胶囊色相，画在自己的彩色胶囊里',
  '--color-wxstatus-green': '状态胶囊色相',
  '--color-wxstatus-violet': '状态胶囊色相',
  '--color-wxstatus-amber': '状态胶囊色相',
  '--color-wxstatus-pink': '状态胶囊色相',
  '--color-tabbar-icon-active': '选中 tab 是品牌绿',
  '--color-rp-envelope': '红包本体就是红的——它是一张「图」，不是界面底色',
  '--color-rp-envelope-hi': '红包高光',
  '--color-rp-coin': '红包金币',
  '--color-rp-open-bg': '拆红包卡的红',
  '--color-black-scrim': '已经是黑色半透明（侧滑返回时压暗下层页）',
  '--color-swipe-danger': '左滑「删除」是红色',
  '--color-viewer-bg': '看图背景本来就是纯黑',
  '--color-call-bg': '通话页本身就是深色设计',
  '--color-call-hangup': '挂断红',
  '--color-call-accept': '接听绿',
  '--color-call-pill-bg': '通话悬浮胶囊是品牌绿',
  '--color-call-secondary-btn': '深色通话底上的半透明白按钮',
  '--color-call-speaking-glow': '视频画面下沿的说话光',
  '--color-voice-scrim': '按住说话浮层本就是深色底',
  '--color-voice-text': '深色浮层上的白字',
  '--color-voice-cancel': '上滑取消的红',
  '--color-on-color-divider': '叠在彩色面上的白色分割线',
  '--color-on-color-fill': '叠在彩色面上的半透明白',
  '--color-report-bg-a': '年度报告是自成一体的深绿夜色设计',
  '--color-report-bg-b': '年度报告',
  '--color-report-card': '年度报告',
  '--color-report-text': '年度报告',
  '--color-report-dim': '年度报告',
  '--color-report-hairline': '年度报告',
  '--color-report-accent': '年度报告',
  '--color-report-bar': '年度报告',
  '--color-status-pos': '状态条的正向色相（画在轨道里）',
  '--color-status-neg': '状态条的负向色相',
  '--color-moments-cover-a': '朋友圈封面占位渐变——它代替的是一张照片',
  '--color-moments-cover-b': '朋友圈封面占位渐变',
};

/**
 * 组件里允许直接出现的原始色：只有图标色相。它们是「这个图标是蓝的」，
 * 不是「这块底是浅的」，深浅主题下都一样。其余任何 `var(--wx-*)` 都应该
 * 先在 tokens.css 里起一个语义别名。
 */
const ICON_HUES = new Set([
  '--wx-dc-red',
  '--wx-dc-orange',
  '--wx-dc-yellow',
  '--wx-dc-green',
  '--wx-dc-blue',
  '--wx-dc-purple',
  '--wx-dc-gray',
  '--wx-fn-orange',
  '--wx-fn-blue',
  '--wx-fn-deep-blue',
  '--wx-fn-light-blue',
  '--wx-gold',
]);

describe('深色 token 表态台账', () => {
  it('解析器没有失明：两边都读到了一大批 token', () => {
    expect(lightSemantic().size).toBeGreaterThan(60);
    expect(declared(darkBlock(), '--color-').size).toBeGreaterThan(30);
  });

  it('每个浅色语义 token 都在深色下表态（重定义，或登记为深浅一致）', () => {
    const dark = declared(darkBlock(), '--color-');
    const silent = [...lightSemantic()].filter((t) => !dark.has(t) && !(t in THEME_INVARIANT));
    expect(
      silent,
      '这些 token 在深色下保持浅色值——要么在深色块里重定义，要么进 THEME_INVARIANT 写明理由',
    ).toEqual([]);
  });

  it('不许既重定义又声称深浅一致（两种表态互斥）', () => {
    const dark = declared(darkBlock(), '--color-');
    expect(Object.keys(THEME_INVARIANT).filter((t) => dark.has(t))).toEqual([]);
  });

  it('台账里没有幽灵条目（token 改名/删除后要一起摘）', () => {
    const light = lightSemantic();
    expect(Object.keys(THEME_INVARIANT).filter((t) => !light.has(t))).toEqual([]);
  });

  it('深色块只重定义已有的语义 token（防打错名字——打错的那条什么也不覆盖）', () => {
    const light = lightSemantic();
    expect([...declared(darkBlock(), '--color-')].filter((t) => !light.has(t))).toEqual([]);
  });

  it('深色块里只引用深色原始色板 --wxd-*（分层：语义层不写字面量、不借浅色原始色）', () => {
    const body = darkBlock();
    const refs = [...body.matchAll(/var\(\s*(--[\w-]+)\s*\)/g)].map((m) => m[1]);
    expect(refs.length).toBeGreaterThan(30);
    expect(refs.filter((r) => !r.startsWith('--wxd-'))).toEqual([]);
    // 声明值里除了 var(--wxd-*) 不许有别的颜色字面量
    expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });
});

describe('组件不绕过语义层', () => {
  function srcFiles(): string[] {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(css|tsx|ts)$/.test(e.name) && !p.endsWith('tokens.css')) out.push(p);
      }
    };
    walk('src');
    return out;
  }

  it('组件里的原始色引用只限图标色相', () => {
    const offenders: string[] = [];
    for (const f of srcFiles()) {
      const src = read(f);
      for (const m of src.matchAll(/var\(\s*(--wxd?-[\w-]+)/g)) {
        if (!ICON_HUES.has(m[1])) offenders.push(`${f}: ${m[1]}`);
      }
    }
    expect(
      offenders,
      '组件直接引用了会随主题变的原始色——深色下它会是一块浅色补丁；先在 tokens.css 起语义别名',
    ).toEqual([]);
  });

  it('图标色相白名单里的每一个都真的存在于原始色板', () => {
    const raw = declared(stripCssComments(TOKENS), '--wx-');
    expect([...ICON_HUES].filter((h) => !raw.has(h))).toEqual([]);
  });
});

describe('首帧脚本 ↔ 主题引擎', () => {
  const html = read('index.html');
  const inline = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? '';

  it('index.html 有一段同步的首帧脚本，且排在 module 入口之前', () => {
    expect(inline.length).toBeGreaterThan(0);
    expect(html.indexOf('<script>')).toBeLessThan(html.indexOf('type="module"'));
  });

  it('读同一个 localStorage 键、同一个媒体查询、写同一个属性', () => {
    expect(inline).toContain(`'${THEME_KEY}'`);
    expect(inline).toContain('(prefers-color-scheme: dark)');
    expect(inline).toContain("'data-theme'");
  });
});

describe('主题引擎', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  it('parseThemePref：只认 light/dark，其余一律跟随系统', () => {
    expect(parseThemePref('light')).toBe('light');
    expect(parseThemePref('dark')).toBe('dark');
    expect(parseThemePref(null)).toBe('system');
    expect(parseThemePref('')).toBe('system');
    expect(parseThemePref('DARK')).toBe('system');
  });

  it('resolveTheme 真值表', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });

  it('setThemePref 写键并立即生效；跟随系统 = 删键（与首帧脚本的默认分支一致）', () => {
    setThemePref('dark');
    expect(localStorage.getItem(THEME_KEY)).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    setThemePref('system');
    expect(localStorage.getItem(THEME_KEY)).toBeNull();
    expect(getThemePref()).toBe('system');
    // jsdom 没有 matchMedia → 系统视为浅色
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('订阅者只在生效主题真的变化时被叫（原生状态栏不被重复刷）', () => {
    const seen: string[] = [];
    const off = subscribeTheme((t) => seen.push(t));
    setThemePref('dark');
    applyTheme('dark');
    applyTheme('dark');
    setThemePref('light');
    off();
    expect(seen).toEqual(['dark', 'light']);
  });
});
