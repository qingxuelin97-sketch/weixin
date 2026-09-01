/**
 * 搜索 v3 (M-J10)：世界书 / 收藏 / 记忆 / 文件名。
 *
 * 在这之前 `search()` 只认四种东西——联系人、会话、消息、朋友圈。用户亲手写的
 * 世界书条目、亲手点的收藏、以及她关于你的全部记忆，加起来是这个 App 里将近
 * 一半的文字内容，而它们**一个字都搜不到**。世界书尤其刺眼：那是用户自己敲进去
 * 的设定，写完就找不回来。
 *
 * 这份文件里分量最重的是最后一组：新增三种 kind 就是新增三条可能泄漏隐藏会话的
 * 路径，而隐藏会话（AI↔AI 私信）泄漏一次就穿帮且不可逆。
 */
import { describe, it, expect } from 'vitest';
import { search, groupByKind, type SearchInput, type SearchKind } from '../../src/lib/search';
import type { ContactVM, ConversationVM, MessageVM } from '../../src/data/types';

const T0 = 1_754_600_000_000;

const contact = (id: string, name: string): ContactVM => ({
  id,
  type: 'ai',
  name,
  avatarColor: '#AABBCC',
  avatarText: name[0],
});

const conv = (id: string, title: string, isHidden = false): ConversationVM => ({
  id,
  type: 'single',
  peerId: 'ai_a',
  title,
  avatarColor: '#AABBCC',
  avatarText: '甲',
  isPinned: false,
  isMuted: false,
  unreadCount: 0,
  mentionMe: false,
  lastMsgPreview: '',
  lastMsgAt: T0,
  isHidden,
});

const msg = (id: number, convId: string, over: Partial<MessageVM> = {}): MessageVM => ({
  id,
  convId,
  senderId: 'ai_a',
  type: 'text',
  status: 'sent',
  createdAt: T0,
  ...over,
});

const base = (): SearchInput => ({
  contacts: [contact('ai_a', '林小雨')],
  conversations: [conv('c1', '林小雨')],
  messages: { c1: [] },
  moments: [],
});

describe('搜索 v3：新增的三种内容', () => {
  it('世界书：正文与关键词都能搜到', () => {
    const input: SearchInput = {
      ...base(),
      worldbook: [
        {
          id: 'w1',
          title: '青梧巷',
          keywords: ['青梧巷'],
          content: '她小时候住在青梧巷尽头那栋红砖楼。',
          scope: 'global',
          priority: 1,
          enabled: true,
          createdAt: T0,
        },
      ],
    };
    expect(search(input, '红砖楼').some((h) => h.kind === 'worldbook')).toBe(true);
    // 只记得自己设的触发词，也要找得到。
    expect(search(input, '青梧巷').some((h) => h.kind === 'worldbook')).toBe(true);
  });

  it('收藏与记忆各自可搜，且标题说得清是谁的', () => {
    const input: SearchInput = {
      ...base(),
      favorites: [
        {
          id: 'f1',
          msgId: 1,
          convId: 'c1',
          convTitle: '林小雨',
          senderId: 'ai_a',
          senderName: '林小雨',
          type: 'text',
          content: '周五那家烧烤',
          createdAt: T0,
          favedAt: T0,
        },
      ],
      memories: [{ id: 'm1', subjectId: 'ai_a', text: '她不吃香菜', createdAt: T0 }],
    };
    expect(search(input, '烧烤').some((h) => h.kind === 'favorite')).toBe(true);
    const mem = search(input, '香菜').find((h) => h.kind === 'memory');
    expect(mem).toBeDefined();
    // 标题必须是人名而不是 contactId——一个写着 ai_a 的结果行就是内部名字上屏。
    expect(mem!.title).toBe('林小雨');
  });

  it('文件名能搜到（此前发过来的「合同.pdf」在搜索里根本不存在）', () => {
    const input: SearchInput = {
      ...base(),
      messages: {
        c1: [msg(1, 'c1', { type: 'file', meta: { fileName: '租房合同.pdf', sizeBytes: 1 } })],
      },
    };
    const hit = search(input, '租房合同').find((h) => h.kind === 'message');
    expect(hit).toBeDefined();
    expect(hit!.subtitle).toContain('租房合同');
  });

  it('语音转写能搜到（转写就存在 content 里，本来就该可搜）', () => {
    const input: SearchInput = {
      ...base(),
      messages: { c1: [msg(1, 'c1', { type: 'voice', content: '明天九点老地方' })] },
    };
    expect(search(input, '老地方').some((h) => h.kind === 'message')).toBe(true);
  });

  it('三种新内容缺席时不炸，也不会凭空造出结果', () => {
    const hits = search(base(), '林');
    expect(hits.every((h) => !['worldbook', 'favorite', 'memory'].includes(h.kind))).toBe(true);
  });

  it('分组顺序把用户自己写的东西排在推断出来的东西前面', () => {
    const input: SearchInput = {
      ...base(),
      worldbook: [
        {
          id: 'w1',
          title: 'x',
          keywords: ['x'],
          content: '香菜',
          scope: 'global',
          priority: 1,
          enabled: true,
          createdAt: T0,
        },
      ],
      memories: [{ id: 'm1', subjectId: 'ai_a', text: '香菜', createdAt: T0 }],
    };
    const kinds = groupByKind(search(input, '香菜')).map((g) => g.kind);
    expect(kinds.indexOf('worldbook')).toBeLessThan(kinds.indexOf('memory'));
  });
});

