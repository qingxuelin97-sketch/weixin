/**
 * Draw media that may not be materialized yet (M-G1).
 *
 * Object URLs are created on demand and evicted under memory pressure, so a
 * ref can resolve to a placeholder on first paint and to the real image a
 * moment later. This hook does both halves: it asks for the blobs a screen
 * needs, and it re-renders when any of them (or an eviction elsewhere) changes
 * what `resolveImageRef` would return.
 */
import { useEffect, useState } from 'react';
import { subscribeMedia } from '../data/media-registry';
import { idbRefIds, primeMedia } from '../lib/media-prime';

/**
 * Ensure `refs` are drawable, and re-render this component when they become so.
 *
 * Pass the refs actually on screen. Priming the entire library here would
 * reintroduce exactly the memory problem the lazy registry exists to avoid.
 */
export function useMedia(refs: ReadonlyArray<string | undefined>): void {
  const [, bump] = useState(0);

  useEffect(() => subscribeMedia(() => bump((n) => n + 1)), []);

  // Keyed on the ref list itself: a new message with a photo, or scrolling a
  // grid, changes this string and re-primes. Joining is cheap next to an IDB
  // read, and it keeps the effect from firing on every unrelated render.
  const key = refs.filter(Boolean).join('|');
  useEffect(() => {
    void primeMedia(idbRefIds(refs));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
