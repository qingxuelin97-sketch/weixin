// @vitest-environment jsdom
/**
 * 「＋」面板重塑 (M-K1)。
 *
 * 三件事：
 * 1. 单聊 / 群聊各一套分页，钱那一格按场景换；
 * 2. **每一格都真的能点**——面板上的每个 key 在 ChatPage 的 onAction 里都有
 *    分支，并且那条「暂未开放」兜底不许回来。拍摄与语音输入从 M5 起就是死格；
 *    死格的代价不是「少个功能」，是用户点一下、什么都没发生，然后不再相信
 *    这一排按钮；
 * 3. 渲染出来是图标 + 文字，不是纯色块（这正是本期要消灭的那个原型感）。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ComposerPanels, plusPages } from '../../src/features/chat/ComposerPanels';

afterEach(cleanup);

const keys = (isGroup: boolean) => plusPages(isGroup).map((p) => p.map((it) => it.key));

describe('分页与场景', () => {
  it('单聊：第一页 4×2 满格，钱那一格是转账；第二页名片与文件', () => {
    expect(keys(false)).toEqual([
      ['album', 'camera', 'call', 'location', 'redpacket', 'transfer', 'voiceinput', 'fav'],
      ['namecard', 'file'],
    ]);
  });

  it('群聊：同一格换成群收款，通话那格叫「语音通话」（群里没有视频）', () => {
    const [p1] = plusPages(true);
    expect(p1.map((it) => it.key)).toContain('groupbill');
    expect(p1.map((it) => it.key)).not.toContain('transfer');
    expect(p1.find((it) => it.key === 'call')!.label).toBe('语音通话');
    expect(plusPages(false)[0].find((it) => it.key === 'call')!.label).toBe('视频通话');
  });

  it('每页不超过 8 格（4×2），否则会被锁定的面板高度裁掉', () => {
    for (const g of [false, true]) for (const page of plusPages(g)) expect(page.length).toBeLessThanOrEqual(8);
  });
});

describe('没有死格', () => {
  const src = readFileSync(resolve(__dirname, '../../src/features/chat/ChatPage.tsx'), 'utf8')
    // 宪法 3.5：源码守卫先剥注释——解释「暂未开放」的注释本身就含有它。
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1');

  it('面板上的每个 key 在 ChatPage 的 onAction 里都有分支', () => {
    const all = new Set([...keys(false).flat(), ...keys(true).flat()]);
    const unhandled = [...all].filter((k) => !src.includes(`key === '${k}'`));
    expect(unhandled, '这些格子点了没反应').toEqual([]);
  });

  it('onAction 里那条「暂未开放」兜底不许回来', () => {
    const start = src.indexOf('onAction={(key) =>');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf('onEmoji=', start));
    expect(body).not.toContain('暂未开放');
  });
});

describe('渲染', () => {
  it('每一格都是图标 + 文字；两页就画两个分页点', () => {
    const { container } = render(<ComposerPanels mode="plus" height={300} />);
    const tiles = container.querySelectorAll('.plus-grid__tile');
    expect(tiles.length).toBe(10);
    tiles.forEach((t) => expect(t.querySelector('svg')).not.toBeNull());
    expect(container.querySelectorAll('.plus-dots__dot').length).toBe(2);
    expect(screen.getByText('个人名片')).toBeTruthy();
  });

  it('点一格把它的 key 交出去；灰掉的格子不交', () => {
    const onAction = vi.fn();
    render(<ComposerPanels mode="plus" height={300} onAction={onAction} disabledKeys={['file']} />);
    fireEvent.click(screen.getByText('拍摄'));
    fireEvent.click(screen.getByText('文件'));
    expect(onAction.mock.calls).toEqual([['camera']]);
  });

  it('群聊变体渲染群收款', () => {
    render(<ComposerPanels mode="plus" height={300} isGroup />);
    expect(screen.getByText('群收款')).toBeTruthy();
    expect(screen.queryByText('转账')).toBeNull();
  });
});
