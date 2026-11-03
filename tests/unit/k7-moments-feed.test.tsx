// @vitest-environment jsdom
/**
 * 朋友圈 feed 重塑 (M-K7)。
 *
 * 写在最前面的那条是真 bug：M-I15 给封面盒子加了 `overflow: hidden`（为了裹住封面
 * 照片——其实照片是 inset:0 + object-fit:cover，根本不会溢出），结果把
 * `.moments__self` 故意挂出封面下沿 20px 的头像切掉了——微信朋友圈最认得出的那个
 * 细节，渲染成一块 64×44 的扁方块，持续了两轮。截图门禁照单全收：基线是在 bug
 * 之后铸的，它只保证「和上次一样扁」。
 *
 * 其余是这一期的形状：赞评浮层不再挤占时间行、点别处即收；评论块有指向时间行的
 * 小三角与描边爱心；feed 的字号走 --fs-*（此前写死 px，「字体大小」管不到朋友圈）；
 * 「N条新消息」胶囊与它打开的「消息」列表。
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { MomentCard } from '../../src/features/moments/MomentCard';
import { MomentMessagesPage } from '../../src/features/moments/MomentMessagesPage';
import { MomentsPage } from '../../src/features/moments/MomentsPage';
import { useAppStore } from '../../src/store/appStore';
import type {
  ContactVM,
  MomentCommentVM,
  MomentLikeVM,
  MomentVM,
} from '../../src/data/types';

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
/** 宪法 3.5：先剥注释——解释「这里不许 overflow: hidden」的注释本身就含有它。 */
const CSS = read('src/features/moments/moments.css').replace(/\/\*[\s\S]*?\*\//g, '');

/** Every declaration block for an exact selector (the file has several per selector). */
function blocks(selector: string): string[] {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...CSS.matchAll(new RegExp(`(?:^|\\n|,\\s*)${esc}\\s*\\{([^}]*)\\}`, 'g'))].map((m) => m[1]);
}

