import { describe, it, expect } from 'vitest';
import { previewOf, mentionsSelf } from '../../src/store/appStore';
import type { ContactVM, MessageVM } from '../../src/data/types';

/**
 * Pure halves of the unread/preview chain (real-device bug #7 + H6).
 * The stateful side (increment on inactive conv, clear on enter, draft park)
 * is covered end-to-end in tests/screenshot/unread-e2e.spec.ts.
 */

const msg = (over: Partial<MessageVM>): MessageVM => ({
  id: 1,
  convId: 'c',
  senderId: 'ai_lin',
  type: 'text',
  content: 'hello',
  status: 'sent',
  createdAt: 0,
  ...over,
});

const contacts: ContactVM[] = [
  { id: 'self', type: 'self', name: '阿泽', avatarColor: '#000', avatarText: '泽' },
  { id: 'ai_lin', type: 'ai', name: '林小雨', avatarColor: '#000', avatarText: '雨' },
];

describe('previewOf', () => {
  it('recalled message shows the recall notice, never the original text (H6)', () => {
    expect(previewOf(msg({ isRecalled: true, content: '这句不能泄漏' }), '小雨')).toBe(
      '"小雨" 撤回了一条消息',
    );
    expect(previewOf(msg({ isRecalled: true, senderId: 'self', content: '我的原文' }))).toBe(
      '你撤回了一条消息',
    );
  });

  it('recall notice wins over every message type', () => {
    for (const type of ['text', 'voice', 'image', 'sticker'] as const) {
      expect(previewOf(msg({ type, isRecalled: true }), 'Ada')).toContain('撤回了一条消息');
    }
  });

  it('normal messages keep their type placeholders', () => {
    expect(previewOf(msg({}))).toBe('hello');
    expect(previewOf(msg({ type: 'voice' }))).toBe('[语音]');
    expect(previewOf(msg({ type: 'rp' }))).toBe('[微信红包]');
  });
});

describe('mentionsSelf', () => {
  it('matches @自己的名字 and @所有人', () => {
    expect(mentionsSelf(msg({ content: '@阿泽 明天聚餐来吗' }), contacts)).toBe(true);
    expect(mentionsSelf(msg({ content: '@所有人 群公告' }), contacts)).toBe(true);
  });

  it('ignores mentions of other people and non-text messages', () => {
    expect(mentionsSelf(msg({ content: '@林小雨 你说呢' }), contacts)).toBe(false);
    expect(mentionsSelf(msg({ type: 'voice', content: '@阿泽' }), contacts)).toBe(false);
    expect(mentionsSelf(msg({ content: '没有提到任何人' }), contacts)).toBe(false);
  });
});
