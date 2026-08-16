/**
 * First-mount stagger (M-I8 — the consumer `.stagger-in` never had).
 *
 * `motion.css` has carried `.stagger-in` since M-H3 with ZERO call sites: dead
 * CSS that reads as a shipped feature in every review of that file. This is the
 * piece that was missing, and it is missing for a reason — the naive version is
 * wrong in two specific ways:
 *
 *   1. IT MUST NOT REPLAY ON RECYCLE. Both feeds that want it are virtualized
 *      (Virtuoso) or progressively revealed, so row 40 mounts when you scroll
 *      to it. Staggering THAT makes the list flicker while you read it, which
 *      is the opposite of the intent — the effect belongs to arriving at the
 *      list, not to arriving at a row.
 *   2. IT MUST BE BOUNDED. `index * 30ms` over 200 rows is a six-second
 *      entrance. Past a handful of rows nobody perceives the stagger anyway,
 *      they just perceive the wait.
 *
 * So: delays are handed out only for the FIRST paint of a list, only for the
 * first `CAP` rows, and only within a short window after mount. Everything else
 * gets `undefined` and renders plainly.
 */

/** Rows that get a delay. Past this the stagger is imperceptible, only slow. */
export const STAGGER_CAP = 8;
/** Gap between consecutive rows. */
export const STAGGER_STEP_MS = 26;
/**
 * How long after mount delays are still handed out.
 *
 * Anything that mounts later than this is arriving because the user scrolled
 * (or because data landed), not because the list did — and it must not animate.
 */
export const STAGGER_WINDOW_MS = 400;

/** Pure: the delay row `index` should get, or null for "render plainly". */
export function staggerDelay(index: number, elapsedMs: number): number | null {
  if (index < 0 || index >= STAGGER_CAP) return null;
  if (elapsedMs > STAGGER_WINDOW_MS) return null;
  return index * STAGGER_STEP_MS;
}

/**
 * The class + inline custom property a staggered row needs, or undefined.
 *
 * Returning the pair together keeps the two halves from drifting: a class with
 * no delay variable stacks every row on the same frame, and a delay variable
 * with no class does nothing at all.
 */
export interface StaggerProps {
  className: string;
  style: { '--stagger-delay': string };
}

export function staggerProps(index: number, elapsedMs: number): StaggerProps | undefined {
  const delay = staggerDelay(index, elapsedMs);
  if (delay == null) return undefined;
  return { className: 'stagger-in', style: { '--stagger-delay': `${delay}ms` } };
}
