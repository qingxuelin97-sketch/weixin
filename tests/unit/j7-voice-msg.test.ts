/**
 * 发语音消息 (M-J7a) red-guards — 侦察点名的「全 App 最扎眼断点」：
 * 麦克风按钮此前只能转文字（I9），微信真正的「按住说话→松开发送」不存在。
 *
 *   1. 剪辑落媒体库 kind 'voice'（随备份走、在 TTS 缓存的逐出圈外），
 *      saveVoiceClip/voiceClipBlob 往返；
 *   2. 投影：带转写的语音 = 她真的"听得懂"；没转写 = [语音 X秒]（诚实）；
 *   3. 接线扫描：onClip 挂进 ChatPage、松开即发送（不再强制 ASR 前置闸）、
 *      文 盘存在、VoiceBubble 会放用户剪辑、水合跳过 voice、素材库排除 voice。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import 'fake-indexeddb/auto';
import { saveVoiceClip, voiceClipBlob } from '../../src/lib/voice';
import { repo } from '../../src/db/repo';
import { renderMessageBody } from '../../src/ai/render-msg';
import type { MessageVM } from '../../src/data/types';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

describe('剪辑落媒体库', () => {
  it('saveVoiceClip 存 kind voice + 时长，voiceClipBlob 取得回来', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm' });
    const ref = await saveVoiceClip(blob, 4200);
    expect(ref).toMatch(/^idb:/);
    const row = await repo.getMediaItem(ref.slice(4));
    expect(row?.kind).toBe('voice');
    expect(row?.durationMs).toBe(4200);
    const back = await voiceClipBlob(ref);
    expect(back?.size).toBe(4);
  });

  it('非 idb: 引用安静地解析为空（不抛不崩）', async () => {
    expect(await voiceClipBlob('ph:whatever')).toBeUndefined();
  });
});

describe('投影：她听得懂（有转写时）', () => {
  const msg = (over: Partial<MessageVM>): MessageVM => ({
    id: 1,
    convId: 'c',
    senderId: 'self',
    type: 'voice',
    status: 'sent',
    createdAt: 1_754_600_000_000,
    ...over,
  });

  it('转写进 content 后，includeVoiceText 让模型看到你说了什么', () => {
    const m = msg({ content: '晚上一起吃饭吗', meta: { durationMs: 3000, audioRef: 'idb:x' } });
    expect(renderMessageBody(m, { includeVoiceText: true })).toContain('晚上一起吃饭吗');
    expect(renderMessageBody(m, { includeVoiceText: true })).toContain('[语音');
  });

  it('没配 ASR：只有 [语音 X秒]——她像没点开听，诚实不装懂', () => {
    const m = msg({ content: '', meta: { durationMs: 8000, audioRef: 'idb:x' } });
    expect(renderMessageBody(m, { includeVoiceText: true })).toBe('[语音 8秒]');
  });
});

describe('接线扫描（写了没接线 = 没做）', () => {
  it('ChatPage 把 onClip 接进了 VoiceInputButton，且发送走媒体库 + 引擎回复', () => {
    const src = read('src/features/chat/ChatPage.tsx');
    expect(src).toContain('onClip=');
    expect(src).toContain('sendVoiceClip');
    expect(src).toContain('saveVoiceClip');
    // 发完必须让她接话——W2「发图不回复」的教训不许在语音上重演。
    // （粗切 2000 字符足够罩住整个函数体；'};' 会被内部对象字面量截胡。）
    const fn = src.slice(src.indexOf('const sendVoiceClip'));
    expect(fn.slice(0, 2000)).toContain('requestReplyToLatest');
  });

  it('语音消息模式松开即发送：录音不再被 ASR 配置前置闸拦住', () => {
    const src = read('src/features/chat/VoiceInput.tsx');
    expect(src).toContain('if (!onClip)'); // 前置闸只剩纯转文字模式在用
    expect(src).toContain('onClip(clip, heldMs)');
    expect(src).toContain('vrec__totext-blob'); // 文 盘真的画了
    expect(src).not.toContain('requestAnimationFrame'); // 波形仍是纯 CSS
  });

  it('VoiceBubble 会放用户剪辑（audioRef → playVoiceRef）', () => {
    const src = read('src/features/chat/MessageBubble.tsx');
    expect(src).toContain('playVoiceRef(audioRef');
  });

  it("voice 剪辑不进图像注册表（水合跳过）也不进素材库页", () => {
    expect(read('src/store/appStore.ts')).toContain("item.kind === 'voice'");
    expect(read('src/features/settings/MediaLibraryPage.tsx')).toContain("Exclude<MediaItemVM['kind'], 'voice'>");
  });

  it('转文字对自己的剪辑按需跑 ASR（第一次点才转，之后是纯开关）', () => {
    const src = read('src/features/chat/ChatPage.tsx');
    expect(src).toContain('voiceClipBlob(audioRef)');
  });
});
