/**
 * 消息长按菜单的白色线性图标 (M-K2)。
 *
 * 微信 8.0 的消息菜单是一块深色圆角面板，每格「图标在上、字在下」，一行五格。
 * 此前这里是一条横排纯文字胶囊——十个动作排成一排，后六个直接出了屏幕右边。
 *
 * 图标按菜单项的**文案**选（菜单项只有 label + onSelect，是故意的：调用方不该
 * 为了换个图标去改接口）。「取消置顶」「替换置顶」与「置顶」同一枚；没认出来的
 * 文案落到一枚中性的圆点，而不是空白——空格子会被读成「坏了」。
 */
import type { ReactNode } from 'react';

function G({ children }: { children: ReactNode }) {
  return (
    <svg
      width={22}
      height={22}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

const COPY = (
  <G>
    <rect x="8" y="8" width="12" height="12" rx="2" />
    <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
  </G>
);
const RECALL = (
  <G>
    <path d="M9 14 4 9l5-5" />
    <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  </G>
);
const QUOTE = (
  <G>
    <path d="M10 7H6.5A1.5 1.5 0 0 0 5 8.5V12h5V7zm0 5c0 3-1.5 5-4.5 5.5M19 7h-3.5A1.5 1.5 0 0 0 14 8.5V12h5V7zm0 5c0 3-1.5 5-4.5 5.5" />
  </G>
);
const REGEN = (
  <G>
    <path d="M20 12a8 8 0 1 1-2.3-5.6" />
    <path d="M20 4v4.5h-4.5" />
  </G>
);
const RESAY = (
  <G>
    <path d="M12 4C7 4 3.5 7.1 3.5 11c0 2.1 1.1 4 2.8 5.3L5.5 20l3.8-2c.9.2 1.8.3 2.7.3 5 0 8.5-3.1 8.5-7.3S17 4 12 4z" />
    <path d="M15 9.5a3.2 3.2 0 1 0 .3 2.5M15.5 8v2h-2" />
  </G>
);
const FORWARD = (
  <G>
    <path d="m14 5 6 6-6 6" />
    <path d="M20 11H10a6 6 0 0 0-6 6v2" />
  </G>
);
const FAVORITE = (
  <G>
    <path d="m12 3 8 4.5v9L12 21l-8-4.5v-9z" />
    <path d="M4.2 7.6 12 12l7.8-4.4M12 12v9" />
  </G>
);
const TO_TEXT = (
  <G>
    <path d="M4 6h10M9 6v12M14 11h6M17 11v7" />
  </G>
);
const TRANSLATE = (
  <G>
    <path d="M4 5h9M8.5 5v1.5c0 3.5-2 6.2-4.5 7.5M6.5 9.5c1.2 2.3 3.3 4 6 4.5" />
    <path d="m13 20 4-9 4 9M14.5 17h5" />
  </G>
);
const PIN = (
  <G>
    <path d="M5 4h14M12 20V9M7.5 13.5 12 9l4.5 4.5" />
  </G>
);
const MULTI = (
  <G>
    <rect x="3.5" y="4" width="7" height="7" rx="1.5" />
    <path d="m5.4 7.6 1.4 1.4 2.4-2.6M14 6.5h6.5M3.5 15h17M3.5 19.5h17" />
  </G>
);
const DELETE = (
  <G>
    <path d="M4 7h16M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4l.8-12M10 11v6M14 11v6" />
  </G>
);
const FALLBACK = (
  <G>
    <circle cx="12" cy="12" r="7.5" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none" />
  </G>
);

/** 文案 → 图标。按「包含」匹配，所以「取消置顶」「收起翻译」不用逐条登记。 */
const RULES: Array<[RegExp, ReactNode]> = [
  [/复制/, COPY],
  [/撤回/, RECALL],
  [/引用/, QUOTE],
  [/重新生成/, REGEN],
  [/重说/, RESAY],
  [/转发/, FORWARD],
  [/收藏/, FAVORITE],
  [/转文字|转写/, TO_TEXT],
  [/翻译/, TRANSLATE],
  [/置顶/, PIN],
  [/多选/, MULTI],
  [/删除/, DELETE],
];

export function menuIcon(label: string): ReactNode {
  for (const [re, icon] of RULES) if (re.test(label)) return icon;
  return FALLBACK;
}

/** 测试用：这枚图标是不是兜底的那一枚。 */
export function isFallbackIcon(label: string): boolean {
  return menuIcon(label) === FALLBACK;
}
