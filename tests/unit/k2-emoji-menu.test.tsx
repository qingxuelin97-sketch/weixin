// @vitest-environment jsdom
/**
 * 表情面板 + 消息长按菜单 (M-K2)。
 *
 * 菜单那一半是本期抓到的真 bug：一条横排文字胶囊装十个动作，后六个（转发、收藏、
 * 翻译、置顶、多选、删除）整个排在屏幕右边外面——长按一条消息根本删不掉它。
 * 换成微信 8.0 的五列网格之后，最要紧的不变量是「面板永远完整落在屏幕里」，
 * 所以 placement 是纯函数、在四个角上逐一验。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ComposerPanels } from '../../src/features/chat/ComposerPanels';
import { EMOJI_SET, pushRecent, RECENT_MAX, RECENT_KEY } from '../../src/features/chat/emoji-set';
import {
  LongPressMenu,
  gridMenuPlacement,
  GRID_COLS,
} from '../../src/components/LongPressMenu';
import { isFallbackIcon } from '../../src/components/menu-icons';

afterEach(cleanup);
beforeEach(() => localStorage.clear());

describe('表情数据', () => {
  it('120 个、互不重复、正好填满 8 列', () => {
    expect(EMOJI_SET.length).toBe(120);
    expect(new Set(EMOJI_SET).size).toBe(EMOJI_SET.length);
    expect(EMOJI_SET.length % 8).toBe(0);
  });

  it('最近使用：移到最前、去重、最多 8 个', () => {
    let r: string[] = [];
    for (const e of EMOJI_SET.slice(0, 10)) r = pushRecent(r, e);
    expect(r.length).toBe(RECENT_MAX);
    expect(r[0]).toBe(EMOJI_SET[9]);
    r = pushRecent(r, EMOJI_SET[5]);
    expect(r[0]).toBe(EMOJI_SET[5]);
    expect(r.filter((x) => x === EMOJI_SET[5]).length).toBe(1);
  });
});

describe('表情面板', () => {
  it('点表情：交给调用方，并出现「最近使用」一行（且记住）', () => {
    const onEmoji = vi.fn();
    const { container } = render(<ComposerPanels mode="emoji" height={300} onEmoji={onEmoji} />);
    expect(screen.queryByText('最近使用')).toBeNull();
    const items = container.querySelectorAll('.emoji-grid__item');
    expect(items.length).toBe(120);
    fireEvent.click(items[3]);
    expect(onEmoji).toHaveBeenCalledWith(EMOJI_SET[3]);
    expect(screen.getByText('最近使用')).toBeTruthy();
    expect(JSON.parse(localStorage.getItem(RECENT_KEY)!)).toEqual([EMOJI_SET[3]]);
  });

  it('「发送」只在草稿非空时可点', () => {
    const onSend = vi.fn();
    const { rerender } = render(<ComposerPanels mode="emoji" height={300} onSend={onSend} />);
    const send = () => screen.getByRole('button', { name: '发送' });
    expect((send() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(send());
    expect(onSend).not.toHaveBeenCalled();
    rerender(<ComposerPanels mode="emoji" height={300} onSend={onSend} canSend />);
    fireEvent.click(send());
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('♡ 页：＋、猜拳、骰子——骰子与猜拳在微信里就住这一页', () => {
    const onGame = vi.fn();
    const onManage = vi.fn();
    render(
      <ComposerPanels
        mode="emoji"
        height={300}
        onGame={onGame}
        onSticker={() => {}}
        onManageStickers={onManage}
        stickers={[]}
      />,
    );
    fireEvent.click(screen.getByRole('tab', { name: '收藏的表情' }));
    fireEvent.click(screen.getByText('掷骰子'));
    fireEvent.click(screen.getByText('猜拳'));
    fireEvent.click(screen.getByRole('button', { name: '添加表情' }));
    expect(onGame.mock.calls).toEqual([['dice'], ['rps']]);
    expect(onManage).toHaveBeenCalledTimes(1);
  });
});

describe('消息菜单的网格几何', () => {
  const vp = { w: 390, h: 844 };
  const inside = (p: ReturnType<typeof gridMenuPlacement>) =>
    p.left >= 0 && p.top >= 0 && p.left + p.width <= vp.w && p.top + p.height <= vp.h;

  it('十个动作 → 两行五列，宽度放得进 390 的屏幕', () => {
    const p = gridMenuPlacement(10, { x: 200, y: 500 }, vp);
    expect(p.cols).toBe(GRID_COLS);
    expect(p.width).toBeLessThanOrEqual(vp.w - 16);
    expect(inside(p)).toBe(true);
  });

  it('四个角上按下，面板都完整落在屏幕里，三角都在面板之内', () => {
    for (const at of [
      { x: 2, y: 60 },
      { x: 388, y: 60 },
      { x: 2, y: 840 },
      { x: 388, y: 840 },
      { x: 195, y: 422 },
    ]) {
      for (const n of [1, 3, 5, 10, 12]) {
        const p = gridMenuPlacement(n, at, vp);
        expect(inside(p), `n=${n} at=${JSON.stringify(at)}`).toBe(true);
        expect(p.arrowX).toBeGreaterThan(0);
        expect(p.arrowX).toBeLessThan(p.width);
      }
    }
  });

  it('上方放不下就翻到手指下方', () => {
    expect(gridMenuPlacement(10, { x: 200, y: 80 }, vp).below).toBe(true);
    expect(gridMenuPlacement(10, { x: 200, y: 600 }, vp).below).toBe(false);
  });
});

describe('消息菜单的图标', () => {
  /** ChatPage 里 msgMenuItems 的全部文案（含三元表达式两侧）。 */
  function chatMenuLabels(): string[] {
    const src = readFileSync(resolve(__dirname, '../../src/features/chat/ChatPage.tsx'), 'utf8');
    const start = src.indexOf('const msgMenuItems');
    expect(start, 'msgMenuItems 不见了——解析器失明').toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('return items', start));
    const labels: string[] = [];
    for (const line of body.split('\n')) {
      if (!line.includes('label:')) continue;
      for (const m of line.matchAll(/'([^']+)'/g)) labels.push(m[1]);
    }
    return labels;
  }

  it('解析器没有失明：认出了一整套动作', () => {
    const labels = chatMenuLabels();
    expect(labels).toEqual(expect.arrayContaining(['复制', '转发', '收藏', '删除', '多选']));
    expect(labels.length).toBeGreaterThanOrEqual(12);
  });

  it('聊天页消息菜单的每个动作都有自己的图标（没有一格是兜底圆点）', () => {
    expect(chatMenuLabels().filter(isFallbackIcon)).toEqual([]);
  });

  it('网格菜单每格是图标 + 文字；竖排菜单仍是纯文字', () => {
    const items = ['复制', '转发', '删除'].map((label) => ({ label, onSelect: () => {} }));
    const { container, unmount } = render(
      <LongPressMenu items={items} at={{ x: 100, y: 400 }} onClose={() => {}} />,
    );
    const cells = container.querySelectorAll('.lp-menu__cell');
    expect(cells.length).toBe(3);
    cells.forEach((c) => expect(c.querySelector('svg')).not.toBeNull());
    unmount();
    const col = render(
      <LongPressMenu items={items} at={{ x: 100, y: 400 }} layout="column" onClose={() => {}} />,
    );
    expect(col.container.querySelector('svg')).toBeNull();
  });
});
