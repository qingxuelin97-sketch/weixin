/**
 * Swipe a list row open (M-H3).
 *
 * WeChat's conversation list reveals 标为已读 / 删除 by swiping left. This app
 * put those behind a long press instead — which works, and is not the gesture
 * anyone reaches for: a long press is what you do when you cannot find the
 * thing you wanted, and it costs half a second every time.
 *
 * Shared with any row that wants the same behaviour rather than living inside
 * the chat list, because the second implementation of a gesture is where the
 * two versions start disagreeing about thresholds — this repo already had that
 * happen with long-press (two copies, two different miss-guards).
 *
 * No rAF: the drag writes `transform` straight from the pointer event, and the
 * release is a spring sampled into WAAPI (see lib/spring.ts for why that
 * distinction decides whether the screenshot gate stays trustworthy).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { springTo, SPRINGS } from '../lib/spring';

/** Below this a horizontal move is a tap or the start of a scroll. */
const SLOP = 10;
/** Past half the tray, releasing opens it. */
const OPEN_RATIO = 0.5;
/** …or a flick this fast, however far it got. */
const FLICK_VELOCITY = 420;

export interface SwipeRowApi {
  /** Spread onto the row's scrolling content element. */
  handlers: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: () => void;
    onPointerCancel: (e: React.PointerEvent) => void;
  };
  /** Attach to the element that slides. */
  ref: React.RefObject<HTMLDivElement>;
  open: boolean;
  close: () => void;
  /** True while the finger is down and moving — suppress the row's click. */
  dragging: () => boolean;
}

export function useSwipeRow(trayWidth: number): SwipeRowApi {
  // Cast once, here: React's own `useRef<T>(null)` types as T|null, while the
  // `ref` prop wants RefObject<T>. Every consumer would otherwise repeat this.
  const ref = useRef<HTMLDivElement>(null) as React.RefObject<HTMLDivElement>;
  const [open, setOpen] = useState(false);
  const state = useRef({ armed: false, dragging: false, x0: 0, y0: 0, lastX: 0, lastT: 0, v: 0, base: 0 });

  const settle = useCallback(
    (to: number, velocity: number) => {
      const el = ref.current;
      if (!el) return;
      const from = currentX(el);
      const anim = springTo(el, 'transform', from, to, (v) => `translateX(${v}px)`, {
        ...SPRINGS.settle,
        velocity,
      });
      const done = () => {
        el.style.transform = `translateX(${to}px)`;
      };
      if (anim) anim.addEventListener('finish', done, { once: true });
      else done();
      setOpen(to !== 0);
    },
    [],
  );

  const close = useCallback(() => settle(0, 0), [settle]);

  // A row left open when its list scrolls away would still be open when the
  // component is reused for a different conversation (Virtuoso recycles rows).
  useEffect(() => close, [close]);

  const handlers = {
    onPointerDown: (e: React.PointerEvent) => {
      const s = state.current;
      s.armed = true;
      s.dragging = false;
      s.x0 = e.clientX;
      s.y0 = e.clientY;
      s.lastX = e.clientX;
      s.lastT = e.timeStamp;
      s.v = 0;
      s.base = open ? -trayWidth : 0;
    },
    onPointerMove: (e: React.PointerEvent) => {
      const s = state.current;
      if (!s.armed) return;
      const dx = e.clientX - s.x0;
      const dy = e.clientY - s.y0;
      if (!s.dragging) {
        // Vertical wins: the list scrolls, and a row that grabs the gesture
        // first would make the whole list feel sticky.
        if (Math.abs(dy) > Math.abs(dx)) {
          s.armed = false;
          return;
        }
        if (Math.abs(dx) < SLOP) return;
        s.dragging = true;
      }
      const dt = Math.max(1, e.timeStamp - s.lastT);
      s.v = 0.7 * s.v + 0.3 * ((e.clientX - s.lastX) / dt) * 1000;
      s.lastX = e.clientX;
      s.lastT = e.timeStamp;
      // Rubber band past the tray: it can be pulled further, reluctantly, and
      // never to the right of closed.
      const raw = s.base + dx;
      const x = raw > 0 ? raw * 0.25 : raw < -trayWidth ? -trayWidth + (raw + trayWidth) * 0.3 : raw;
      const el = ref.current;
      if (el) el.style.transform = `translateX(${x}px)`;
    },
    onPointerUp: () => {
      const s = state.current;
      const was = s.dragging;
      s.armed = false;
      s.dragging = false;
      if (!was) return;
      const el = ref.current;
      const x = el ? currentX(el) : 0;
      const shouldOpen = s.v < -FLICK_VELOCITY || (s.v <= FLICK_VELOCITY && x < -trayWidth * OPEN_RATIO);
      settle(shouldOpen ? -trayWidth : 0, s.v);
    },
    onPointerCancel: () => {
      const s = state.current;
      if (s.dragging) settle(open ? -trayWidth : 0, 0);
      s.armed = false;
      s.dragging = false;
    },
  };

  return { handlers, ref, open, close, dragging: () => state.current.dragging };
}

/** Read the live X offset, including one written mid-animation. */
function currentX(el: HTMLElement): number {
  const m = /translateX\((-?[\d.]+)px\)/.exec(el.style.transform);
  if (m) return Number(m[1]);
  const t = getComputedStyle(el).transform;
  if (t && t !== 'none') {
    const parts = t.match(/matrix\(([^)]+)\)/);
    if (parts) return Number(parts[1].split(',')[4] ?? 0);
  }
  return 0;
}
