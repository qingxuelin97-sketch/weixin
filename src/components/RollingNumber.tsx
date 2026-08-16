/**
 * A number that ROLLS to its new value (M-I8).
 *
 * `.badge-roll` (M-H3) already made a changed unread count arrive with a small
 * drop — but only the NEW value moved, so what you saw was "3" blinking into
 * "4". The thing WeChat actually does, and the thing that makes a counter read
 * as a counter, is that the old value leaves in the direction the new one
 * arrives from: old slides up and out, new slides down and in, both at once,
 * inside a box that never changes size.
 *
 * Implementation notes that are not obvious:
 *
 *  - The outgoing value is a real element, kept until its animation ends. There
 *    is no timer: `onAnimationEnd` is the only thing that removes it, so a
 *    slow device simply takes longer rather than dropping a frame of state.
 *  - Its end state is `opacity: 0`, which is what makes this safe for the
 *    golden gate. Playwright fast-forwards CSS animations to their end state
 *    and never fires `animationend`, so the outgoing element can survive the
 *    capture — invisible, and therefore pixel-identical to the same badge with
 *    no roll in flight.
 *  - The first render never rolls. A badge animating on mount would replay on
 *    every list recycle and every route entrance.
 */
import { useRef, useState } from 'react';
import './rolling-number.css';

interface Props {
  /** The value to display. Already formatted (「99+」 is a string, not 100). */
  value: string;
  /** Extra classes for the host — the badge skins live with their features. */
  className?: string;
}

export function RollingNumber({ value, className }: Props) {
  const [shown, setShown] = useState(value);
  // The value on its way out, plus a bump so two changes in quick succession
  // are two distinct elements rather than one element that restarts.
  const [leaving, setLeaving] = useState<{ value: string; seq: number } | null>(null);
  const seq = useRef(0);

  if (value !== shown) {
    // Render-phase state update on a prop change: the documented React pattern
    // for derived state, and the only way the outgoing element exists in the
    // SAME commit as the incoming one. An effect would paint the new value
    // first and animate it in on the following frame — a visible stutter.
    seq.current += 1;
    setLeaving({ value: shown, seq: seq.current });
    setShown(value);
  }

  return (
    <span className={`num-roll${className ? ` ${className}` : ''}`}>
      {leaving && (
        <span
          key={`out-${leaving.seq}`}
          className="num-roll__digit num-roll__digit--out"
          aria-hidden
          onAnimationEnd={() => setLeaving((cur) => (cur?.seq === leaving.seq ? null : cur))}
        >
          {leaving.value}
        </span>
      )}
      <span
        key={`in-${shown}`}
        className={`num-roll__digit${leaving ? ' num-roll__digit--in' : ''}`}
      >
        {shown}
      </span>
    </span>
  );
}
