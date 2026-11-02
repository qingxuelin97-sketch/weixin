import { useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import './step-slider.css';

/**
 * 微信式分档滑杆 (M-K5)：一条细线、每档一个刻度、一颗带阴影的白色圆钮。
 * 点刻度直接跳、按住拖动吸附到最近一档。字体大小页用它；人设编辑页的
 * 「主动性」「打字速度」在 M-K6 换上它，替掉浏览器原生的蓝色 range。
 *
 * 档位离散是刻意的：连续值的滑杆会让人「拖到一半不知道停在哪」，而这里的
 * 每一个值都有名字（标准 / 大 / 特大……）。
 */
export function StepSlider({
  steps,
  value,
  onChange,
  marks,
  left,
  right,
  label,
}: {
  steps: number;
  value: number;
  onChange: (index: number) => void;
  /** 刻度上方的文字，如 `{ 1: '标准' }`。 */
  marks?: Record<number, string>;
  /** 两端的标识（如小 A / 大 A）。 */
  left?: ReactNode;
  right?: ReactNode;
  /** 无障碍名。 */
  label: string;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const last = Math.max(1, steps - 1);

  const indexAt = (clientX: number): number => {
    const el = trackRef.current;
    if (!el) return value;
    const r = el.getBoundingClientRect();
    const t = r.width > 0 ? (clientX - r.left) / r.width : 0;
    return Math.max(0, Math.min(last, Math.round(t * last)));
  };
  const pick = (clientX: number) => {
    const i = indexAt(clientX);
    if (i !== value) onChange(i);
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

  const pct = (i: number) => `${(i / last) * 100}%`;
  return (
    <div className="step-slider">
      {left != null && <span className="step-slider__end">{left}</span>}
      <div
        className="step-slider__track"
        ref={trackRef}
        role="slider"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={last}
        aria-valuenow={value}
        aria-valuetext={marks?.[value]}
        tabIndex={0}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' && value > 0) onChange(value - 1);
          else if (e.key === 'ArrowRight' && value < last) onChange(value + 1);
        }}
      >
        <div className="step-slider__line" />
        {Array.from({ length: steps }, (_, i) => (
          <span key={i} className="step-slider__tick" style={{ left: pct(i) }}>
            {marks?.[i] && <span className="step-slider__mark">{marks[i]}</span>}
          </span>
        ))}
        <span className="step-slider__thumb" style={{ left: pct(value) }} />
      </div>
      {right != null && <span className="step-slider__end">{right}</span>}
    </div>
  );
}
