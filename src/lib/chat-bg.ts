/**
 * 聊天背景 (M-K5)：微信 设置 › 聊天 › 聊天背景（全局）与 聊天信息 › 设置当前聊天背景（单聊）。
 *
 * 存在 settings 表里（它是用户亲手选的、跟着备份走的东西，不是设备显示偏好）：
 *   - `chatBgDefault`        全局默认
 *   - `chatBg:<convId>`      某个会话自己的（覆盖全局；随会话删除级联，见 SETTINGS_KEY_CASCADE）
 * 两个键的字面量都内联写在调用点（宪法 §2：级联的源码扫描只认调用点上的模板串）。
 *
 * 预置背景是 tokens.css 里的 `--color-chatbg-*`（渐变 / 点阵纹理，零 PNG），深色模式下
 * 各有一套压暗的版本；「相册」背景是素材库里的一张图（`idb:` 引用）。
 */
import type { CSSProperties } from 'react';
import { resolveImageRef } from '../data/moments-images';

export const CHAT_BG_PRESETS = ['mist', 'peach', 'mint', 'lavender', 'dawn', 'sky', 'paper', 'night'] as const;
export type ChatBgPreset = (typeof CHAT_BG_PRESETS)[number];

/** `none` = 明确选了「不要背景」（会话级用它压过全局）。 */
export type ChatBg = { kind: 'none' } | { kind: 'preset'; id: ChatBgPreset } | { kind: 'image'; ref: string };

export const PRESET_LABEL: Record<ChatBgPreset, string> = {
  mist: '晨雾',
  peach: '蜜桃',
  mint: '薄荷',
  lavender: '薰衣草',
  dawn: '朝霞',
  sky: '晴空',
  paper: '信笺',
  night: '夜航',
};

/** 存储里读出来的东西不可信（旧版本、手改的备份）：认不出的一律当没设过。 */
export function parseChatBg(raw: unknown): ChatBg | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (r.kind === 'none') return { kind: 'none' };
  if (r.kind === 'preset' && CHAT_BG_PRESETS.includes(r.id as ChatBgPreset)) {
    return { kind: 'preset', id: r.id as ChatBgPreset };
  }
  if (r.kind === 'image' && typeof r.ref === 'string' && r.ref) return { kind: 'image', ref: r.ref };
  return undefined;
}

/** 会话自己的设置压过全局；都没有就是默认（无背景）。 */
export function resolveChatBg(perConv: ChatBg | undefined, global: ChatBg | undefined): ChatBg {
  return perConv ?? global ?? { kind: 'none' };
}

/** 落到聊天页上的样式。无背景 → undefined（DOM 与从没设过时完全一致）。 */
export function chatBgStyle(bg: ChatBg): CSSProperties | undefined {
  if (bg.kind === 'preset') return { background: `var(--color-chatbg-${bg.id})` };
  if (bg.kind === 'image') {
    const r = resolveImageRef(bg.ref);
    if (r.url) {
      return {
        backgroundImage: `url("${r.url}")`,
        backgroundSize: 'cover',
        backgroundPosition: 'center',
      };
    }
    // 图还没从库里物化出来（或被删了）：用它的占位渐变，形状不塌。
    return r.background ? { background: r.background } : undefined;
  }
  return undefined;
}
