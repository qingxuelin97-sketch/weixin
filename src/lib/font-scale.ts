/**
 * 字体大小 (M-K5)：微信 设置 › 通用 › 字体大小 的八档。
 *
 * 实现只有一个数：tokens.css 里全部 --fs-* 都是 `calc(Npx * var(--fs-scale))`，这里把
 * `--fs-scale` 写到 <html> 的内联 style 上。缩放的是**字**不是版式（头像、导航栏、
 * 间距不动）——与微信一致，也不会让截图基线在默认档下动哪怕一个像素（×1）。
 *
 * 偏好存 localStorage `ui.fontScale`（档位下标），理由同深色模式：首帧脚本要同步读它，
 * 否则大字号用户冷启动会先看见一帧小字再跳大；它也是设备显示偏好，不进备份。
 */
import { useSyncExternalStore } from 'react';

/** 八档系数。下标 1 是「标准」。 */
export const FONT_SCALES = [0.875, 1, 1.125, 1.25, 1.375, 1.5, 1.625, 1.75] as const;
export const STANDARD_INDEX = 1;
/** localStorage 键。index.html 的首帧脚本硬编码了同一个字面量——改名两处一起改。 */
export const FONT_SCALE_KEY = 'ui.fontScale';

/** 非法 / 缺省 / 越界 → 标准档。 */
export function parseFontIndex(raw: string | null | undefined): number {
  // 先判空：Number(null) 与 Number('') 都是 0——那是最小档，不是「没设过」。
  if (raw == null || raw.trim() === '') return STANDARD_INDEX;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n < FONT_SCALES.length ? n : STANDARD_INDEX;
}

export function getFontIndex(): number {
  try {
    return parseFontIndex(localStorage.getItem(FONT_SCALE_KEY));
  } catch {
    return STANDARD_INDEX;
  }
}

const listeners = new Set<() => void>();

export function applyFontScale(index: number = getFontIndex()): void {
  if (typeof document === 'undefined') return;
  const scale = FONT_SCALES[parseFontIndex(String(index))];
  const root = document.documentElement;
  // 标准档就把内联值去掉，回落到 tokens.css 的 1——DOM 与默认安装完全一致。
  if (scale === 1) root.style.removeProperty('--fs-scale');
  else root.style.setProperty('--fs-scale', String(scale));
}

export function setFontIndex(index: number): void {
  const i = parseFontIndex(String(index));
  try {
    if (i === STANDARD_INDEX) localStorage.removeItem(FONT_SCALE_KEY);
    else localStorage.setItem(FONT_SCALE_KEY, String(i));
  } catch {
    /* 写不进去：本次照样生效 */
  }
  applyFontScale(i);
  listeners.forEach((fn) => fn());
}

export function useFontIndex(): number {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getFontIndex,
    () => STANDARD_INDEX,
  );
}
