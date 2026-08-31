/**
 * The one long-press (M-I0).
 *
 * There were two hand-rolled copies of this gesture — chat-list rows and
 * message bubbles — each with its own `LONG_PRESS_MS = 500`, and only one of
 * them had the `fired` guard that stops the release tap from ALSO running the
 * row's click. Two copies of a gesture is exactly how the thresholds drift
 * apart: the next tweak lands in one file and the app grows two different
 * ideas of what "long" means.
 *
 * The hook owns the timer, the movement cancel, the fired guard, and the
 * context-menu fallback (desktop right-click maps to long-press). The MENU a
 * long press opens stays feature-owned — the lists need different menus — but
 * every consumer gets the same physics.
 */
import { useRef } from 'react';

export const LONG_PRESS_MS = 500;
/** A finger that moved this far is scrolling, not pressing. */
const MOVE_CANCEL_PX = 10;

export interface LongPressHandlers {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
  onPointerLeave: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

export interface LongPressApi {
  handlers: LongPressHandlers;
  /**
   * True when the press already fired — the click that follows the release
   * must be swallowed by the caller (`if (!longPress.fired()) open()`).
   */
  fired: () => boolean;
  /** Reset the fired flag after the caller has consumed it. */
  consume: () => void;
}

export function useLongPress(onFire: (x: number, y: number) => void): LongPressApi {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const firedRef = useRef(false);
  const origin = useRef({ x: 0, y: 0 });

  const cancel = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };

  return {
    handlers: {
      onPointerDown: (e) => {
        firedRef.current = false;
        origin.current = { x: e.clientX, y: e.clientY };
        const { clientX, clientY } = e;
        cancel();
        timer.current = setTimeout(() => {
          firedRef.current = true;
          onFire(clientX, clientY);
        }, LONG_PRESS_MS);
      },
      onPointerMove: (e) => {
        // The chat-list copy cancelled on ANY movement, which made the press
        // almost impossible to land on a real touchscreen — fingers tremble.
        // A slop radius is what both copies actually wanted.
        const dx = e.clientX - origin.current.x;
        const dy = e.clientY - origin.current.y;
        if (dx * dx + dy * dy > MOVE_CANCEL_PX * MOVE_CANCEL_PX) cancel();
      },
      onPointerUp: cancel,
      onPointerLeave: cancel,
      onContextMenu: (e) => {
        e.preventDefault();
        firedRef.current = true;
        onFire(e.clientX, e.clientY);
      },
    },
    fired: () => firedRef.current,
    consume: () => {
      firedRef.current = false;
    },
  };
}
