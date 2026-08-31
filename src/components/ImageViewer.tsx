/**
 * Full-screen image viewer (M-I8 rewrite).
 *
 * The V1 version could close, page and toggle a 2× zoom — which covers the
 * gestures you *describe* when asked what an image viewer does, and none of the
 * ones a thumb actually performs. What was missing is the entire reason a photo
 * viewer feels like a photo rather than a picture of one:
 *
 *   PINCH. Two fingers scale around the point BETWEEN them, so the part of the
 *   photo you pinched stays under your fingers. Scaling around the center (the
 *   easy version) slides the photo out from under the gesture, and the result
 *   feels like operating a control rather than holding a thing.
 *
 *   PAN. Zoomed in, one finger drags — bounded to the photo's own edges so it
 *   cannot be lost off-screen, with rubber-band resistance past them.
 *
 *   RUBBER BAND + SNAP. Pinching below 1× resists and springs back; pinching
 *   past the cap resists and springs back. The limits are felt, not enforced.
 *
 *   OPENING FROM WHERE IT WAS TAPPED. The thumbnail's rect is handed over
 *   through `lib/flip.ts`, so the photo grows out of the grid cell and shrinks
 *   back into it on close — the single largest contributor to "this is a
 *   native viewer" and the thing a fade cannot fake.
 *
 * GESTURE FILE: during a live pinch/pan the transform is written straight from
 * the pointer event (no rAF — see lib/spring.ts for why that distinction keeps
 * the golden gate honest). Every release-time settle is a spring compiled into
 * WAAPI keyframes.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { resolveImageRef } from '../data/moments-images';
import { useDismissable } from '../app/useDismissable';
import { springSamples, springDuration, SPRINGS, reducedMotion } from '../lib/spring';
import { FLIP_KEYS, playFlip, playFlipOut, takeFlipSource, type FlipRect } from '../lib/flip';
import './image-viewer.css';

interface ImageViewerProps {
  refs: string[];
  index: number;
  onClose: () => void;
}

/** Hard zoom limits. Past these the gesture rubber-bands and springs back. */
const MIN_SCALE = 1;
const MAX_SCALE = 4;
/** Double tap lands here — WeChat's step, not a continuous zoom. */
const DOUBLE_TAP_SCALE = 2;
/** Two taps closer together than this are a double tap. */
const DOUBLE_TAP_MS = 300;
/** At 1×, a downward drag this far closes the viewer. */
const CLOSE_DISTANCE = 90;
/** …or this fast, however far it got (px/s). */
const CLOSE_VELOCITY = 700;
/** Horizontal travel that pages to the next photo (only at 1×). */
const PAGE_DISTANCE = 60;

interface Transform {
  scale: number;
  x: number;
  y: number;
}

const IDENTITY: Transform = { scale: 1, x: 0, y: 0 };

