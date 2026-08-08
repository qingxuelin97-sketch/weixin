import { describe, it, expect } from 'vitest';
import {
  search,
  findRanges,
  highlightParts,
  excerpt,
  groupByKind,
  type SearchInput,
} from '../../src/lib/search';
import type { ContactVM, ConversationVM, MessageVM, MomentVM } from '../../src/data/types';

const T0 = new Date(2025, 7, 6, 12, 0, 0).getTime();

function contact(id: string, name: string, over: Partial<ContactVM> = {}): ContactVM {
  return { id, type: 'ai', name, avatarColor: '#000', avatarText: name[0], ...over };
}
function conv(id: string, title: string, over: Partial<ConversationVM> = {}): ConversationVM {
  return {
    id,
    type: 'single',
    title,
    avatarColor: '#000',
    avatarText: title[0],
    isPinned: false,
    isMuted: false,
    unreadCount: 0,
    mentionMe: false,
    lastMsgPreview: '',
    lastMsgAt: T0,
    ...over,
  };
}
function msg(id: number, convId: string, content: string, over: Partial<MessageVM> = {}): MessageVM {
  return { id, convId, senderId: 'a', type: 'text', content, status: 'sent', createdAt: T0, ...over };
}
function moment(id: string, text: string): MomentVM {
  return { id, authorId: 'a', text, imageRefs: [], isNsfw: false, createdAt: T0 };
}

const base: SearchInput = {
  contacts: [
    contact('self', '我', { type: 'self' }),
    contact('a', '林小雨', { signature: '画画的' }),
    contact('b', '陈叔', { remark: '老陈' }),
  ],
  conversations: [conv('conv_a', '林小雨'), conv('g1', '摸鱼小分队', { type: 'group' })],
  messages: {
    conv_a: [msg(1, 'conv_a', '今天下雨了'), msg(2, 'conv_a', '记得带伞')],
    g1: [msg(3, 'g1', '周末去哪玩')],
  },
  moments: [moment('m1', '画了一天，终于收工')],
};

describe('findRanges', () => {
  it('finds every occurrence', () => {
    expect(findRanges('abcabc', 'bc')).toEqual([
      [1, 3],
      [4, 6],
    ]);
  });

  it('is case-insensitive', () => {
    expect(findRanges('Hello World', 'world')).toEqual([[6, 11]]);
  });

  it('returns ranges into the original string, not the lowercased one', () => {
    const text = 'ABC';
    const [[s, e]] = findRanges(text, 'b');
    expect(text.slice(s, e)).toBe('B');
  });

  it('returns nothing for an empty needle', () => {
    expect(findRanges('abc', '')).toEqual([]);
  });

  it('handles CJK', () => {
    expect(findRanges('今天下雨了', '下雨')).toEqual([[2, 4]]);
  });

  it('does not loop forever on overlapping matches', () => {
    expect(findRanges('aaaa', 'aa')).toEqual([
      [0, 2],
      [2, 4],
    ]);
  });
});

describe('highlightParts', () => {
  it('splits into hit and non-hit runs', () => {
    expect(highlightParts('abcd', [[1, 3]])).toEqual([
      { text: 'a', hit: false },
      { text: 'bc', hit: true },
      { text: 'd', hit: false },
    ]);
  });

  it('reassembles to exactly the original text', () => {
    const text = '今天下雨了，记得带伞';
    const parts = highlightParts(text, findRanges(text, '雨'));
    expect(parts.map((p) => p.text).join('')).toBe(text);
  });

  it('handles a match at the very start', () => {
    expect(highlightParts('abc', [[0, 1]])).toEqual([
      { text: 'a', hit: true },
      { text: 'bc', hit: false },
    ]);
  });

  it('returns one plain run when there are no matches', () => {
    expect(highlightParts('abc', [])).toEqual([{ text: 'abc', hit: false }]);
  });
});

