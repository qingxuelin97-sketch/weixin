import { describe, it, expect } from 'vitest';
import { buildWidgetSummary, convDisplayName } from '../../src/native/widget-sync';
import type { ContactVM, ConversationVM } from '../../src/data/types';

/**
 * Widget data feed (M-I10). The one rule that must never regress: hidden AI↔AI
 * DM threads are filtered in THIS producer — the Kotlin layer renders whatever
 * it is given, so a leak here would put a secret conversation on the launcher.
 */
const conv = (over: Partial<ConversationVM>): ConversationVM => ({
  id: 'c1',
  type: 'single',
  peerId: 'ai_lin',
  title: '林小雨',
  avatarColor: '#000',
  avatarText: '雨',
  isPinned: false,
  isMuted: false,
  unreadCount: 0,
  mentionMe: false,
  lastMsgPreview: '晚安',
  lastMsgAt: 1000,
  ...over,
});

describe('buildWidgetSummary', () => {
  it('sums unread and surfaces the latest conversation preview', () => {
    const s = buildWidgetSummary(
      [
        conv({ id: 'a', unreadCount: 2, lastMsgAt: 100, lastMsgPreview: '旧' }),
        conv({ id: 'b', unreadCount: 3, lastMsgAt: 900, lastMsgPreview: '新', title: '苏叶' }),
      ],
      (c) => c.title,
    );
    expect(s.unread).toBe(5);
    expect(s.convId).toBe('b');
    expect(s.title).toBe('苏叶');
    expect(s.preview).toBe('新');
  });

  it('NEVER counts or previews hidden AI↔AI threads — even the freshest one', () => {
    const s = buildWidgetSummary(
      [
        conv({ id: 'visible', unreadCount: 1, lastMsgAt: 100, lastMsgPreview: '可见' }),
        conv({
          id: 'secret',
          isHidden: true,
          unreadCount: 40,
          lastMsgAt: 99_999,
          lastMsgPreview: '这句泄漏即穿帮',
        }),
      ],
      (c) => c.title,
    );
    expect(s.convId).toBe('visible');
    expect(s.unread).toBe(1);
    expect(s.preview).toBe('可见');
  });

  it('empty world → calm defaults, not crashes', () => {
    const s = buildWidgetSummary([], () => undefined);
    expect(s).toEqual({ unread: 0, title: '微信', preview: '暂无消息', convId: '' });
  });

  it('all-hidden world is identical to empty (nothing to point the click at)', () => {
    const s = buildWidgetSummary([conv({ isHidden: true, unreadCount: 9 })], (c) => c.title);
    expect(s.convId).toBe('');
    expect(s.unread).toBe(0);
  });
});

describe('convDisplayName', () => {
  const contacts: Record<string, ContactVM> = {
    ai_lin: { id: 'ai_lin', type: 'ai', name: '林小雨', remark: '小雨', avatarColor: '#000', avatarText: '雨' },
  };
  const byId = (id: string) => contacts[id];

  it('prefers the remark for singles, the title for groups', () => {
    expect(convDisplayName(conv({}), byId)).toBe('小雨');
    expect(convDisplayName(conv({ type: 'group', title: '开黑群', peerId: undefined }), byId)).toBe(
      '开黑群',
    );
  });

  it('falls back to the conversation title when the contact is gone', () => {
    expect(convDisplayName(conv({ peerId: 'ghost' }), byId)).toBe('林小雨');
  });
});
