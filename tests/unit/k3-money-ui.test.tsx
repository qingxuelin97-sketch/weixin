// @vitest-environment jsdom
/**
 * 钱包线重塑 (M-K3)。
 *
 * 1. 转账键盘的输入规则（纯函数）——钱容不得「输进去的不是你以为的」；
 * 2. **浮层路由不卸载下层页**：拆红包压在聊天上，返回时聊天那棵树必须是同一棵。
 *    PageStack 的头注释写过为什么这要紧：卸载会触发组合器把未发的字存成草稿、
 *    新挂载的那份（没见过那段字）再把草稿覆盖成空——打的字就没了。所以这里用
 *    「挂载计数」直接断言，而不是看起来像就行；
 * 3. 键盘组件：点键交出键值，金额为 0 时确认键不可点。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { useEffect } from 'react';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router-dom';
import { applyAmountKey, MAX_INT_DIGITS, type AmountKey } from '../../src/features/money/keypad';
import { MoneyKeypad } from '../../src/features/money/MoneyKeypad';
import { PageStack, isOverlayPath } from '../../src/app/PageStack';

afterEach(cleanup);

const type = (keys: AmountKey[]) => keys.reduce((a, k) => applyAmountKey(a, k), '');

describe('转账键盘的输入规则', () => {
  it('普通输入、退格', () => {
    expect(type(['5', '2', '.', '0', '1'])).toBe('52.01');
    expect(type(['5', '2', 'del'])).toBe('5');
    expect(type(['del'])).toBe('');
  });

  it('至多一个小数点、小数点后至多两位', () => {
    expect(type(['1', '.', '.', '5'])).toBe('1.5');
    expect(type(['1', '.', '2', '3', '4'])).toBe('1.23');
  });

  it('开头的 0 只能跟小数点；空串按「.」得到 0.', () => {
    expect(type(['0', '0', '7'])).toBe('7');
    expect(type(['.'])).toBe('0.');
    expect(type(['0', '.', '5'])).toBe('0.5');
  });

  it(`整数部分至多 ${MAX_INT_DIGITS} 位`, () => {
    const many: AmountKey[] = Array(10).fill('9');
    expect(type(many)).toBe('9'.repeat(MAX_INT_DIGITS));
    expect(type([...many, '.', '9', '9'])).toBe(`${'9'.repeat(MAX_INT_DIGITS)}.99`);
  });
});

describe('金额键盘组件', () => {
  it('点数字与退格交出键值；金额为 0 时确认键不可点', () => {
    const onKey = vi.fn();
    const onConfirm = vi.fn();
    render(<MoneyKeypad onKey={onKey} onConfirm={onConfirm} confirmLabel="转账" disabled />);
    fireEvent.click(screen.getByText('7'));
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    fireEvent.click(screen.getByText('转账'));
    expect(onKey.mock.calls).toEqual([['7'], ['del']]);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});

describe('浮层路由', () => {
  it('只有拆红包是浮层', () => {
    expect(isOverlayPath('/rp/open/rp_1')).toBe(true);
    expect(isOverlayPath('/rp/rp_1')).toBe(false);
    expect(isOverlayPath('/rp/send/conv_lin')).toBe(false);
  });

  it('推入浮层时下层页继续挂载；退回时不重挂载（挂载计数不变）', () => {
    const mounts = { chat: 0 };
    let go: ReturnType<typeof useNavigate> | null = null;
    function Chat() {
      useEffect(() => {
        mounts.chat++;
      }, []);
      go = useNavigate();
      return <div data-testid="chat">chat</div>;
    }
    function Open() {
      return <div data-testid="open">open</div>;
    }
    render(
      <MemoryRouter initialEntries={['/chat/c1']}>
        <PageStack>
          {(loc) => (
            <Routes location={loc}>
              <Route path="/chat/:id" element={<Chat />} />
              <Route path="/rp/open/:id" element={<Open />} />
            </Routes>
          )}
        </PageStack>
      </MemoryRouter>,
    );
    expect(mounts.chat).toBe(1);

    act(() => go!('/rp/open/rp_1'));
    // 两层同时在：聊天没走，浮层盖在上面、不是滑动切换。
    expect(screen.getByTestId('chat')).toBeTruthy();
    expect(screen.getByTestId('open')).toBeTruthy();
    expect(document.querySelector('.page-stack__page--overlay')).not.toBeNull();
    expect(document.querySelector('.page-stack--busy')).toBeNull();

    act(() => go!(-1));
    expect(screen.queryByTestId('open')).toBeNull();
    expect(screen.getByTestId('chat')).toBeTruthy();
    expect(mounts.chat, '退回浮层时聊天被重新挂载了——未发的字会被覆盖成空').toBe(1);
  });
});
