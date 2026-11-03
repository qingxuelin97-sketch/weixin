// @vitest-environment jsdom
/**
 * 消息细节 (M-L3)：两处一直错着、却没有任何东西会报的地方。
 *
 * 一、系统提示行（撤回、拍一拍、群通知、邀请）从来没居中过。线程给每条消息套了一层
 * `data-msg-id` 的 div（块级盒子），`.msg-system` 的 `align-self: center` 在那里不生效——
 * 每一行都是贴左、通栏的一条灰带。种子里没有系统行，所以没有一张 golden 见过它。
 * 这里能做的是把版式写成在两种上下文里都成立的样子（auto 外边距 + fit-content），并钉住
 * 「行外壳是块级」这个前提；真正看像素的是 L3 的消息细节 golden。
 *
 * 二、图片只靠 max-width/max-height 等比缩：长截图成了一条缝、全景成了一道线、小图成了一个点。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { MessageBubble } from '../../src/features/chat/MessageBubble';
import { registerMedia } from '../../src/data/media-registry';
import {
  IMG_MAX_H,
  IMG_MAX_W,
  IMG_MIN_SIDE,
  IMG_RATIO_MAX,
  IMG_RATIO_MIN,
  imageBox,
  measureImage,
  storedImageSize,
} from '../../src/lib/image-box';
import type { ContactVM, MessageVM } from '../../src/data/types';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
/** 宪法 3.5：先剥注释再扫。 */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');

afterEach(cleanup);

describe('图片的框', () => {
  it('普通照片落在原来的 150×220 信封里（与 M-C2 的等比缩一致）', () => {
    expect(imageBox(3000, 4000)).toEqual({ width: 150, height: 200, anchor: 'center' });
    expect(imageBox(1080, 1920)).toEqual({ width: 124, height: 220, anchor: 'center' });
    expect(imageBox(4000, 3000)).toEqual({ width: 150, height: 113, anchor: 'center' });
    expect(imageBox(2000, 2000)).toEqual({ width: 150, height: 150, anchor: 'center' });
    expect(imageBox(120, 90), '比信封小又不算小的图：原大，不放大').toEqual({ width: 120, height: 90, anchor: 'center' });
  });

  it('长截图：不再是一条缝——框的比例到 0.4 为止，从顶上裁', () => {
    expect(imageBox(1080, 9000)).toEqual({ width: 88, height: 220, anchor: 'top' });
    // 再长也是同一个框：多出来的只是被裁掉的部分。
    expect(imageBox(1080, 30000)).toEqual({ width: 88, height: 220, anchor: 'top' });
  });

  it('全景：不再是一道线——框的比例到 2.5 为止，取中间', () => {
    expect(imageBox(4000, 500)).toEqual({ width: 150, height: 60, anchor: 'center' });
  });

  it('小图放大到最短边 60', () => {
    expect(imageBox(40, 40)).toEqual({ width: 60, height: 60, anchor: 'center' });
    expect(imageBox(100, 20)).toEqual({ width: 150, height: 60, anchor: 'center' });
    expect(imageBox(10, 100)).toEqual({ width: 60, height: 150, anchor: 'top' });
  });

  it('没有尺寸就没有框（交给 CSS 信封兜底）', () => {
    for (const [w, h] of [[0, 10], [10, 0], [-5, 10], [NaN, 10], [10, Infinity]]) {
      expect(imageBox(w, h)).toBeNull();
    }
  });

  it('扫一遍：框永远在信封里、短边不小于 60、比例在上下限之内', () => {
    const sides = [1, 7, 20, 40, 59, 60, 61, 90, 150, 151, 220, 300, 999, 1080, 4000, 30000];
    for (const w of sides) {
      for (const h of sides) {
        const b = imageBox(w, h)!;
        const at = `${w}×${h} → ${b.width}×${b.height}`;
        expect(b.width, at).toBeLessThanOrEqual(IMG_MAX_W);
        expect(b.height, at).toBeLessThanOrEqual(IMG_MAX_H);
        expect(Math.min(b.width, b.height), at).toBeGreaterThanOrEqual(IMG_MIN_SIDE);
        // Rounding to whole pixels moves the ratio a hair; one pixel of slack.
        expect(b.width / b.height, at).toBeGreaterThanOrEqual((b.height * IMG_RATIO_MIN - 1) / b.height);
        expect(b.width / b.height, at).toBeLessThanOrEqual((b.height * IMG_RATIO_MAX + 1) / b.height);
      }
    }
  });

  it('发送时存下的尺寸：只认正数', () => {
    expect(storedImageSize({ w: 1080, h: 1920, tags: ['聊天'] })).toEqual({ w: 1080, h: 1920 });
    expect(storedImageSize({ tags: ['聊天'] })).toBeNull();
    expect(storedImageSize({ w: '1080', h: 1920 })).toBeNull();
    expect(storedImageSize({ w: 0, h: 1920 })).toBeNull();
    expect(storedImageSize(undefined)).toBeNull();
  });

  it('量不出来（解不了码的格式、没有 decode 的 WebView）就是 null，不抛', async () => {
    expect(await measureImage('blob:nope')).toBeNull(); // jsdom has no Image.decode
    const Real = globalThis.Image;
    class FakeImage {
      src = '';
      naturalWidth = 3024;
      naturalHeight = 4032;
      decode = () => Promise.resolve();
    }
    vi.stubGlobal('Image', FakeImage);
    try {
      expect(await measureImage('blob:photo')).toEqual({ w: 3024, h: 4032 });
    } finally {
      vi.stubGlobal('Image', Real);
    }
  });
});