afterEach(cleanup);
beforeEach(() => {
  // jsdom has no matchMedia; the feed's stagger asks about reduced motion.
  window.matchMedia ??= ((q: string) =>
    ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
});

const NOW = 1_760_000_000_000;
const MIN = 60_000;

const contact = (id: string, name: string, type: ContactVM['type'] = 'ai'): ContactVM =>
  ({ id, name, type, avatarText: name[0], avatarColor: 'var(--color-brand)' }) as ContactVM;

const post = (id: string, authorId: string, over: Partial<MomentVM> = {}): MomentVM => ({
  id,
  authorId,
  text: '今天的晚霞',
  imageRefs: [],
  isNsfw: false,
  createdAt: NOW - 60 * MIN,
  ...over,
});

describe('封面与头像叠压（真 bug）', () => {
  it('封面盒子不裁切：头像挂出下沿的那 20px 必须画得出来', () => {
    for (const b of blocks('.moments__cover')) {
      expect(b, '.moments__cover 又被加了 overflow 裁切，头像会被切扁').not.toMatch(/overflow\s*:\s*(hidden|clip)/);
    }
  });

  it('头像确实挂在封面下沿之外（bottom 为负）', () => {
    const self = blocks('.moments__self').join('\n');
    expect(self).toMatch(/bottom:\s*-\d+px/);
  });
});

describe('「··」赞评浮层', () => {
  const card = (over: Partial<Parameters<typeof MomentCard>[0]> = {}) =>
    render(
      <MemoryRouter>
        <div data-testid="outside">别处</div>
        <MomentCard
          moment={post('m1', 'ai_a')}
          author={contact('ai_a', 'Ada')}
          likes={[]}
          comments={[]}
          nameOf={(id) => id}
          selfLiked={false}
          now={NOW}
          onToggleLike={() => {}}
          onComment={() => {}}
          {...over}
        />
      </MemoryRouter>,
    );

  it('浮层是绝对定位的，不占时间行的位置', () => {
    expect(blocks('.moment__pop').join('\n')).toMatch(/position:\s*absolute/);
    expect(blocks('.moment__actions').join('\n')).toMatch(/position:\s*relative/);
  });

  it('每一项都是图标 + 文字', () => {
    card({ onRepost: () => {} });
    fireEvent.click(screen.getByLabelText('赞或评论', { selector: 'button' }));
    const items = [...document.querySelectorAll('.moment__pop button')];
    expect(items.map((b) => b.textContent)).toEqual(['赞', '评论', '转发']);
    for (const b of items) expect(b.querySelector('svg'), `${b.textContent} 没有图标`).not.toBeNull();
  });

  it('点别处收起；点浮层里面不收', () => {
    card();
    fireEvent.click(screen.getByLabelText('赞或评论', { selector: 'button' }));
    expect(document.querySelector('.moment__pop')).not.toBeNull();
    fireEvent.pointerDown(document.querySelector('.moment__pop')!);
    expect(document.querySelector('.moment__pop')).not.toBeNull();
    fireEvent.pointerDown(screen.getByTestId('outside'));
    expect(document.querySelector('.moment__pop')).toBeNull();
  });

  it('滚动收起（微信同款：一滑浮层就没了）', () => {
    card();
    fireEvent.click(screen.getByLabelText('赞或评论', { selector: 'button' }));
    fireEvent.scroll(screen.getByTestId('outside'));
    expect(document.querySelector('.moment__pop')).toBeNull();
  });

  it('点「赞」调用一次 toggle 并收起', () => {
    const onToggleLike = vi.fn();
    card({ onToggleLike });
    fireEvent.click(screen.getByLabelText('赞或评论', { selector: 'button' }));
    fireEvent.click(screen.getByText('赞'));
    expect(onToggleLike).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.moment__pop')).toBeNull();
  });
});

describe('评论条', () => {
  it('有指向时间行的小三角，点赞行是描边爱心而不是字体字符', () => {
    expect(CSS).toMatch(/\.moment__reactions::before\s*\{[^}]*border-bottom-color:\s*var\(--color-moments-comment-bg\)/);
    const likes: MomentLikeVM[] = [{ id: 'm1:ai_b', momentId: 'm1', contactId: 'ai_b', createdAt: NOW }];
    render(
      <MemoryRouter>
        <MomentCard
          moment={post('m1', 'ai_a')}
          author={contact('ai_a', 'Ada')}
          likes={likes}
          comments={[]}
          nameOf={() => '陈叔'}
          selfLiked={false}
          now={NOW}
          onToggleLike={() => {}}
          onComment={() => {}}
        />
      </MemoryRouter>,
    );
    const row = document.querySelector('.moment__likes')!;
    expect(row.querySelector('svg')).not.toBeNull();
    expect(row.textContent).toBe('陈叔');
  });
});

describe('朋友圈的字跟着「字体大小」走', () => {
  it('昵称 / 正文 / 时间 / 评论条用 --fs-* token，不写死 px', () => {
    for (const sel of ['.moment__author', '.moment__text', '.moment__time', '.moment__reactions']) {
      const fs = blocks(sel).join('\n').match(/font-size:\s*([^;]+);/)?.[1];
      expect(fs, `${sel} 的字号`).toMatch(/^var\(--fs-/);
    }
  });

  it('中文不用粗体（design-tokens：字重只有 400 / 500）', () => {
    expect(CSS.match(/font-weight:\s*(600|700|bold)/g) ?? []).toEqual([]);
  });
});

describe('「消息」列表', () => {
  const me = contact('self', '我', 'self');
  const ada = contact('ai_a', 'Ada');
  const chen = contact('ai_c', '陈叔');
  const mine = post('mine', 'self', { text: '晚霞', imageRefs: [] });
  const likes: MomentLikeVM[] = [
    { id: 'mine:ai_a', momentId: 'mine', contactId: 'ai_a', createdAt: NOW - 3 * MIN },
    { id: 'mine:ai_c', momentId: 'mine', contactId: 'ai_c', createdAt: NOW - 40 * MIN },
  ];
  const comments: MomentCommentVM[] = [
    { id: 'c1', momentId: 'mine', authorId: 'ai_c', text: '拍得真好', createdAt: NOW - 2 * MIN },
  ];
  const repost = post('rp', 'ai_a', { repostOf: 'mine', createdAt: NOW - 50 * MIN });

  beforeEach(() => {
    useAppStore.setState({
      contacts: [me, ada, chen],
      moments: [mine, repost],
      momentLikes: { mine: likes },
      momentComments: { mine: comments },
      momentsLoaded: true,
    });
  });

  const page = (url: string) =>
    render(
      <MemoryRouter initialEntries={[url]}>
        <Routes>
          <Route path="/moments/messages" element={<MomentMessagesPage />} />
        </Routes>
      </MemoryRouter>,
    );

  it('从胶囊进来（?n=2）先只列新的两条，「查看更早的消息」展开全部', () => {
    page('/moments/messages?n=2');
    expect(document.querySelectorAll('.mmsg__row')).toHaveLength(2);
    // Newest first: 陈叔's comment (−2min), then Ada's like (−3min).
    const rows = [...document.querySelectorAll('.mmsg__row')];
    expect(rows[0].textContent).toContain('拍得真好');
    expect(rows[1].querySelector('.mmsg__heart svg')).not.toBeNull();
    fireEvent.click(screen.getByText('查看更早的消息…'));
    expect(document.querySelectorAll('.mmsg__row')).toHaveLength(4);
    expect(screen.getByText('转发了你的朋友圈')).toBeTruthy();
  });

  it('直接进来列全部；没有更早的就不画「查看更早」', () => {
    page('/moments/messages');
    expect(document.querySelectorAll('.mmsg__row')).toHaveLength(4);
    expect(screen.queryByText('查看更早的消息…')).toBeNull();
  });

  it('别人的帖子上的互动不进「消息」', () => {
    useAppStore.setState({
      moments: [post('theirs', 'ai_a')],
      momentLikes: { theirs: [{ id: 'theirs:ai_c', momentId: 'theirs', contactId: 'ai_c', createdAt: NOW }] },
      momentComments: {},
    });
    page('/moments/messages');
    expect(screen.getByText('暂无消息')).toBeTruthy();
  });
});

describe('「N条新消息」胶囊', () => {
  it('进 feed 时先拍下新消息再推进水位，水位用刷新之前的时刻', async () => {
    const order: string[] = [];
    let refreshedAt = 0;
    let seenArg = 0;
    const news = {
      count: 2,
      actorId: 'ai_a',
      items: [
        { kind: 'like' as const, actorId: 'ai_a', momentId: 'mine', at: NOW },
        { kind: 'like' as const, actorId: 'ai_c', momentId: 'mine', at: NOW - MIN },
      ],
    };
    useAppStore.setState({
      contacts: [contact('self', '我', 'self'), contact('ai_a', 'Ada'), contact('ai_c', '陈叔')],
      moments: [],
      momentsLoaded: true,
      momentsNews: { count: 0, items: [] },
      loadMoments: async () => {},
      refreshMomentsNews: async () => {
        order.push('refresh');
        // A refresh takes real time (IndexedDB reads). Anything that lands in
        // that window is newer than what the capsule shows.
        await new Promise((r) => setTimeout(r, 5));
        refreshedAt = Date.now();
        useAppStore.setState({ momentsNews: news });
      },
      markMomentsSeen: async (t: number) => {
        order.push('mark');
        seenArg = t;
        useAppStore.setState({ momentsNews: { count: 0, items: [] } });
      },
    });
    await act(async () => {
      render(
        <MemoryRouter initialEntries={['/moments']}>
          <Routes>
            <Route path="/moments" element={<MomentsPage />} />
          </Routes>
        </MemoryRouter>,
      );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(order).toEqual(['refresh', 'mark']);
    // Watermark = the moment BEFORE the refresh started, so a like that
    // arrived mid-refresh stays news for next time instead of being marked
    // read without ever being shown.
    expect(seenArg).toBeLessThan(refreshedAt);
    // The badge in the store is consumed…
    expect(useAppStore.getState().momentsNews.count).toBe(0);
    // …but this visit still shows what was new.
    expect(screen.getByText('2条新消息')).toBeTruthy();
  });
});