/* ------------------------------------------------------------------ */
/* 泄漏面：新增三种 kind = 新增三条可能泄漏隐藏会话的路径                 */
/* ------------------------------------------------------------------ */

describe('隐藏会话不许经由新增的搜索面泄漏', () => {
  it('隐藏会话里的收藏搜不出来', () => {
    const input: SearchInput = {
      ...base(),
      conversations: [conv('c1', '林小雨'), conv('dm_a_b', 'AI 私信', true)],
      favorites: [
        {
          id: 'f_hidden',
          msgId: 2,
          convId: 'dm_a_b',
          convTitle: 'AI 私信',
          senderId: 'ai_a',
          senderName: '阿甲',
          type: 'text',
          content: '这句话来自隐藏私信',
          createdAt: T0,
          favedAt: T0,
        },
      ],
    };
    expect(search(input, '隐藏私信')).toEqual([]);
  });

  /**
   * 这条钉的是「过滤住在 search() 内部」这条规矩本身（CLAUDE.md §3.5）。
   * 隐藏会话的消息一直是被滤掉的；新增 kind 之后我要确认那道过滤仍然在同一处
   * 生效，而不是被哪个新分支绕过去了。
   */
  it('隐藏会话的消息仍然搜不出来（老规矩没被新代码绕过）', () => {
    const input: SearchInput = {
      ...base(),
      conversations: [conv('dm_a_b', 'AI 私信', true)],
      messages: { dm_a_b: [msg(1, 'dm_a_b', { content: '她背着你说的话' })] },
    };
    expect(search(input, '背着你')).toEqual([]);
  });

  /** 每种 kind 都要有权重，漏一种在 TS 里就编译不过——这条守的是别人把它改软。 */
  it('每种 kind 都在权重表里（Record<SearchKind, number> 编译期强制）', () => {
    const all: SearchKind[] = [
      'contact',
      'conversation',
      'message',
      'moment',
      'worldbook',
      'favorite',
      'memory',
    ];
    const labels = groupByKind(
      all.map((kind, i) => ({ kind, id: `x${i}`, title: 't', ranges: [], score: 1 })),
    );
    // groupByKind 的 LABELS 表也必须覆盖全部 kind，否则新 kind 有结果却没分组，
    // 在界面上表现为「搜到了但看不见」。
    expect(labels.map((g) => g.kind).sort()).toEqual([...all].sort());
  });
});
