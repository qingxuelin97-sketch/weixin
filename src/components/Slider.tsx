import { useRef, type PointerEvent as ReactPointerEvent } from 'react';
import './slider.css';

/**
 * 连续滑杆 (M-K6)：替掉浏览器原生的 `<input type="range">`（蓝色、各平台长得不一样、
 * 拖动手感与微信对不上）。细灰轨道 + 绿色已填充段 + 白色圆钮。
 *
 * 值按 step 吸附，并按 step 的小数位取整——浮点累加（0.1+0.2）不会漏进存储。
 * 拖动用指针事件并 setPointerCapture，手指滑出轨道也不丢。键盘左右键可微调。
 */
export function Slider({
  min,
  max,
  step = 1,
  value,
  onChange,
  label,
}: {
  min: number;
  max: number;
  step?: number;
  value: number;
  onChange: (v: number) => void;
  /** 无障碍名。 */
  label: string;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const decimals = (step.toString().split('.')[1] ?? '').length;

  const snap = (raw: number): number => {
    const clamped = Math.min(max, Math.max(min, raw));
    const k = Math.round((clamped - min) / step);
    const v = min + k * step;
    return Number(Math.min(max, Math.max(min, v)).toFixed(decimals));
  };

  const at = (clientX: number): number => {
    const el = trackRef.current;
    if (!el) return value;
    const r = el.getBoundingClientRect();
    const t = r.width > 0 ? (clientX - r.left) / r.width : 0;
    return snap(min + t * (max - min));
  };
  const pick = (clientX: number) => {
    const v = at(clientX);
    if (v !== value) onChange(v);
  };
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    dragging.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    pick(e.clientX);
  };
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dragging.current) pick(e.clientX);
  };
  const onUp = () => {
    dragging.current = false;
  };

  const pct = max === min ? 0 : ((value - min) / (max - min)) * 100;
  return (
    <div className="slider">
      <div
        className="slider__track"
        ref={trackRef}
        role="slider"
        aria-label={label}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={value}
        tabIndex={0}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') onChange(snap(value - step));
          else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') onChange(snap(value + step));
          else return;
          e.preventDefault();
        }}
      >
        <div className="slider__line" />
        <div className="slider__fill" style={{ width: `${pct}%` }} />
        <span className="slider__thumb" style={{ left: `${pct}%` }} />
      </div>
    </div>
  );
}
