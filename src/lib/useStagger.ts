/**
 * React side of the first-mount stagger (M-I8).
 *
 * Two things live here that the pure half cannot own:
 *
 *  1. THE MOUNT CLOCK, in a ref rather than in state — the whole point is that
 *     the window closing must NOT cause a re-render.
 *  2. A PER-INDEX MEMO. A list re-renders for reasons that have nothing to do
 *     with arriving (a store update, a Virtuoso measurement pass), and asking
 *     the clock again on each of those would hand row 3 a fresh `.stagger-in`
 *     class and restart its fade halfway through. Each index is answered once
 *     and then answered the same way forever.
 */
import { useRef, type CSSProperties } from 'react';
import { staggerProps } from './stagger';

export interface StaggerRowProps {
  className?: string;
  style?: CSSProperties;
}

/**
 * Returns a function a list calls per row: `stagger(index)` gives the
 * className/style pair for a row arriving WITH the list, and `undefined` for
 * one arriving later (recycled by Virtuoso, revealed by scrolling, appended by
 * an agent while you watch).
 */
export function useStagger(): (index: number) => StaggerRowProps | undefined {
  const mounted = useRef<number | null>(null);
  const answers = useRef(new Map<number, StaggerRowProps | undefined>());
  if (mounted.current == null) mounted.current = now();
  return (index: number) => {
    const memo = answers.current;
    if (memo.has(index)) return memo.get(index);
    const props = staggerProps(index, now() - (mounted.current ?? 0)) as
      | StaggerRowProps
      | undefined;
    memo.set(index, props);
    return props;
  };
}

/**
 * `performance.now()` rather than `Date.now()`: this is a duration, and a
 * wall-clock jump (NTP, a timezone change) would otherwise close the window
 * early — or never.
 */
function now(): number {
  return typeof performance === 'object' && typeof performance.now === 'function'
    ? performance.now()
    : 0;
}
