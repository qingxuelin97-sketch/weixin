/**
 * Drag a bottom sheet closed (M-I8 — the stub M-I0 left behind).
 *
 * `Sheet` shipped with a scrim tap and a hardware-back registration, which are
 * the two ways a sheet closes when you are *thinking about it*. The way anyone
 * actually closes one is to push it back down with a thumb, and a sheet that
 * ignores that reads as a web page pretending to be a sheet.
 *
 * Three properties, same three that make `useEdgeBack` feel right:
 *
 *   1. IT TRACKS THE FINGER, 1:1 downward, with a rubber band upward — a sheet
 *      you can drag UP past its own top is a sheet that is lying about its
 *      limits, so resistance there is 25%.
 *   2. RELEASE IS DECIDED BY VELOCITY AS WELL AS DISTANCE. A short flick down
 *      closes; a slow drag a third of the way does not.
 *   3. IT LOSES TO SCROLLING. A sheet whose body is scrolled down must scroll,
 *      not drag — the gesture only arms when the body is already at its top,
 *      which is what every native sheet does and what nobody notices until it
 *      is missing.
 *
 * NO rAF LOOP: the drag writes `transform` straight from the pointer event, and
 * the release is a spring sampled into WAAPI keyframes. See lib/spring.ts for
 * why that distinction is what keeps the golden screenshot gate trustworthy.
 */
import { useCallback, useRef, type RefObject } from 'react';
import { springTo, SPRINGS, reducedMotion } from '../lib/spring';

/** Below this a vertical move is a tap, not a drag. */
const SLOP = 8;
/** Past this fraction of the sheet's own height, releasing closes it. */
const CLOSE_RATIO = 0.35;
/** …or this fast downward, in px/s, however far it got. */
const CLOSE_VELOCITY = 620;
/** Resistance applied to an upward pull — the sheet has nowhere to go up. */
const RUBBER = 0.25;

export interface SheetDragApi {
  /** Spread onto the sheet element (or its grabber). */
  handlers: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
    onPointerCancel: (e: React.PointerEvent) => void;
  };
  /** True while the finger is down AND moving — suppress clicks underneath. */
  dragging: () => boolean;
}

export interface SheetDragOptions {
  /** The element that moves. */
  ref: RefObject<HTMLElement | null>;
  /** Called once the close animation has played out. */
  onClose: () => void;
  /**
   * The scrolling body inside the sheet. The drag only arms while this is at
   * its top; without it a sheet with a scrollable list is undraggable-or-
   * unscrollable, and which one you get is a coin flip per gesture.
   */
  scrollRef?: RefObject<HTMLElement | null>;
  /** Turn the gesture off entirely (a sheet mid-close, a disabled state). */
  enabled?: boolean;
}

export function useSheetDrag({
  ref,
  onClose,
  scrollRef,
  enabled = true,
}: SheetDragOptions): SheetDragApi {
  const state = useRef({
    armed: false,
    dragging: false,
    y0: 0,
    x0: 0,
    lastY: 0,
    lastT: 0,
    v: 0,
    closing: false,
  });

  /** Animate to `to` px below rest and then run `done`. */
  const settle = useCallback(
    (from: number, to: number, velocity: number, done?: () => void) => {
      const el = ref.current;
      if (!el) {
        done?.();
        return;
      }
      // Reduced motion: land immediately. The sheet still closes — only the
      // travel is dropped.
      if (reducedMotion()) {
        el.style.transform = to === 0 ? '' : `translateY(${to}px)`;
        done?.();
        return;
      }
      const anim = springTo(
        el,
        'transform',
        from,
        to,
        (v) => `translateY(${v}px)`,
        // Closing keeps the flick's speed; springing back must NOT overshoot,
        // because a sheet that bounces after you decided to keep it open reads
        // as the app disagreeing with you.
        { ...(to === 0 ? SPRINGS.settle : SPRINGS.page), velocity },
      );
      const finish = () => {
        // Inline style first, then drop the animation. `springTo` fills
        // forwards, and a filled WAAPI animation keeps a computed `transform`
        // on the sheet forever — which makes it a containing block for every
        // `position: fixed` descendant it ever holds.
        if (to === 0) el.style.transform = '';
        else el.style.transform = `translateY(${to}px)`;
        try {
          anim?.cancel();
        } catch {
          /* already detached */
        }
        done?.();
      };
      if (anim) anim.addEventListener('finish', finish, { once: true });
      else finish();
    },
    [ref],
  );

  const currentY = () => {
    const el = ref.current;
    if (!el) return 0;
    const m = /translateY\((-?[\d.]+)px\)/.exec(el.style.transform);
    return m ? Number(m[1]) : 0;
  };

  const handlers = {
    onPointerDown: (e: React.PointerEvent) => {
      const s = state.current;
      if (!enabled || s.closing) return;
      // A sheet body scrolled away from its top owns the gesture.
      const scroller = scrollRef?.current;
      if (scroller && scroller.scrollTop > 0) return;
      s.armed = true;
      s.dragging = false;
      s.y0 = e.clientY;
      s.x0 = e.clientX;
      s.lastY = e.clientY;
      s.lastT = e.timeStamp;
      s.v = 0;
    },
    onPointerMove: (e: React.PointerEvent) => {
      const s = state.current;
      if (!s.armed) return;
      const dy = e.clientY - s.y0;
      const dx = e.clientX - s.x0;
      if (!s.dragging) {
        // Horizontal first means this was never a sheet drag (a swipe inside
        // the content, a carousel). Deciding once, at the start, is what keeps
        // the gesture from stuttering halfway through.
        if (Math.abs(dx) > Math.abs(dy)) {
          s.armed = false;
          return;
        }
        if (Math.abs(dy) < SLOP) return;
        s.dragging = true;
        // Capture so a fast drag that leaves the sheet's box still reports —
        // without it the sheet freezes wherever the finger crossed the edge.
        try {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        } catch {
          /* capture is a nicety, not a requirement */
        }
      }
      const dt = Math.max(1, e.timeStamp - s.lastT);
      // Smoothed: one frame's delta is noisy enough to flip the release
      // decision on its own.
      s.v = 0.7 * s.v + 0.3 * ((e.clientY - s.lastY) / dt) * 1000;
      s.lastY = e.clientY;
      s.lastT = e.timeStamp;
      const el = ref.current;
      if (el) el.style.transform = `translateY(${dy > 0 ? dy : dy * RUBBER}px)`;
    },
    onPointerUp: (e: React.PointerEvent) => {
      const s = state.current;
      const was = s.dragging;
      s.armed = false;
      s.dragging = false;
      if (!was) return;
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* never captured */
      }
      const el = ref.current;
      const y = currentY();
      const height = el?.getBoundingClientRect().height ?? 1;
      const shouldClose = s.v > CLOSE_VELOCITY || y > height * CLOSE_RATIO;
      if (shouldClose) {
        s.closing = true;
        // Off the bottom at the speed it was already moving, THEN unmount —
        // calling onClose first would rip the element out mid-animation.
        settle(y, height, s.v, onClose);
      } else {
        settle(y, 0, s.v);
      }
    },
    onPointerCancel: () => {
      const s = state.current;
      if (s.dragging) settle(currentY(), 0, 0);
      s.armed = false;
      s.dragging = false;
    },
  };

  return { handlers, dragging: () => state.current.dragging };
}
