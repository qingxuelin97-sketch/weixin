/**
 * 主题引擎 (M-K0)：浅色 / 深色 / 跟随系统。
 *
 * 一切颜色都在 tokens.css 的 `[data-theme="dark"]` 块里重定义，所以「切主题」
 * 在运行时只做一件事：把 `<html data-theme>` 改成解析后的值。组件不读主题、
 * 不写条件分支——读了就说明有颜色绕过了 token 层。
 *
 * 偏好存在 localStorage 而不是 settings 表，理由与提示音开关相同：
 *   1. 它必须**同步**可读——index.html 的首帧脚本要在第一次绘制前就写好
 *      data-theme，否则深色手机冷启动会先闪一下浅色（IndexedDB 是异步的，
 *      等它读完首帧早画完了）；
 *   2. 它是这台设备的显示偏好，不是「关系资产」，不进 .aiwx 备份——换手机
 *      跟随新手机的系统设置才是对的。
 *
 * 首帧脚本（index.html）与这里读的是同一个键，守卫在 tests/unit/k0-theme.test.ts。
 */
import { useSyncExternalStore } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';
export type Theme = 'light' | 'dark';

/** localStorage 键。index.html 的首帧脚本硬编码了同一个字面量——改名要两处一起改。 */
export const THEME_KEY = 'ui.theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** 未知值一律回落到「跟随系统」——与微信的默认一致。 */
export function parseThemePref(raw: string | null | undefined): ThemePref {
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}

/** 纯函数：偏好 + 系统是否深色 → 最终主题。 */
export function resolveTheme(pref: ThemePref, systemDark: boolean): Theme {
  if (pref === 'system') return systemDark ? 'dark' : 'light';
  return pref;
}

export function getThemePref(): ThemePref {
  try {
    return parseThemePref(localStorage.getItem(THEME_KEY));
  } catch {
    return 'system';
  }
}

function systemPrefersDark(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia?.(DARK_QUERY).matches;
  } catch {
    return false;
  }
}

/** 此刻应当生效的主题。 */
export function currentTheme(): Theme {
  return resolveTheme(getThemePref(), systemPrefersDark());
}

type Listener = (theme: Theme) => void;
const listeners = new Set<Listener>();

/** 订阅「生效主题变了」——原生状态栏同步与 React hook 都走这里。 */
export function subscribeTheme(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * 导航栏底色，原样从 token 层读出来。
 *
 * 浏览器 theme-color 与原生状态栏都要一个具体颜色，而铁律 1 不许 src/ 里写色值——
 * 所以从生效中的 `--color-nav-bg` 读：自定义属性的计算值已经做过 var() 代换，
 * 拿到的就是 tokens.css 里那个字面量。
 */
export function navBarColor(): string {
  try {
    return getComputedStyle(document.documentElement).getPropertyValue('--color-nav-bg').trim();
  } catch {
    return '';
  }
}

let applied: Theme | null = null;

/** 把主题写到 <html> 上，并同步 theme-color；变化时通知订阅者。 */
export function applyTheme(theme: Theme = currentTheme()): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (root.dataset.theme !== theme) root.dataset.theme = theme;
  const color = navBarColor();
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta && color) meta.setAttribute('content', color);
  if (applied === theme) return;
  applied = theme;
  listeners.forEach((fn) => fn(theme));
}

/** 改偏好并立即生效。「跟随系统」= 删键（与首帧脚本的默认分支一致）。 */
export function setThemePref(pref: ThemePref): void {
  try {
    if (pref === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, pref);
  } catch {
    /* 隐私模式等写不进去：本次会话照样生效，只是下次不记得 */
  }
  applyTheme();
}

/**
 * 启动时调用一次：应用当前主题，并在「跟随系统」时监听系统切换。
 * 系统在 App 开着的时候从浅切深（日落自动切换）是常态，不是边角。
 */
export function installThemeWatcher(): () => void {
  applyTheme();
  let mq: MediaQueryList | undefined;
  try {
    mq = window.matchMedia?.(DARK_QUERY);
  } catch {
    mq = undefined;
  }
  const onChange = () => {
    if (getThemePref() === 'system') applyTheme();
  };
  mq?.addEventListener?.('change', onChange);
  return () => mq?.removeEventListener?.('change', onChange);
}

/** 当前生效主题（组件极少需要它——颜色全在 token 层；给设置页显示「已开启」用）。 */
export function useTheme(): Theme {
  return useSyncExternalStore(
    (cb) => subscribeTheme(() => cb()),
    currentTheme,
    () => 'light',
  );
}