describe('excerpt', () => {
  it('leaves short text alone', () => {
    const r = findRanges('短句', '句');
    expect(excerpt('短句', r).text).toBe('短句');
  });

  it('windows around the match and keeps the hit inside the excerpt', () => {
    const long = '前'.repeat(80) + '关键词' + '后'.repeat(80);
    const r = findRanges(long, '关键词');
    const ex = excerpt(long, r);
    expect(ex.text.length).toBeLessThan(long.length);
    const [s, e] = ex.ranges[0];
    expect(ex.text.slice(s, e)).toBe('关键词');
  });

  it('marks truncation with ellipses', () => {
    const long = '前'.repeat(80) + '关键词' + '后'.repeat(80);
    const ex = excerpt(long, findRanges(long, '关键词'));
    expect(ex.text.startsWith('…')).toBe(true);
    expect(ex.text.endsWith('…')).toBe(true);
  });
});

describe('search', () => {
  it('returns nothing for an empty query', () => {
    expect(search(base, '')).toEqual([]);
    expect(search(base, '   ')).toEqual([]);
  });

  it('finds a contact by name', () => {
    const hits = search(base, '林小雨');
    expect(hits.some((h) => h.kind === 'contact' && h.id === 'a')).toBe(true);
  });

  it('finds a contact by remark as well as real name', () => {
    expect(search(base, '老陈').some((h) => h.kind === 'contact' && h.id === 'b')).toBe(true);
    expect(search(base, '陈叔').some((h) => h.kind === 'contact' && h.id === 'b')).toBe(true);
  });

  it('shows the remark, not the original name, for a renamed contact', () => {
    const hit = search(base, '陈叔').find((h) => h.kind === 'contact');
    expect(hit?.title).toBe('老陈');
  });

  it('finds message bodies across conversations', () => {
    const hits = search(base, '周末');
    const m = hits.find((h) => h.kind === 'message');
    expect(m?.convId).toBe('g1');
  });

  it('finds Moments text', () => {
    expect(search(base, '收工').some((h) => h.kind === 'moment')).toBe(true);
  });

  it('ranks a matching contact above a message that merely mentions them', () => {
    const withMention: SearchInput = {
      ...base,
      messages: { conv_a: [msg(9, 'conv_a', '林小雨说她今天很忙')] },
    };
    expect(search(withMention, '林小雨')[0].kind).toBe('contact');
  });

  it('never surfaces the user themselves as a contact result', () => {
    expect(search(base, '我').some((h) => h.kind === 'contact' && h.id === 'self')).toBe(false);
  });

  it('does not leak the text of a recalled message', () => {
    const withRecalled: SearchInput = {
      ...base,
      messages: { conv_a: [msg(5, 'conv_a', '说错话了', { isRecalled: true })] },
    };
    // The chat view shows only "撤回了一条消息"; search must not resurrect the body.
    expect(search(withRecalled, '说错话')).toEqual([]);
  });

  it('carries the conversation id on message hits so they can be opened', () => {
    for (const h of search(base, '雨').filter((x) => x.kind === 'message')) {
      expect(h.convId).toBeTruthy();
    }
  });

  it('returns results in descending score order', () => {
    const scores = search(base, '雨').map((h) => h.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it('finds nothing for a query that matches nothing', () => {
    expect(search(base, 'zzzz不存在zzzz')).toEqual([]);
  });

  it('handles an empty corpus', () => {
    expect(search({ contacts: [], conversations: [], messages: {}, moments: [] }, 'x')).toEqual([]);
  });

  it('produces highlight ranges that map onto the field being shown', () => {
    for (const h of search(base, '雨')) {
      const field = h.kind === 'contact' || h.kind === 'conversation' ? h.title : (h.subtitle ?? '');
      for (const [s, e] of h.ranges) {
        expect(s).toBeGreaterThanOrEqual(0);
        expect(e).toBeLessThanOrEqual(field.length);
      }
    }
  });
});

describe('groupByKind', () => {
  it('orders groups contacts → chats → messages → moments', () => {
    const g = groupByKind(search(base, '雨'));
    expect(g.map((x) => x.kind)).toEqual(
      ['contact', 'conversation', 'message', 'moment'].filter((k) =>
        g.some((x) => x.kind === k),
      ),
    );
  });

  it('omits empty groups', () => {
    const g = groupByKind(search(base, '收工'));
    expect(g.every((x) => x.hits.length > 0)).toBe(true);
  });
});
