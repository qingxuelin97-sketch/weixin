// @vitest-environment jsdom
/**
 * 表单控件微信化 (M-K6)。
 *
 * 1. 源码守卫：src 里不许再出现浏览器原生的 <select> 与 <input type="range">——它们的
 *    外观与手感都是系统的，不是微信的。（先剥注释，宪法 3.5。）
 * 2. Slider：按 step 吸附、浮点不漏进存储、键盘微调、两端夹紧。
 * 3. PickerRow：点开底部面板，列出全部选项，当前项打勾，选别的才回调。
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Slider } from '../../src/components/Slider';
import { PickerRow } from '../../src/components/PickerRow';

afterEach(cleanup);

const ROOT = resolve(__dirname, '../..');
function srcFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) srcFiles(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');

describe('源码守卫：没有原生表单控件', () => {
  it('解析器没有失明：扫到了 src 下的文件', () => {
    expect(srcFiles('src/features').length).toBeGreaterThan(50);
  });
  it('src 里不再有 <select>', () => {
    const hits = srcFiles('src').filter((f) => /<select[\s>]/.test(stripComments(readFileSync(join(ROOT, f), 'utf8'))));
    expect(hits, '原生下拉框回来了——用 PickerRow').toEqual([]);
  });
  it('src 里不再有 <input type="range">', () => {
    const hits = srcFiles('src').filter((f) =>
      /type=["']range["']/.test(stripComments(readFileSync(join(ROOT, f), 'utf8'))),
    );
    expect(hits, '原生滑杆回来了——用 Slider').toEqual([]);
  });
});

/** jsdom 的 getBoundingClientRect 全是 0，给轨道一个真实宽度。 */
function withWidth(el: HTMLElement, width = 200) {
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: width, bottom: 32, width, height: 32, x: 0, y: 0, toJSON() {} }) as DOMRect;
}

describe('Slider', () => {
  it('按 step 吸附：0.05 步进，取值不带浮点尾巴', () => {
    const onChange = vi.fn();
    render(<Slider label="温度" min={0} max={1.5} step={0.05} value={0.5} onChange={onChange} />);
    const track = screen.getByRole('slider', { name: '温度' });
    withWidth(track, 200);
    // 100px / 200px = 0.5 of 1.5 = 0.75 → 吸附到 0.75
    fireEvent.pointerDown(track, { clientX: 100 });
    expect(onChange).toHaveBeenLastCalledWith(0.75);
    expect(onChange.mock.calls.every(([v]) => Number.isInteger(Math.round(v / 0.05 * 1e6) / 1e6))).toBe(true);
  });

  it('键盘左右微调一个 step，并在两端夹紧', () => {
    const onChange = vi.fn();
    const { rerender } = render(<Slider label="主动性" min={0} max={1} step={0.05} value={0.6} onChange={onChange} />);
    const track = screen.getByRole('slider', { name: '主动性' });
    fireEvent.keyDown(track, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith(0.65);
    fireEvent.keyDown(track, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith(0.55);
    rerender(<Slider label="主动性" min={0} max={1} step={0.05} value={1} onChange={onChange} />);
    onChange.mockClear();
    fireEvent.keyDown(screen.getByRole('slider', { name: '主动性' }), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith(1);
  });

  it('整数档（亲密度 0–100，步长 5）', () => {
    const onChange = vi.fn();
    render(<Slider label="亲密度" min={0} max={100} step={5} value={50} onChange={onChange} />);
    const track = screen.getByRole('slider', { name: '亲密度' });
    withWidth(track, 200);
    fireEvent.pointerDown(track, { clientX: 61 }); // 30.5% of 100 → 30 (k=6)
    expect(onChange).toHaveBeenLastCalledWith(30);
  });

  it('暴露无障碍的 value 语义', () => {
    render(<Slider label="打字速度" min={120} max={500} step={10} value={320} onChange={() => {}} />);
    const t = screen.getByRole('slider', { name: '打字速度' });
    expect(t.getAttribute('aria-valuenow')).toBe('320');
    expect(t.getAttribute('aria-valuemin')).toBe('120');
    expect(t.getAttribute('aria-valuemax')).toBe('500');
  });
});

describe('PickerRow', () => {
  const opts = [
    { value: 'a', label: '很粘人' },
    { value: 'b', label: '常规' },
    { value: 'c', label: '高冷' },
  ];

  it('显示当前选项的文字，而不是裸 value', () => {
    render(<PickerRow label="频率" value="b" options={opts} onChange={() => {}} />);
    expect(screen.getByText('常规')).toBeTruthy();
    expect(screen.queryByText('b')).toBeNull();
  });

  it('点开面板列出全部选项；当前项 aria-selected 且打勾', () => {
    render(<PickerRow label="频率" value="b" options={opts} onChange={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /频率/ }));
    const rows = screen.getAllByRole('option');
    expect(rows.map((r) => r.textContent)).toEqual(['很粘人', '常规', '高冷']);
    expect(rows.map((r) => r.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    expect(rows[1].querySelector('svg')).not.toBeNull();
  });

  it('选别的才回调；选当前项不回调', () => {
    const onChange = vi.fn();
    render(<PickerRow label="频率" value="b" options={opts} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /频率/ }));
    fireEvent.click(screen.getAllByRole('option')[1]);
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /频率/ }));
    fireEvent.click(screen.getAllByRole('option')[2]);
    expect(onChange).toHaveBeenCalledWith('c');
  });
});
