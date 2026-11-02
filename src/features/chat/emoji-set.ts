/**
 * 表情面板的数据 (M-K2)。
 *
 * 微信的黄脸是腾讯自有的图片资产，不随仓库分发（同提示音的理由）；V1 起就约定用
 * Unicode emoji 顶替（PLAN：「黄脸表情（emoji）不需生图」）。这里的 120 个按微信
 * 经典表情的**语义**挑选与排序——微笑、撇嘴、色、发呆、得意、流泪……的近似，再接
 * 手势、爱心、玫瑰、蛋糕、红包、爆竹、啤酒、咖啡、吃瓜——而不是 Unicode 的码位顺序。
 * 只用 Unicode 12 及以前的字符：再新的在老一些的 Android 字体里会变成豆腐块。
 *
 * 15 行 × 8 列，正好填满微信面板的 8 列网格。
 */
export const EMOJI_SET: readonly string[] = [
  '😊', '😁', '😂', '🤣', '😃', '😄', '😅', '😆',
  '😉', '😋', '😎', '😍', '😘', '🥰', '😗', '😚',
  '🙂', '🤗', '🤩', '🤔', '🤨', '😐', '😑', '😶',
  '🙄', '😏', '😣', '😥', '😮', '🤐', '😯', '😪',
  '😫', '😴', '😌', '😛', '😜', '😝', '🤤', '😒',
  '😓', '😔', '😕', '🙃', '🤑', '😲', '🙁', '😖',
  '😞', '😟', '😤', '😢', '😭', '😦', '😧', '😨',
  '😩', '🤯', '😬', '😰', '😱', '🥵', '🥶', '😳',
  '🤪', '😵', '😡', '😠', '🤬', '😷', '🤒', '🤕',
  '🤢', '🤮', '🤧', '😇', '🥳', '🥺', '🤠', '🤡',
  '🤫', '🤭', '🧐', '🤓', '😈', '💀', '💩', '🙈',
  '👍', '👎', '👏', '🙏', '💪', '🤝', '✌️', '👌',
  '👋', '👊', '🤙', '👀', '❤️', '💔', '💯', '🔥',
  '🌹', '🥀', '🎉', '🎂', '🎁', '🧧', '🧨', '🍺',
  '☕', '🍉', '🌙', '☀️', '⭐', '💣', '🔪', '🐷',
];

/**
 * 「最近使用」：微信面板顶上那一行。存 localStorage——它是这台设备的输入习惯，
 * 不是关系资产，不进备份（与提示音开关、面板高度同一类）。
 */
export const RECENT_KEY = 'emoji.recent';
export const RECENT_MAX = 8;

/** 纯函数：移到最前、去重、截断。 */
export function pushRecent(list: readonly string[], e: string): string[] {
  return [e, ...list.filter((x) => x !== e)].slice(0, RECENT_MAX);
}

export function loadRecent(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string').slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

export function saveRecent(list: readonly string[]): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {
    /* 隐私模式写不进去：本次照常用，下次不记得 */
  }
}
