/**
 * 聊天页「＋」面板的线性图标 (M-K1)。
 *
 * 微信 8.0 的面板是白底圆角方块里一枚深灰线性图标——此前这里是**纯色方块、
 * 没有图标**，是全 App 最显眼的一处原型感。全部手绘 SVG（宪法：零 PNG），
 * `currentColor` 着色，所以深浅主题由 token 层一并负责。
 *
 * 统一规格：28×28 视框、1.7 线宽、圆头圆角——一组图标只要有一个线宽不同，
 * 排在一起就会「跳」。
 */
import type { ReactNode } from 'react';

function Glyph({ children, size = 28 }: { children: ReactNode; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 28 28"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

/** 相册：相框 + 山 + 太阳。 */
export function PanelAlbum() {
  return (
    <Glyph>
      <rect x="4" y="5.5" width="20" height="17" rx="2.5" />
      <path d="m4.6 19.2 5.6-5.6 4 4 3-3 6.2 6.2" />
      <circle cx="18.6" cy="10.6" r="1.8" />
    </Glyph>
  );
}

/** 拍摄：机身 + 取景凸起 + 镜头。 */
export function PanelCamera() {
  return (
    <Glyph>
      <path d="M4 10.5A2.5 2.5 0 0 1 6.5 8h3l1.8-2.5h5.4L18.5 8h3a2.5 2.5 0 0 1 2.5 2.5V20a2.5 2.5 0 0 1-2.5 2.5h-15A2.5 2.5 0 0 1 4 20z" />
      <circle cx="14" cy="15" r="4" />
    </Glyph>
  );
}

/** 视频通话：摄像机。 */
export function PanelVideoCall() {
  return (
    <Glyph>
      <rect x="3.5" y="7.5" width="15" height="13" rx="2.5" />
      <path d="m18.5 12.2 6-3.4v10.4l-6-3.4" />
    </Glyph>
  );
}

/** 语音通话（群里那一格）：听筒。 */
export function PanelVoiceCall() {
  return (
    <Glyph>
      <path d="m9.2 4.8 2.3 4.4c.3.6.2 1.3-.3 1.8l-1.6 1.6c1.2 2.6 3.2 4.6 5.8 5.8l1.6-1.6c.5-.5 1.2-.6 1.8-.3l4.4 2.3c.6.3.9 1 .7 1.7l-.6 2.2c-.3 1-1.2 1.6-2.2 1.5C12.4 23.6 4.4 15.6 3.8 7.9c-.1-1 .5-1.9 1.5-2.2l2.2-.6c.7-.2 1.4.1 1.7.7z" />
    </Glyph>
  );
}

/** 位置：定位针。 */
export function PanelLocation() {
  return (
    <Glyph>
      <path d="M14 24.5S6.5 17.5 6.5 12a7.5 7.5 0 0 1 15 0c0 5.5-7.5 12.5-7.5 12.5z" />
      <circle cx="14" cy="12" r="2.8" />
    </Glyph>
  );
}

/** 红包：竖信封 + 封口弧线 + 金币。 */
export function PanelRedPacket() {
  return (
    <Glyph>
      <rect x="6" y="3.5" width="16" height="21" rx="2.5" />
      <path d="M6.3 9.5c2.4 2 5 3 7.7 3s5.3-1 7.7-3" />
      <circle cx="14" cy="12.8" r="2.2" />
    </Glyph>
  );
}

/** 转账：圆圈里一对往返箭头。 */
export function PanelTransfer() {
  return (
    <Glyph>
      <circle cx="14" cy="14" r="10" />
      <path d="M9 11.5h10l-3-3M19 16.5H9l3 3" />
    </Glyph>
  );
}

/** 群收款：圆圈里一个 ¥。 */
export function PanelGroupBill() {
  return (
    <Glyph>
      <circle cx="14" cy="14" r="10" />
      <path d="m10.5 8.5 3.5 4.5 3.5-4.5M14 13v7M10.5 14.6h7M10.5 17.6h7" />
    </Glyph>
  );
}

/** 语音输入：麦克风。 */
export function PanelVoiceInput() {
  return (
    <Glyph>
      <rect x="10" y="3.5" width="8" height="13.5" rx="4" />
      <path d="M6.5 13.5a7.5 7.5 0 0 0 15 0M14 21v3.5" />
    </Glyph>
  );
}

/** 收藏：立方体（微信的收藏一直是个盒子）。 */
export function PanelFavorites() {
  return (
    <Glyph>
      <path d="m14 3.8 9 5v10.4l-9 5-9-5V8.8z" />
      <path d="M5.2 9 14 14l8.8-5M14 14v10" />
    </Glyph>
  );
}

/** 个人名片：卡片 + 头像 + 两行字。 */
export function PanelContactCard() {
  return (
    <Glyph>
      <rect x="3.5" y="6" width="21" height="16" rx="2.5" />
      <circle cx="10.5" cy="12.4" r="2.5" />
      <path d="M6.8 18.5c.6-1.8 2-2.8 3.7-2.8s3.1 1 3.7 2.8M16.5 11.5h5M16.5 15h4" />
    </Glyph>
  );
}

/** 文件：折角文档。 */
export function PanelFile() {
  return (
    <Glyph>
      <path d="M7.5 3.5h9l5 5V23a1.5 1.5 0 0 1-1.5 1.5H7.5A1.5 1.5 0 0 1 6 23V5a1.5 1.5 0 0 1 1.5-1.5z" />
      <path d="M16.5 3.5v5h5" />
    </Glyph>
  );
}