describe('图片气泡用上这个框', () => {
  const peer = { id: 'ai_a', type: 'ai', name: '林小雨', avatarColor: 'var(--color-brand)', avatarText: '雨' } as ContactVM;
  const imageMsg = (id: string, meta?: Record<string, unknown>): MessageVM => ({
    id: 1,
    convId: 'c1',
    senderId: 'ai_a',
    type: 'image',
    content: `idb:${id}`,
    status: 'sent',
    createdAt: 1_000,
    ...(meta ? { meta } : {}),
  });

  it('存了尺寸：图还没到，气泡就已经是最终的框（长截图从顶上裁）', () => {
    registerMedia('l3_long', { url: 'blob:l3-long', kind: 'photo', tags: [] });
    const { container } = render(
      <MessageBubble msg={imageMsg('l3_long', { w: 1080, h: 9000 })} sender={peer} isSelf={false} />,
    );
    const img = container.querySelector<HTMLImageElement>('img.msg-image')!;
    expect(img.style.width).toBe('88px');
    expect(img.style.height).toBe('220px');
    expect(img.style.objectPosition).toBe('center top');
    expect(container.querySelector('.msg-image-wrap--sized')).toBeTruthy();
  });

  it('没存尺寸（老消息、她发来的图）：图到了按原图尺寸定框', () => {
    registerMedia('l3_pano', { url: 'blob:l3-pano', kind: 'photo', tags: [] });
    const { container } = render(<MessageBubble msg={imageMsg('l3_pano')} sender={peer} isSelf={false} />);
    const img = container.querySelector<HTMLImageElement>('img.msg-image')!;
    expect(img.style.width, '加载前交给 CSS 信封').toBe('');
    Object.defineProperty(img, 'naturalWidth', { value: 4000 });
    Object.defineProperty(img, 'naturalHeight', { value: 500 });
    fireEvent.load(img);
    expect(img.style.width).toBe('150px');
    expect(img.style.height).toBe('60px');
    expect(img.style.objectPosition).toBe('center');
  });

  it('发图把尺寸写进消息（量在落库之前）', () => {
    const chat = strip(read('src/features/chat/ChatPage.tsx'));
    const send = chat.slice(chat.indexOf('const sendImages'), chat.indexOf('const requestReplyToLatest'));
    expect(send).toMatch(/const size = await measureImage\(url\);[\s\S]*await appendMessage\(/);
    expect(send).toMatch(/\.\.\.\(size \? \{ w: size\.w, h: size\.h \} : \{\}\)/);
  });
});

describe('系统提示行居中', () => {
  const css = strip(read('src/features/chat/chat.css'));
  /** The rule whose selector is exactly `sel` (not `sel` as the tail of a selector list). */
  const rule = (sel: string) => {
    const m = css.match(new RegExp(`(?:^|\\})\\s*${sel.replace(/\./g, '\\.')}\\s*\\{([^}]*)\\}`));
    return m ? m[1] : '';
  };

  it('前提：线程的每一行外壳是块级 div——align-self 在那里不生效', () => {
    const thread = strip(read('src/features/chat/ChatThread.tsx'));
    expect(thread).toMatch(/<div\s+key=\{row\.msg\.id\}\s+data-msg-id=\{row\.msg\.id\}/);
    // The wrapper only becomes a flex box in select mode (.msg-selectable).
    expect(rule('.msg-selectable')).toMatch(/display:\s*flex/);
  });

  it('所以 .msg-system 用 auto 外边距 + fit-content 居中，长通知在 80% 内居中折行', () => {
    const r = rule('.msg-system');
    expect(r).toMatch(/margin-inline:\s*auto/);
    expect(r).toMatch(/width:\s*fit-content/);
    expect(r).toMatch(/text-align:\s*center/);
    expect(r).toMatch(/max-width:\s*80%/);
  });

  it('没有常驻胶囊（微信 7.0 起是平的灰字）；只有聊天背景时才垫一层，同时间行', () => {
    expect(rule('.msg-system')).not.toMatch(/background/);
    expect(css).toMatch(/\.chat-page--bg \.msg-time,\s*\.chat-page--bg \.msg-system\s*\{[^}]*background/);
  });
});