export function ImageViewer({ refs, index, onClose }: ImageViewerProps) {
  const [i, setI] = useState(() => Math.min(Math.max(index, 0), Math.max(0, refs.length - 1)));
  const [loaded, setLoaded] = useState(false);
  // Mounted = open (callers render it conditionally), so back closes the viewer.
  useDismissable(true, onClose);

  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  /** The live transform. A ref, not state: it is written per pointer event. */
  const tf = useRef<Transform>({ ...IDENTITY });
  /** Where the thumbnail was, so the close can fly back into it. */
  const origin = useRef<FlipRect | null>(null);
  const closing = useRef(false);

  const { url, background } = resolveImageRef(refs[i] ?? '');

  /** Push the ref'd transform onto the element. The only writer of `style`. */
  const paint = useCallback(() => {
    const el = stageRef.current;
    if (!el) return;
    const { scale, x, y } = tf.current;
    el.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
  }, []);

  /**
   * Spring the transform to `to`.
   *
   * Every component of the transform is sampled from the SAME spring, so scale
   * and translation stay in step — animating them separately (two springs, two
   * durations) makes a zoomed photo visibly slide before it finishes scaling.
   */
  const settle = useCallback(
    (to: Transform, done?: () => void) => {
      const el = stageRef.current;
      const from = { ...tf.current };
      tf.current = { ...to };
      if (!el || typeof el.animate !== 'function' || reducedMotion()) {
        paint();
        done?.();
        return;
      }
      // `pop` rather than `settle`: this is a zoom landing, and the overdamped
      // spring takes 800ms to creep the last percent — long enough that a
      // double-tap reads as lag. The small overshoot is right here anyway; a
      // photo snapping back from a rubber-banded pinch should bounce.
      const samples = springSamples(0, 1, SPRINGS.pop);
      const frames = samples.map((s) => {
        const p = s.value;
        const scale = from.scale + (to.scale - from.scale) * p;
        const x = from.x + (to.x - from.x) * p;
        const y = from.y + (to.y - from.y) * p;
        return { offset: s.offset, transform: `translate(${x}px, ${y}px) scale(${scale})` };
      });
      const anim = el.animate(frames, {
        duration: springDuration(samples),
        easing: 'linear', // the curve is in the samples
        fill: 'both',
      });
      const finish = () => {
        paint();
        try {
          anim.cancel();
        } catch {
          /* already detached */
        }
        done?.();
      };
      anim.addEventListener('finish', finish, { once: true });
    },
    [paint],
  );

  /**
   * Close, flying the photo back into the thumbnail it came from.
   *
   * Guarded: a back press landing during the close animation must not fire a
   * second one — `onClose` unmounts us, and a double unmount is a React
   * warning at best and a dropped route pop at worst.
   */
  const closeWithFlip = useCallback(() => {
    if (closing.current) return;
    closing.current = true;
    const el = stageRef.current;
    const to = origin.current;
    // No remembered thumbnail (opened by deep link, source scrolled away) or
    // zoomed in: a flight back to a rect the photo no longer relates to reads
    // as a glitch, so just leave.
    if (!el || !to || tf.current.scale > 1.05) {
      onClose();
      return;
    }
    const anim = playFlipOut(el, to, { fade: true });
    if (!anim) {
      onClose();
      return;
    }
    anim.addEventListener('finish', onClose, { once: true });
  }, [onClose]);

  // Opening: claim the rect the tap left behind and grow out of it. Layout
  // effect would be ideal, but the <img> has no size until it decodes, so the
  // flip is armed here and replayed on load (below) if the photo was not ready.
  useEffect(() => {
    origin.current = takeFlipSource(FLIP_KEYS.imageViewer);
    const el = stageRef.current;
    if (el && origin.current) playFlip(el, origin.current, { fade: true });
    // Mount only: a paged-to photo is not a new entrance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Reset zoom when the photo changes — a new photo starts fitted. */
  useEffect(() => {
    tf.current = { ...IDENTITY };
    setLoaded(false);
    paint();
  }, [i, paint]);

  /* ------------------------------ gestures ------------------------------ */

  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef({
    /** Transform when the current gesture started. */
    base: { ...IDENTITY } as Transform,
    /** Distance between the two fingers at pinch start. */
    pinchDist: 0,
    /** Midpoint between the two fingers at pinch start, in stage coordinates. */
    pinchMid: { x: 0, y: 0 },
    startX: 0,
    startY: 0,
    lastY: 0,
    lastT: 0,
    velocityY: 0,
    moved: false,
    lastTap: 0,
  });

  /** Bound the pan so the photo can never be dragged entirely off-screen. */
  const clampPan = (t: Transform): Transform => {
    const el = imgRef.current;
    if (!el) return t;
    const rect = el.getBoundingClientRect();
    // rect is already scaled by the live transform; derive the unscaled box.
    const liveScale = tf.current.scale || 1;
    const w = (rect.width / liveScale) * t.scale;
    const h = (rect.height / liveScale) * t.scale;
    const maxX = Math.max(0, (w - window.innerWidth) / 2);
    const maxY = Math.max(0, (h - window.innerHeight) / 2);
    return {
      scale: t.scale,
      x: Math.min(maxX, Math.max(-maxX, t.x)),
      y: Math.min(maxY, Math.max(-maxY, t.y)),
    };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (closing.current) return;
    const g = gesture.current;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* capture is a nicety */
    }
    g.base = { ...tf.current };
    g.moved = false;
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      g.pinchDist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      // Midpoint relative to the viewport CENTER, because the stage is centered
      // and its transform origin is its own middle. Getting this wrong is what
      // makes a pinch drift away from the fingers.
      g.pinchMid = {
        x: (a.x + b.x) / 2 - window.innerWidth / 2,
        y: (a.y + b.y) / 2 - window.innerHeight / 2,
      };
    } else {
      g.startX = e.clientX;
      g.startY = e.clientY;
      g.lastY = e.clientY;
      g.lastT = e.timeStamp;
      g.velocityY = 0;
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (closing.current) return;
    const g = gesture.current;
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const raw = g.base.scale * (dist / g.pinchDist);
      // Rubber band outside the limits: the cap is felt as resistance rather
      // than as a wall, which is the difference between "it stops" and "it is
      // broken".
      const scale =
        raw < MIN_SCALE
          ? MIN_SCALE - (MIN_SCALE - raw) * 0.4
          : raw > MAX_SCALE
            ? MAX_SCALE + (raw - MAX_SCALE) * 0.15
            : raw;
      // Keep the pinched point under the fingers: the vector from the stage
      // center to that point scales with the photo, so the translation has to
      // absorb the difference.
      const k = scale / g.base.scale;
      const mid = {
        x: (a.x + b.x) / 2 - window.innerWidth / 2,
        y: (a.y + b.y) / 2 - window.innerHeight / 2,
      };
      tf.current = {
        scale,
        x: mid.x - (g.pinchMid.x - g.base.x) * k,
        y: mid.y - (g.pinchMid.y - g.base.y) * k,
      };
      g.moved = true;
      paint();
      e.preventDefault();
      return;
    }

    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (!g.moved && Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
    g.moved = true;
    const dt = Math.max(1, e.timeStamp - g.lastT);
    g.velocityY = 0.7 * g.velocityY + 0.3 * ((e.clientY - g.lastY) / dt) * 1000;
    g.lastY = e.clientY;
    g.lastT = e.timeStamp;

    if (g.base.scale > 1.01) {
      // Zoomed: one finger pans, bounded to the photo's edges.
      tf.current = clampPan({ scale: g.base.scale, x: g.base.x + dx, y: g.base.y + dy });
    } else {
      // Fitted: a downward drag previews the close — the photo follows the
      // thumb and shrinks slightly, so letting go reads as "drop it back".
      const drop = Math.max(0, dy);
      tf.current = {
        scale: Math.max(0.75, 1 - drop / 900),
        x: dx * 0.4,
        y: dy,
      };
    }
    paint();
    e.preventDefault();
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    const wasPinching = pointers.current.size >= 2;
    pointers.current.delete(e.pointerId);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* never captured */
    }
    if (closing.current) return;

    if (wasPinching) {
      // The other finger is still down; it becomes a pan from here.
      if (pointers.current.size === 1) {
        const [only] = [...pointers.current.values()];
        g.base = { ...tf.current };
        g.startX = only.x;
        g.startY = only.y;
        g.moved = true;
        return;
      }
      // Both up: snap back inside the limits.
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, tf.current.scale));
      settle(scale === MIN_SCALE ? { ...IDENTITY } : clampPan({ ...tf.current, scale }));
      return;
    }

    if (!g.moved) {
      onTap();
      return;
    }

    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;

    if (g.base.scale > 1.01) {
      settle(clampPan(tf.current));
      return;
    }

    // Fitted, so the release decides between close, page and snap-back.
    if ((dy > CLOSE_DISTANCE || g.velocityY > CLOSE_VELOCITY) && Math.abs(dy) > Math.abs(dx)) {
      closeWithFlip();
      return;
    }
    if (Math.abs(dx) > PAGE_DISTANCE && Math.abs(dx) > Math.abs(dy) && refs.length > 1) {
      const next = Math.min(Math.max(i + (dx < 0 ? 1 : -1), 0), refs.length - 1);
      tf.current = { ...IDENTITY };
      paint();
      setI(next);
      return;
    }
    settle({ ...IDENTITY });
  };

  const onPointerCancel = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (closing.current) return;
    if (pointers.current.size === 0) settle(clampPan(tf.current));
  };

  /**
   * Single tap closes, double tap zooms.
   *
   * The delay is unavoidable — you cannot know a tap was single until the
   * double-tap window has passed — but it is bounded and it is what every
   * photo viewer does.
   */
  const onTap = () => {
    const g = gesture.current;
    const t = performance.now();
    if (t - g.lastTap < DOUBLE_TAP_MS) {
      g.lastTap = 0;
      settle(
        tf.current.scale > 1.01
          ? { ...IDENTITY }
          : clampPan({ scale: DOUBLE_TAP_SCALE, x: 0, y: 0 }),
      );
      return;
    }
    g.lastTap = t;
    setTimeout(() => {
      if (g.lastTap && performance.now() - g.lastTap >= DOUBLE_TAP_MS) {
        g.lastTap = 0;
        if (tf.current.scale > 1.01) settle({ ...IDENTITY });
        else closeWithFlip();
      }
    }, DOUBLE_TAP_MS + 20);
  };

  return (
    <div
      className="image-viewer"
      role="dialog"
      aria-label="查看图片"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
    >
      <div className="image-viewer__stage" ref={stageRef}>
        {url ? (
          <>
            {/* Skeleton under the photo, not instead of it: swapping elements
                on load would restart layout and undo an in-flight open flip. */}
            {!loaded && <div className="image-viewer__skeleton skeleton" aria-hidden />}
            <img
              ref={imgRef}
              className="image-viewer__img"
              src={url}
              alt=""
              draggable={false}
              onLoad={() => setLoaded(true)}
              // A broken ref must not leave a permanent shimmer.
              onError={() => setLoaded(true)}
            />
          </>
        ) : (
          <div className="image-viewer__ph" style={{ background }} />
        )}
      </div>
      {refs.length > 1 && (
        <div className="image-viewer__count">
          {i + 1}/{refs.length}
        </div>
      )}
    </div>
  );
}
