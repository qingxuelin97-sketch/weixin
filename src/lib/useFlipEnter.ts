/**
 * React side of the shared-element transition (M-I8).
 *
 * `flip.ts` owns the arithmetic and the WAAPI compile; this is the four lines
 * of lifecycle that connect them to a component: on mount, claim the rect the
 * tap left behind and play the inversion away.
 *
 * Layout-effect, not effect: the destination must be inverted BEFORE the
 * browser paints it in its final place, or the first frame shows the element
 * where it lands and the transition starts with a jump backwards.
 */
import { useLayoutEffect, type RefObject } from 'react';
import { playFlip, takeFlipSource, type FlipOptions } from './flip';

export function useFlipEnter(
  key: string,
  ref: RefObject<HTMLElement | null>,
  opts: FlipOptions = {},
): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Consumed, not peeked: an entrance plays once. If this component remounts
    // (a route re-key, a StrictMode double-invoke) there is nothing left to
    // claim, and it simply appears — which is the correct fallback.
    const from = takeFlipSource(key);
    if (!from) return;
    const anim = playFlip(el, from, opts);
    return () => anim?.cancel();
    // `opts` is a literal at every call site; depending on it would restart the
    // animation on every render, which is the opposite of what it is for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ref]);
}
