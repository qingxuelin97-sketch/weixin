/**
 * Shared-element transitions, FLIP-style (M-I8).
 *
 * The app already animates PAGES (PageStack slides one tree over another), but
 * every element inside them is born where it lands. Tapping an avatar and
 * having the profile card's 64px avatar appear from nowhere is the difference
 * between "a new screen appeared" and "the thing I tapped grew into the screen"
 * — and the second one is the whole reason iOS transitions read as continuous.
 *
 * FLIP is the technique that makes that cheap:
 *
 *   First   — measure the source element's rect BEFORE navigating.
 *   Last    — measure the destination element's rect AFTER it has laid out.
 *   Invert  — transform the destination so it visually sits on the source.
 *   Play    — animate that transform away.
 *
 * The whole trick is that layout never moves: the destination is already in its
 * final place on the very first frame, and only a `transform` lies about it.
 * Nothing reflows, nothing is measured mid-flight, and the compositor does all
 * the work.
 *
 * THE CONSTRAINT (same one that decides lib/spring.ts): the golden screenshot
 * gate runs Playwright with `animations: 'disabled'`, which fast-forwards CSS
 * animations, transitions and WAAPI to their end state and knows nothing about
 * a `requestAnimationFrame` loop. So the inversion is compiled UP FRONT into
 * keyframes — spring physics sampled once — and handed to WAAPI. The gate can
 * freeze it; a hand-ticked FLIP would make it flicker.
 *
 * Everything above the `--- impure edge ---` line is pure arithmetic over
 * plain rectangles, which is what makes the interesting half unit-testable
 * without a DOM.
 */
import { springSamples, springDuration, SPRINGS, reducedMotion, type SpringOptions } from './spring';

/** The subset of DOMRect that FLIP actually needs. Plain data, so it is testable. */
export interface FlipRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** How far the destination must be moved and shrunk to sit on the source. */
export interface FlipDelta {
  dx: number;
  dy: number;
  sx: number;
  sy: number;
}

export interface FlipOptions {
  /** Spring used to play the inversion away. Defaults to SPRINGS.page. */
  spring?: SpringOptions;
  /**
   * Fade the destination in alongside the move. Off by default: the source
   * element usually stays on screen behind the transition, and cross-fading
   * two copies of the same photo reads as a ghost rather than as one object.
   */
  fade?: boolean;
}

/**
 * How much smaller/offset the source is relative to the destination.
 *
 * Computed against the TOP-LEFT corner, which is why every animation this
 * module produces pins `transform-origin: 0 0`: with a centered origin the
 * scale would also move the element, and the translation would have to
 * compensate for it — two coupled terms instead of one.
 */
export function flipDelta(from: FlipRect, to: FlipRect): FlipDelta {
  return {
    dx: from.x - to.x,
    dy: from.y - to.y,
    // A zero-sized destination (display:none, not laid out yet) would produce
    // Infinity and a transform the browser silently drops — clamp to 1, which
    // degrades the scale half to "no scaling" rather than to garbage.
    sx: to.width > 0 ? from.width / to.width : 1,
    sy: to.height > 0 ? from.height / to.height : 1,
  };
}

/**
 * Is this pair worth animating at all?
 *
 * Two rects that already coincide produce a one-frame no-op that still costs a
 * composited layer, and a source with no area (a collapsed or scrolled-away
 * element) produces a transition that starts from a dot.
 */
export function flipWorthPlaying(from: FlipRect, to: FlipRect): boolean {
  if (from.width <= 0 || from.height <= 0 || to.width <= 0 || to.height <= 0) return false;
  const { dx, dy, sx, sy } = flipDelta(from, to);
  return Math.abs(dx) > 1 || Math.abs(dy) > 1 || Math.abs(sx - 1) > 0.01 || Math.abs(sy - 1) > 0.01;
}

/** The CSS transform that places a `to`-positioned element onto `from`. */
export function flipTransform(d: FlipDelta): string {
  return `translate(${round(d.dx)}px, ${round(d.dy)}px) scale(${round(d.sx)}, ${round(d.sy)})`;
}

/**
 * Compile the inversion into WAAPI keyframes.
 *
 * Progress comes from the spring sampler, so the element decelerates the way
 * every other motion in this app does — and, when the spring overshoots past
 * 1, the destination briefly grows a hair past its final size before settling.
 * That overshoot IS the physicality; a linear FLIP looks like a slide show.
 *
 * Pure: rects in, keyframes out. No DOM, no clock.
 */
export function flipKeyframes(from: FlipRect, to: FlipRect, opts: FlipOptions = {}): Keyframe[] {
  const d = flipDelta(from, to);
  const samples = springSamples(0, 1, { ...SPRINGS.page, ...opts.spring });
  return samples.map((s) => {
    // p is the spring's progress from "sitting on the source" (0) to "in its
    // own place" (1). Interpolating the DELTA rather than the rect keeps the
    // final frame exactly `none`, with no accumulated rounding.
    const p = s.value;
    const frame: Keyframe = {
      offset: s.offset,
      transformOrigin: '0 0',
      transform: flipTransform({
        dx: d.dx * (1 - p),
        dy: d.dy * (1 - p),
        sx: 1 + (d.sx - 1) * (1 - p),
        sy: 1 + (d.sy - 1) * (1 - p),
      }),
    };
    if (opts.fade) frame.opacity = String(clamp01(p));
    return frame;
  });
}

