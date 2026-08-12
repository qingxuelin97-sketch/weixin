/**
 * Spring physics, sampled into keyframes (M-H3).
 *
 * Every animation in this app has been a `cubic-bezier`, which is why nothing
 * ever feels like iOS: a bezier is a fixed path in a fixed time, so a sheet
 * dragged fast and a sheet dragged slowly settle identically, and nothing ever
 * overshoots. Springs solve exactly that — they have velocity, so where a
 * gesture left off is where the animation starts.
 *
 * THE CONSTRAINT THAT DECIDES THE IMPLEMENTATION: the golden screenshot gate
 * runs with Playwright's default `animations: 'disabled'`, which fast-forwards
 * CSS animations, CSS transitions and the Web Animations API to their end
 * state — but knows nothing about a `requestAnimationFrame` loop. A JS spring
 * ticking on rAF would leave 22 goldens sampling whatever frame they happened
 * to catch, and the whole gate would start flickering.
 *
 * So the spring is integrated ONCE, up front, into a list of keyframes, and
 * handed to WAAPI. The physics is real, the playback is declarative, and the
 * screenshot gate can still freeze it.
 */

export interface SpringOptions {
  /** Higher = snappier. */
  stiffness?: number;
  /** Higher = less overshoot. */
  damping?: number;
  mass?: number;
  /** Initial velocity in units/second — this is how a gesture hands off. */
  velocity?: number;
  /** Sampling step. 1000/60 is one frame at 60fps. */
  stepMs?: number;
  /** Hard ceiling, so a badly-tuned spring cannot animate forever. */
  maxMs?: number;
}

const DEFAULTS: Required<SpringOptions> = {
  stiffness: 320,
  damping: 30,
  mass: 1,
  velocity: 0,
  stepMs: 1000 / 60,
  maxMs: 1200,
};

/** Named springs, so the app has a small vocabulary rather than magic numbers. */
export const SPRINGS = {
  /** Page transitions: fast, barely overshoots. */
  page: { stiffness: 320, damping: 34 },
  /** Sheets and panels: heavier, a little bounce at the end. */
  sheet: { stiffness: 260, damping: 26 },
  /** Small controls: quick and lively. */
  pop: { stiffness: 420, damping: 22 },
  /** Snapping back after a cancelled gesture: no overshoot at all. */
  settle: { stiffness: 300, damping: 40 },
} as const;

export interface SpringSample {
  /** 0..1 progress along the animation. */
  offset: number;
  /** Value at this offset. */
  value: number;
}

/**
 * Integrate the spring and return samples from `from` to `to`.
 *
 * Semi-implicit Euler at a fixed step: stable for the stiffness range above,
 * and — unlike a closed-form solution — it takes an initial velocity, which is
 * the entire point when a gesture is handing off.
 */
export function springSamples(from: number, to: number, opts: SpringOptions = {}): SpringSample[] {
  const { stiffness, damping, mass, velocity, stepMs, maxMs } = { ...DEFAULTS, ...opts };
  const dt = stepMs / 1000;
  let x = from;
  let v = velocity;
  const values: number[] = [x];
  let elapsed = 0;
  while (elapsed < maxMs) {
    const force = -stiffness * (x - to) - damping * v;
    v += (force / mass) * dt;
    x += v * dt;
    elapsed += stepMs;
    values.push(x);
    // Settled: close enough, and slow enough that nobody could see the rest.
    if (Math.abs(to - x) < 0.001 * Math.max(1, Math.abs(to - from)) && Math.abs(v) < 0.05) break;
  }
  // Land exactly on the target — an animation that stops 0.4px short leaves a
  // visible seam against a static layout.
  values[values.length - 1] = to;
  const last = values.length - 1;
  return values.map((value, i) => ({ offset: last === 0 ? 1 : i / last, value }));
}

/** How long the sampled spring runs, in ms. */
export function springDuration(samples: SpringSample[], stepMs = DEFAULTS.stepMs): number {
  return Math.max(stepMs, (samples.length - 1) * stepMs);
}

/**
 * Run a spring on one CSS property via WAAPI.
 *
 * `format` turns a sampled number into the property value ("translateX(12px)").
 * Returns the Animation so callers can cancel it — a gesture that starts
 * mid-flight must take over, not fight it.
 */
export function springTo(
  el: Element,
  property: 'transform' | 'opacity',
  from: number,
  to: number,
  format: (v: number) => string,
  opts: SpringOptions = {},
): Animation | null {
  // Not every environment has WAAPI (jsdom in unit tests, very old WebViews).
  // A missing animation must never break the interaction it decorates.
  if (typeof el.animate !== 'function') return null;
  const samples = springSamples(from, to, opts);
  const keyframes = samples.map((s) => ({ offset: s.offset, [property]: format(s.value) }));
  return el.animate(keyframes as Keyframe[], {
    duration: springDuration(samples, opts.stepMs ?? DEFAULTS.stepMs),
    easing: 'linear', // the curve is IN the samples; easing here would double it
    fill: 'both',
  });
}

/**
 * Whether motion should be suppressed entirely.
 *
 * Checked at call time rather than cached: the setting can change while the
 * app is open, and a cached "false" would keep animating for someone who just
 * turned it off.
 */
export function reducedMotion(): boolean {
  return (
    typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}
