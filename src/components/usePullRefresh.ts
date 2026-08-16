/**
 * Pull to refresh (M-I8).
 *
 * WeChat's two feeds — 会话列表 and 朋友圈 — both refresh by pulling down from
 * the top. This app's feeds refreshed only when something else happened to
 * reload them, so "did anything arrive while I was reading?" had no answer a
 * user could ask.
 *
 * The pull itself is the whole feature. A spinner that appears after a
 * threshold is a button with extra steps; what makes this gesture feel like a
 * physical thing is:
 *
 *   1. THE RUBBER BAND. Travel is sub-linear (`rubberBand` below), so the list
 *      resists more the further you pull. Pull 300px and it moves 90 — which is
 *      how you can tell, without looking, that you have reached the end.
 *   2. THE COMMIT POINT IS VISIBLE. Past the threshold the indicator flips from
 *      "keep pulling" to "let go", so the decision is made before the release,
 *      not discovered after it.
 *   3. RELEASE HOLDS. Let go past the threshold and the list stays parked at
 *      exactly the indicator's height while the work runs — a list that snaps
 *      back and THEN shows a spinner has thrown away the connection between
 *      the gesture and the result.
 *
 * NO rAF LOOP: the pull writes `transform` straight from the pointer event; the
 * park and the snap-back are springs sampled into WAAPI. See lib/spring.ts.
 */
import { useCallback, useRef, useState, type RefObject } from 'react';
import { springTo, SPRINGS, reducedMotion } from '../lib/spring';

/** Pull further than this and releasing refreshes. Also the parked height. */
export const PULL_THRESHOLD = 64;
/** Hard stop on travel, however hard it is pulled. */
export const PULL_MAX = 120;
/** Below this a vertical move is a tap or the start of a normal scroll. */
const SLOP = 6;

/**
 * Sub-linear travel: the first pixels are nearly 1:1, and it asymptotes toward
 * `max`. Pure, so the curve can be unit-tested rather than eyeballed.
 */
export function rubberBand(distance: number, max = PULL_MAX): number {
  if (distance <= 0) return 0;
  // d/(1 + d/max) — smooth, monotonic, never reaches max, and derivative 1 at
  // zero (so the very start of the pull tracks the finger exactly).
  return (distance * max) / (distance + max);
}

/** What the indicator should say right now. */
export type PullPhase = 'idle' | 'pulling' | 'ready' | 'refreshing';

export interface PullRefreshApi {
  handlers: {
    onPointerDown: (e: React.PointerEvent) => void;
    onPointerMove: (e: React.PointerEvent) => void;
    onPointerUp: (e: React.PointerEvent) => void;
    onPointerCancel: (e: React.PointerEvent) => void;
  };
  /** Current phase — drives the indicator's copy and arrow direction. */
  phase: PullPhase;
  /** 0..1 progress toward the commit point; the indicator draws its arc from it. */
  progress: number;
}

export interface PullRefreshOptions {
  /** The element that slides down under the finger. */
  ref: RefObject<HTMLElement | null>;
  /** The work. Resolving (or rejecting) ends the refresh. */
  onRefresh: () => Promise<unknown> | unknown;
  /**
   * The scroll container. The gesture only arms while it is at its top — a
   * feed pulled down mid-scroll must scroll, not refresh.
   *
   * A function, not a ref, because Virtuoso hands its scroller over through a
   * callback prop rather than owning a ref we can read at mount time.
   */
  scroller: () => HTMLElement | null | undefined;
  enabled?: boolean;
}

export function usePullRefresh({
  ref,
  onRefresh,
  scroller,
  enabled = true,
}: PullRefreshOptions): PullRefreshApi {
  const [phase, setPhase] = useState<PullPhase>('idle');
  const [progress, setProgress] = useState(0);
  const state = useRef({ armed: false, dragging: false, y0: 0, x0: 0, y: 0, busy: false });

  const move = useCallback(
    (y: number) => {
      const el = ref.current;
      if (el) el.style.transform = y === 0 ? '' : `translateY(${y}px)`;
    },
    [ref],
  );

  /** Spring the list from wherever it is back to `to`, then run `done`. */
  const settle = useCallback(
    (from: number, to: number, done?: () => void) => {
      const el = ref.current;
      if (!el || reducedMotion()) {
        move(to);
        done?.();
        return;
      }
      const anim = springTo(el, 'transform', from, to, (v) => `translateY(${v}px)`, SPRINGS.settle);
      const finish = () => {
        // Commit the value as an inline style FIRST, then drop the animation:
        // `springTo` fills forwards, and a filled WAAPI animation keeps a
        // computed `transform` on the element forever — which silently turns it
        // into a containing block for every `position: fixed` descendant. A
        // pull that had settled back to zero would leave the feed's image
        // viewer rendering inside a card instead of over the screen.
        move(to);
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
    [move, ref],
  );

  const handlers = {
    onPointerDown: (e: React.PointerEvent) => {
      const s = state.current;
      if (!enabled || s.busy) return;
      const sc = scroller();
      // Anything but the very top belongs to the scroll.
      if (sc && sc.scrollTop > 0) return;
      s.armed = true;
      s.dragging = false;
      s.y0 = e.clientY;
      s.x0 = e.clientX;
      s.y = 0;
    },
    onPointerMove: (e: React.PointerEvent) => {
      const s = state.current;
      if (!s.armed) return;
      const dy = e.clientY - s.y0;
      const dx = e.clientX - s.x0;
      if (!s.dragging) {
        // Up, or sideways, is not a pull. Bail once rather than re-deciding
        // every frame, or a diagonal drag flickers between the two.
        if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) {
          if (dy < -SLOP || Math.abs(dx) > SLOP) s.armed = false;
          return;
        }
        if (dy < SLOP) return;
        s.dragging = true;
        setPhase('pulling');
      }
      const y = rubberBand(dy);
      s.y = y;
      move(y);
      setProgress(Math.min(1, y / PULL_THRESHOLD));
      setPhase(y >= PULL_THRESHOLD ? 'ready' : 'pulling');
    },
    onPointerUp: () => {
      const s = state.current;
      const was = s.dragging;
      s.armed = false;
      s.dragging = false;
      if (!was) return;
      const y = s.y;
      if (y < PULL_THRESHOLD) {
        setPhase('idle');
        setProgress(0);
        settle(y, 0);
        return;
      }
      // Park at the indicator's height and run the work. The list stays put
      // until it finishes, which is what ties the result to the gesture.
      s.busy = true;
      setPhase('refreshing');
      setProgress(1);
      settle(y, PULL_THRESHOLD, () => {
        void Promise.resolve()
          .then(onRefresh)
          .catch(() => {
            // A failed refresh must still release the list. Reporting is the
            // caller's job (they own the toast); ours is to never strand it.
          })
          .finally(() => {
            s.busy = false;
            setPhase('idle');
            setProgress(0);
            settle(PULL_THRESHOLD, 0);
          });
      });
    },
    onPointerCancel: () => {
      const s = state.current;
      if (s.dragging && !s.busy) {
        setPhase('idle');
        setProgress(0);
        settle(s.y, 0);
      }
      s.armed = false;
      s.dragging = false;
    },
  };

  return { handlers, phase, progress };
}