/** Playback duration of the keyframes `flipKeyframes` just produced. */
export function flipDuration(opts: FlipOptions = {}): number {
  return springDuration(springSamples(0, 1, { ...SPRINGS.page, ...opts.spring }));
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/* ------------------------------ impure edge ------------------------------ */

/** Measure an element into the plain shape the pure half consumes. */
export function rectOf(el: Element): FlipRect {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

/**
 * Play the inversion: the element is already in its final place; this makes it
 * *look* like it started at `from`.
 *
 * Returns the Animation so a caller can cancel it — a viewer closed mid-open
 * must take over, not fight the tail of its own entrance.
 */
export function playFlip(
  el: Element,
  from: FlipRect,
  opts: FlipOptions = {},
): Animation | null {
  // jsdom (unit tests) and very old WebViews have no WAAPI. A missing
  // animation must never break the interaction it decorates.
  if (typeof el.animate !== 'function') return null;
  // Reduced motion gets the destination, immediately. The navigation still
  // happens; only the connective tissue is dropped.
  if (reducedMotion()) return null;
  const to = rectOf(el);
  if (!flipWorthPlaying(from, to)) return null;
  const anim = el.animate(flipKeyframes(from, to, opts), {
    duration: flipDuration(opts),
    easing: 'linear', // the curve is IN the samples; easing here would double it
    fill: 'both',
  });
  // Drop the transform-origin/transform the fill would otherwise keep pinned:
  // a leftover `transform-origin: 0 0` changes how any LATER animation on the
  // same element (a like burst, a tab nod) pivots.
  anim.addEventListener(
    'finish',
    () => {
      try {
        anim.cancel();
      } catch {
        /* already detached */
      }
    },
    { once: true },
  );
  return anim;
}

/**
 * Play the inversion in reverse: the element leaves its own place and lands on
 * `to` (the rect it came from). Used when closing a viewer.
 */
export function playFlipOut(el: Element, to: FlipRect, opts: FlipOptions = {}): Animation | null {
  if (typeof el.animate !== 'function') return null;
  if (reducedMotion()) return null;
  const from = rectOf(el);
  if (!flipWorthPlaying(to, from)) return null;
  const frames = flipKeyframes(to, from, opts).slice().reverse();
  // Reversing the array reverses the values but not the offsets — rewrite them
  // so the first frame is offset 0 again (WAAPI requires ascending offsets).
  const last = frames.length - 1;
  const keyframes = frames.map((f, i) => ({ ...f, offset: last === 0 ? 1 : i / last }));
  return el.animate(keyframes, {
    duration: flipDuration(opts),
    easing: 'linear',
    fill: 'forwards',
  });
}

/* ------------------------- the source-rect registry ------------------------- */

/**
 * Where the tap happened, remembered until the destination mounts.
 *
 * A shared-element transition is inherently split across two React trees that
 * never meet: the row that was tapped unmounts, the page that mounts has no
 * idea what was tapped. Passing the rect through navigation state would put
 * layout geometry in the URL history — this is a one-slot handoff instead.
 */
const sources = new Map<string, { rect: FlipRect; at: number }>();

/**
 * How long a remembered rect stays usable.
 *
 * A rect that is never consumed (the tap did not navigate, the destination
 * errored) must not make some LATER, unrelated entrance fly in from a stale
 * position — which is the exact failure mode of a registry without a clock.
 */
const SOURCE_TTL_MS = 1500;

/** `now` is injected so the TTL is testable without faking timers. */
export function rememberFlipSource(key: string, rect: FlipRect, now = clockMs()): void {
  sources.set(key, { rect, at: now });
}

/** Convenience: measure and remember in one call, at the moment of the tap. */
export function captureFlipSource(key: string, el: Element | null | undefined, now = clockMs()): void {
  if (!el) return;
  rememberFlipSource(key, rectOf(el), now);
}

/** Read and consume. Returns null when absent or stale. */
export function takeFlipSource(key: string, now = clockMs()): FlipRect | null {
  const hit = sources.get(key);
  if (!hit) return null;
  sources.delete(key);
  return now - hit.at <= SOURCE_TTL_MS ? hit.rect : null;
}

/** Read WITHOUT consuming — a closing transition needs the rect a second time. */
export function peekFlipSource(key: string, now = clockMs()): FlipRect | null {
  const hit = sources.get(key);
  if (!hit) return null;
  if (now - hit.at > SOURCE_TTL_MS) {
    sources.delete(key);
    return null;
  }
  return hit.rect;
}

export function forgetFlipSource(key: string): void {
  sources.delete(key);
}

/** Test seam: the registry is module state, and tests must be able to reset it. */
export function clearFlipSources(): void {
  sources.clear();
}

/** How many rects are parked. Only the tests care — a leak here is unbounded. */
export function flipSourceCount(): number {
  return sources.size;
}

function clockMs(): number {
  return typeof performance === 'object' && typeof performance.now === 'function'
    ? performance.now()
    : 0;
}

/* ------------------------------ shared keys ------------------------------ */

/**
 * One vocabulary for the handoff keys, so the writer and the reader cannot
 * drift apart — a mistyped key is a silent no-transition, the least debuggable
 * possible failure.
 */
export const FLIP_KEYS = {
  /** Contact row avatar → profile card avatar. */
  contactAvatar: (contactId: string) => `contact-avatar:${contactId}`,
  /** Any thumbnail → the full-screen image viewer. One viewer at a time. */
  imageViewer: 'image-viewer',
} as const;
