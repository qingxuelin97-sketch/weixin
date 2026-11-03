// @vitest-environment jsdom
/**
 * 整页选择器 (M-L2)：转发「选择一个聊天」与群 @「选择提醒的人」。
 *
 * 写在最前面的是不能退的那条：**隐藏会话（AI↔AI 私信）永远不是转发目的地**。M-L2 之前
 * 聊天页留着一份自己的内联面板，手写着同一条 `!isHidden` 过滤；现在两处共用一个选择器，
 * 候选列表只经 `forwardableConversations`。下面第一组用例渲染真组件去数行，不是读源码。
 *
 * 其余是微信的样子与顺序：点一个会话不会立刻发出去，先弹确认卡（发给谁、发的是什么、
 * 「给朋友留言」）；留言落在被转发的东西**后面**；返回键先关确认卡，再关整页。
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react';
import { ForwardPicker } from '../../src/components/ForwardPicker';
import { MentionPicker } from '../../src/features/chat/MentionPicker';
import { clearDismissStack, popDismiss } from '../../src/app/dismiss-stack';
import { deliverForward } from '../../src/lib/favorites';
import { useAppStore } from '../../src/store/appStore';
import type { ContactVM, ConversationVM, MessageVM } from '../../src/data/types';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
/** 宪法 3.5：源码文本守卫先剥注释——解释旧写法的注释里就有旧写法。 */
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');

const conv = (id: string, title: string, extra: Partial<ConversationVM> = {}): ConversationVM => ({
  id,
  type: 'single',
  peerId: `p_${id}`,
  title,
  avatarColor: 'var(--color-brand)',
  avatarText: title[0] ?? '',
  isPinned: false,
  isMuted: false,
  unreadCount: 0,
  mentionMe: false,
  lastMsgPreview: '',
  lastMsgAt: 0,
  ...extra,
});
const contact = (id: string, name: string, remark?: string): ContactVM =>
  ({ id, name, remark, type: 'ai', avatarText: name[0], avatarColor: 'var(--color-brand)' }) as ContactVM;

afterEach(() => {
  cleanup();
  clearDismissStack();
});
beforeEach(() => {
  useAppStore.setState({
    contacts: [],
    conversations: [
      conv('c_here', '正在聊的人'),
      conv('c_lin', '林小雨'),
      conv('c_dm', '阿杨×小雪', { isHidden: true }),
      conv('c_hike', '周末爬山小分队', { type: 'group', peerId: undefined, memberIds: [] }),
      conv('c_mom', '妈妈'),
    ],
  });
});

const rowNames = () =>
  [...document.querySelectorAll('.cpick__body .cpick__row .cpick__name')].map((n) => n.textContent);

function openForward(extra: Partial<Parameters<typeof ForwardPicker>[0]> = {}) {
  const onSend = vi.fn();
  const onClose = vi.fn();
  render(
    <ForwardPicker open preview="今晚吃火锅吗" excludeConvId="c_here" onSend={onSend} onClose={onClose} {...extra} />,
  );
  return { onSend, onClose };
}

