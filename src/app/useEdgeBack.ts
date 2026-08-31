/**
 * Edge-swipe back (M-H3).
 *
 * The one gesture that separates "an app" from "a website in a WebView". Every
 * iOS user reaches for it without thinking, and this app has never had it —
 * the only way back was the small arrow in the corner.
 *
 * Three properties make it feel right, and all three are missing from the naive
 * version ("swipe detected → navigate"):
 *
 *   1. IT TRACKS THE FINGER. The page moves exactly as far as the thumb has
 *      moved, in real time. A gesture that waits for release and then animates
 *      is a swipe detector, not a drag.
 *   2. RELEASE IS DECIDED BY VELOCITY AS WELL AS DISTANCE. A quick flick from
 *      the edge goes back even though it barely moved; a slow drag to 40% does
 *      not. Distance alone makes fast users feel ignored.
 *   3. IT CAN BE CANCELLED. Drag back toward the edge and the page returns,
 *      because a gesture you cannot change your mind about is a trap.
 *
 * NO rAF LOOP. During the drag the transform is written straight from the
 * pointer event — the browser already throttles those to the frame rate, and
 * an rAF loop here would be the one thing that breaks the golden screenshot
 * gate (see lib/spring.ts). The release animation is a spring sampled into
 * WAAPI keyframes, which the gate can freeze.
 */
import { useEffect, type RefObject } from 'react';
import { springTo, SPRINGS, reducedMotion } from '../lib/spring';

/** Only a touch starting this close to the left edge begins a back-swipe. */
const EDGE_PX = 28;
/** Below this the gesture is a tap or a vertical scroll, not a drag. */
const START_SLOP = 8;
/** Past this fraction of the screen, releasing goes back. */
const COMMIT_RATIO = 0.4;
/** …or this fast, in px per second, however far it got. */
const COMMIT_VELOCITY = 550;

export interface EdgeBackOptions {
  /** Called when the gesture completes. Usually `() => navigate(-1)`. */
  onBack: () => void;
  /** Whether a back navigation is possible right now. */
  enabled?: boolean;
}

/**
 * Attach the gesture to the page-stack element.
 *
 * Deliberately NOT a component: the element it drives is the same one
 * `PageStack` renders, and wrapping that in another layer would add a
 * containing block that every absolutely-positioned page inside would notice.
 */
export function useEdgeBack(
  ref: RefObject<HTMLElement | null>,
  { onBack, enabled = true }: EdgeBackOptions,
): void {
  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;

    let dragging = false;
    let armed = false;
    let startX = 0;
    let startY = 0;
    let lastX = 0;
    let lastT = 0;
    let velocity = 0;
    let pointerId = -1;

    const page = () => el.querySelector<HTMLElement>('[data-page-current]');

    const setOffset = (dx: number) => {
      const p = page();
      if (!p) return;
      // The page follows the thumb 1:1; the scrim fades out as it goes, which
      // is what makes the layer underneath read as "coming back".
      p.style.transform = `translateX(${dx}px)`;
      p.style.willChange = 'transform';
    };

    const clear = () => {
      const p = page();
      if (!p) return;
      p.style.transform = '';
      p.style.willChange = '';
    };

    const finish = (dx: number) => {
      const width = el.clientWidth || 1;
      const commit = dx > width * COMMIT_RATIO || velocity > COMMIT_VELOCITY;
      const p = page();
      el.classList.remove('page-stack--dragging');
      if (!p) return;

      if (commit) {
        // Let the page continue off-screen at the speed it was already moving,
        // then hand over to the router — the pop transition takes it from here.
        const anim = springTo(p, 'transform', dx, width, (v) => `translateX(${v}px)`, {
          ...SPRINGS.page,
          velocity,
        });
        const done = () => {
          clear();
          onBack();
        };
        if (anim) anim.addEventListener('finish', done, { once: true });
        else done();
        return;
      }
      // Cancelled: spring back to zero with no overshoot. Overshoot on a
      // cancel reads as the app disagreeing with you.
      const anim = springTo(p, 'transform', dx, 0, (v) => `translateX(${v}px)`, {
        ...SPRINGS.settle,
        velocity,
      });
      if (anim) anim.addEventListener('finish', clear, { once: true });
      else clear();
    };

    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.clientX > EDGE_PX) return;
      armed = true;
      dragging = false;
      startX = e.clientX;
      startY = e.clientY;
      lastX = e.clientX;
      lastT = e.timeStamp;
      velocity = 0;
      pointerId = e.pointerId;
    };

    const onMove = (e: PointerEvent) => {
      if (!armed || e.pointerId !== pointerId) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!dragging) {
        // Vertical first means the user is scrolling, not going back. Deciding
        // this once, at the start, is what keeps a scroll from stuttering.
        if (Math.abs(dy) > Math.abs(dx)) {
          armed = false;
          return;
        }
        if (dx < START_SLOP) return;
        dragging = true;
        el.classList.add('page-stack--dragging');
      }
      const dt = Math.max(1, e.timeStamp - lastT);
      // Smoothed, because a single frame's delta is noisy enough to flip the
      // release decision on its own.
      velocity = 0.7 * velocity + 0.3 * ((e.clientX - lastX) / dt) * 1000;
      lastX = e.clientX;
      lastT = e.timeStamp;
      setOffset(Math.max(0, dx));
      e.preventDefault();
    };

    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      const wasDragging = dragging;
      armed = false;
      dragging = false;
      if (!wasDragging) return;
      finish(Math.max(0, e.clientX - startX));
    };

    const onCancel = () => {
      if (!dragging) {
        armed = false;
        return;
      }
      armed = false;
      dragging = false;
      finish(0);
    };

    // Reduced motion still gets the gesture — it is navigation, not decoration.
    // What it loses is the spring, which `springTo` handles by being cheap;
    // the guard here only skips the live tracking on a pointer type that
    // cannot express it.
    void reducedMotion;

    el.addEventListener('pointerdown', onDown, { passive: true });
    el.addEventListener('pointermove', onMove, { passive: false });
    el.addEventListener('pointerup', onUp, { passive: true });
    el.addEventListener('pointercancel', onCancel, { passive: true });
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onCancel);
      el.classList.remove('page-stack--dragging');
    };
  }, [ref, onBack, enabled]);
}
