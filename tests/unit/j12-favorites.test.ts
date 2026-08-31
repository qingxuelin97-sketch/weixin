import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { repo } from '../../src/db/repo';
import { idbClear, STORES } from '../../src/db/idb';
import {
  favoriteSearchText,
  filterFavorites,
  makeNoteFavorite,
  editedNote,
  isForwardable,
  forwardMessageOf,
  forwardableConversations,
} from '../../src/lib/favorites';
import type { ConversationVM, FavoriteVM } from '../../src/data/types';

/**
 * 收藏二期 (M-J12) 的三条红线：
 *   1. 笔记 — 建得出来、存得进去、编辑不换 id；
 *   2. 全文搜索 — 正文/来源/meta 都可命中，大小写不敏感；
 *   3. 转发回聊天 — note 以 text 出门、meta 是克隆不是别名，
 *      且转发目标列表对隐藏会话零可见（新写路径沿用 search() 纪律）。
 */

const T0 = new Date(2026, 6, 1, 12, 0).getTime();

function fav(over: Partial<FavoriteVM> & Pick<FavoriteVM, 'id'>): FavoriteVM {
  return {
    msgId: 1,
    convId: 'c1',
    senderId: 'ai_a',
    senderName: '阿达',
    convTitle: '午后小群',
    type: 'text',
    content: '一句话',
    createdAt: T0,
    favedAt: T0,
    ...over,
  };
}

beforeEach(async () => {
  for (const s of STORES) await idbClear(s.name);
});

describe('笔记 (note)', () => {
  it('makeNoteFavorite 产出 note 行：self 作者、空 convId、稳定 id', () => {
    const n = makeNoteFavorite('买猫粮', T0);
    expect(n.type).toBe('note');
    expect(n.senderId).toBe('self');
    expect(n.convId).toBe('');
    expect(n.content).toBe('买猫粮');
    expect(n.id).toBe(`fav_note_${T0}`);
    expect(n.createdAt).toBe(T0);
    expect(n.favedAt).toBe(T0);
  });

  it('note 行经 repo 往返仍可见（空 convId 不会被隐藏过滤误伤）', async () => {
    await repo.putFavorite(makeNoteFavorite('周末去爬山', T0));
    const rows = await repo.getFavorites();
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('note');
    expect(rows[0].content).toBe('周末去爬山');
  });

  it('editedNote 只换内容：id 与 favedAt 不动，列表次序不被编辑打乱', () => {
    const n = makeNoteFavorite('原文', T0);
    const e = editedNote(n, '改过了');
    expect(e.id).toBe(n.id);
    expect(e.favedAt).toBe(n.favedAt);
    expect(e.content).toBe('改过了');
  });
});

describe('全文搜索 (filterFavorites)', () => {
  const rows: FavoriteVM[] = [
    fav({ id: 'f1', content: '今晚吃火锅吗' }),
    fav({ id: 'f2', type: 'file', content: '合同.pdf', meta: { fileName: '年度合同.pdf' } }),
    fav({ id: 'f3', senderName: '林小雨', convTitle: '和小雨的聊天', content: '好呀' }),
    fav({
      id: 'f4',
      type: 'merged',
      content: '群聊的聊天记录',
      meta: { title: '周末小分队', items: [{ name: '阿波', body: '记得带伞' }] },
    }),
    fav({ id: 'f5', type: 'link', content: 'Recipe', meta: { title: 'Hotpot Recipe' } }),
  ];

  it('正文命中', () => {
    expect(filterFavorites(rows, '火锅').map((r) => r.id)).toEqual(['f1']);
  });

  it('meta 的 fileName / title / items 命中', () => {
    expect(filterFavorites(rows, '年度合同').map((r) => r.id)).toEqual(['f2']);
    expect(filterFavorites(rows, '小分队').map((r) => r.id)).toEqual(['f4']);
    expect(filterFavorites(rows, '带伞').map((r) => r.id)).toEqual(['f4']);
  });

  it('来源（发送者/会话标题）命中', () => {
    expect(filterFavorites(rows, '林小雨').map((r) => r.id)).toEqual(['f3']);
  });

  it('ASCII 大小写不敏感；空查询返回全部', () => {
    expect(filterFavorites(rows, 'hotpot').map((r) => r.id)).toEqual(['f5']);
    expect(filterFavorites(rows, '  ')).toHaveLength(rows.length);
  });

  it('不按 meta 的键名命中（否则搜索结果闹鬼）', () => {
    expect(favoriteSearchText(rows[1])).not.toContain('fileName');
    expect(filterFavorites(rows, 'fileName')).toHaveLength(0);
  });
});

describe('转发回聊天 (forwardMessageOf)', () => {
  it('note 以 text 出门——note 不是消息类型，绝不能进消息表', () => {
    const n = makeNoteFavorite('转出去的笔记', T0);
    const m = forwardMessageOf(n, 'c9', T0 + 1000);
    expect(m).not.toBeNull();
    expect(m!.type).toBe('text');
    expect(m!.content).toBe('转出去的笔记');
    expect(m!.convId).toBe('c9');
    expect(m!.senderId).toBe('self');
    expect(m!.createdAt).toBe(T0 + 1000);
  });

  it('普通类型原样转发，meta 是克隆不是别名', () => {
    const f = fav({ id: 'f1', type: 'file', content: '合同.pdf', meta: { fileName: '合同.pdf' } });
    const m = forwardMessageOf(f, 'c2', T0)!;
    expect(m.type).toBe('file');
    expect(m.meta).toEqual({ fileName: '合同.pdf' });
    expect(m.meta).not.toBe(f.meta);
  });

  it('语音/游戏/红包不可转发（与真机一致）', () => {
    for (const type of ['voice', 'game', 'rp', 'transfer', 'call', 'system'] as const) {
      expect(isForwardable({ type })).toBe(false);
      expect(forwardMessageOf(fav({ id: 'x', type }), 'c2', T0)).toBeNull();
    }
  });
});

describe('转发目标列表：隐藏会话零可见（转红）', () => {
  const conv = (id: string, extra: Partial<ConversationVM> = {}): ConversationVM => ({
    id,
    type: 'single',
    title: id,
    avatarColor: '',
    avatarText: '',
    isPinned: false,
    isMuted: false,
    unreadCount: 0,
    mentionMe: false,
    lastMsgPreview: '',
    lastMsgAt: 0,
    ...extra,
  });

  it('isHidden 行绝不出现在候选里；excludeConvId 也被排除', () => {
    const convs = [
      conv('c_vis'),
      conv('dm_a_b', { isHidden: true, title: '秘密频道' }),
      conv('c_self'),
    ];
    const out = forwardableConversations(convs, 'c_self');
    expect(out.map((c) => c.id)).toEqual(['c_vis']);
    expect(JSON.stringify(out)).not.toContain('秘密频道');
  });
});