describe('转发「选择一个聊天」：候选是谁', () => {
  it('隐藏会话与「正在聊的这个」都不在；其余按会话列表的顺序', () => {
    openForward();
    expect(screen.getByRole('dialog', { name: '选择一个聊天' })).toBeTruthy();
    expect(rowNames()).toEqual(['林小雨', '周末爬山小分队', '妈妈']);
    expect(screen.queryByText('阿杨×小雪'), 'AI↔AI 私信成了转发目的地——穿帮且不可逆').toBeNull();
  });

  it('搜一下就只剩匹配的；隐藏会话搜它的名字也搜不出来', () => {
    openForward();
    expect(screen.getByText('最近聊天')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('搜索'), { target: { value: '爬山' } });
    expect(rowNames()).toEqual(['周末爬山小分队']);
    expect(screen.queryByText('最近聊天'), '搜索结果不是「最近聊天」').toBeNull();
    fireEvent.change(screen.getByPlaceholderText('搜索'), { target: { value: '小雪' } });
    expect(rowNames()).toEqual([]);
    expect(screen.getByText('没有找到「小雪」')).toBeTruthy();
  });

  it('关着的时候什么都不画；每次打开搜索框都是空的', () => {
    const { rerender } = render(
      <ForwardPicker open={false} preview="" onSend={() => {}} onClose={() => {}} />,
    );
    expect(document.querySelector('.cpick')).toBeNull();
    rerender(<ForwardPicker open preview="" onSend={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('搜索'), { target: { value: '妈' } });
    rerender(<ForwardPicker open={false} preview="" onSend={() => {}} onClose={() => {}} />);
    rerender(<ForwardPicker open preview="" onSend={() => {}} onClose={() => {}} />);
    expect((screen.getByPlaceholderText('搜索') as HTMLInputElement).value).toBe('');
  });
});

describe('转发：点了不立刻发，先确认', () => {
  it('确认卡写着发给谁、发的是什么；此时什么都还没发', () => {
    const { onSend } = openForward();
    fireEvent.click(screen.getByText('林小雨'));
    const card = screen.getByRole('alertdialog');
    expect(within(card).getByText('发送给：')).toBeTruthy();
    expect(within(card).getByText('林小雨')).toBeTruthy();
    expect(within(card).getByText('今晚吃火锅吗')).toBeTruthy();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('取消回到列表，不发', () => {
    const { onSend, onClose } = openForward();
    fireEvent.click(screen.getByText('妈妈'));
    fireEvent.click(screen.getByText('取消'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.getByRole('dialog', { name: '选择一个聊天' })).toBeTruthy();
    expect(onSend).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('发送：带上「给朋友留言」，关掉整页', () => {
    const { onSend, onClose } = openForward();
    fireEvent.click(screen.getByText('周末爬山小分队'));
    fireEvent.change(screen.getByPlaceholderText('给朋友留言'), { target: { value: '  看看这个  ' } });
    fireEvent.click(screen.getByText('发送'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSend).toHaveBeenCalledTimes(1);
    const [to, note] = onSend.mock.calls[0];
    expect((to as ConversationVM).id).toBe('c_hike');
    expect(note).toBe('看看这个');
  });

  it('留言只有空白 = 没有留言', () => {
    const { onSend } = openForward();
    fireEvent.click(screen.getByText('妈妈'));
    fireEvent.change(screen.getByPlaceholderText('给朋友留言'), { target: { value: '   ' } });
    fireEvent.click(screen.getByText('发送'));
    expect(onSend.mock.calls[0][1]).toBeUndefined();
  });

  it('返回键：先关确认卡，再关整页', () => {
    const { onClose } = openForward();
    fireEvent.click(screen.getByText('林小雨'));
    act(() => {
      expect(popDismiss()).toBe(true);
    });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    act(() => {
      expect(popDismiss()).toBe(true);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('送达顺序：被转发的在前，留言在后', () => {
  const item: Omit<MessageVM, 'id'> = {
    convId: 'c_lin',
    senderId: 'self',
    type: 'image',
    content: 'img:abc',
    status: 'sent',
    createdAt: 1000,
  };

  it('两条依次写入；第二条是同一会话里自己的文字', async () => {
    const order: Array<Omit<MessageVM, 'id'>> = [];
    let landed = false;
    const append = async (m: Omit<MessageVM, 'id'>) => {
      // The note must not be written until the item has landed (rowid order).
      if (m.type === 'text') expect(landed, '留言抢在被转发的东西前面落库了').toBe(true);
      await Promise.resolve();
      order.push(m);
      if (m === item) landed = true;
    };
    await deliverForward(append, item, ' 看看 ', () => 2000);
    expect(order.map((m) => m.type)).toEqual(['image', 'text']);
    expect(order[1]).toMatchObject({ convId: 'c_lin', senderId: 'self', content: '看看', createdAt: 2000 });
  });

  it('没有留言就只发一条；时钟倒退也不让留言早于被转发的那条', async () => {
    const order: Array<Omit<MessageVM, 'id'>> = [];
    const append = async (m: Omit<MessageVM, 'id'>) => void order.push(m);
    await deliverForward(append, item, undefined, () => 5);
    await deliverForward(append, item, '', () => 5);
    expect(order).toHaveLength(2);
    order.length = 0;
    await deliverForward(append, item, '嗯', () => 5);
    expect(order[1].createdAt).toBe(item.createdAt);
  });

  it('被转发的那条失败了，留言不发', async () => {
    const append = vi.fn(async (m: Omit<MessageVM, 'id'>) => {
      if (m.type === 'image') throw new Error('disk full');
    });
    await expect(deliverForward(append, item, '看看', () => 2000)).rejects.toThrow('disk full');
    expect(append).toHaveBeenCalledTimes(1);
  });
});

describe('群 @「选择提醒的人」', () => {
  const members = [contact('a', '林小雨', '小雨'), contact('b', '阿杨'), contact('c', '周老师')];

  it('列出这个群的成员；有备注先显示备注', () => {
    render(<MentionPicker open members={members} onPick={() => {}} onClose={() => {}} />);
    expect(screen.getByRole('dialog', { name: '选择提醒的人' })).toBeTruthy();
    expect(rowNames()).toEqual(['小雨', '阿杨', '周老师']);
  });

  it('备注和本名都能搜到', () => {
    render(<MentionPicker open members={members} onPick={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('搜索'), { target: { value: '林' } });
    expect(rowNames()).toEqual(['小雨']);
    fireEvent.change(screen.getByPlaceholderText('搜索'), { target: { value: '老师' } });
    expect(rowNames()).toEqual(['周老师']);
    fireEvent.change(screen.getByPlaceholderText('搜索'), { target: { value: '王' } });
    expect(screen.getByText('没有找到「王」')).toBeTruthy();
  });

  it('点一个人 → onPick 那个人；返回键 → 关闭', () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    render(<MentionPicker open members={members} onPick={onPick} onClose={onClose} />);
    fireEvent.click(screen.getByText('阿杨'));
    expect(onPick).toHaveBeenCalledWith(members[1]);
    act(() => {
      popDismiss();
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('接线：两处转发、一处 @ 都走新选择器', () => {
  const chat = strip(read('src/features/chat/ChatPage.tsx'));
  const fav = strip(read('src/features/favorites/FavoritesPage.tsx'));

  it('聊天页不再自带转发面板与过滤，也不再有半屏的「提醒谁看」', () => {
    expect(chat).toContain('<ForwardPicker');
    expect(chat).toContain('<MentionPicker');
    expect(chat, '聊天页又手写了一份转发候选过滤').not.toMatch(/isHidden && c\.id !== convId/);
    expect(chat).not.toContain('title="发送给"');
    expect(chat).not.toContain('title="提醒谁看"');
  });

  it('两处都经 deliverForward 送达（留言的顺序只有一份实现）', () => {
    expect(chat).toMatch(/deliverForward\(appendMessage, item, note, Date\.now\)/);
    expect(fav).toMatch(/deliverForward\(appendMessage, msg, note, Date\.now\)/);
    expect(fav).toContain('<ForwardPicker');
  });

  it('旧的半屏 ForwardSheet 已经不在了', () => {
    expect(() => read('src/components/ForwardSheet.tsx')).toThrow();
  });
});
