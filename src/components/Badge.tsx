/**
 * The one badge (M-I0).
 *
 * Unread counts were rendered by four hand-written spans that had each
 * independently invented the same three rules: hide at zero, clamp at 99 with a
 * `+`, and drop the digits entirely when the room is muted (WeChat shows a bare
 * dot). Three rules × four copies is how one of them ends up rendering `100`,
 * or leaving an empty red circle at zero — neither of which is visible until it
 * is on a phone.
 *
 * The SKIN stays with the call site: every badge keeps the exact class string
 * it already had (`tabbar__badge`, `conv-row__badge`, `chat-nav__unread`,
 * `discover__num-badge`, `discover__reddot`), so this is a semantic migration
 * and not a redesign — the goldens must not move a pixel. What moves in here is
 * only the arithmetic and the empty/dot decision.
 *
 * The roll comes from `<RollingNumber/>` (M-I8), which lives INSIDE this
 * component rather than at the call sites. M-I0 originally left it to the
 * parent via a React `key` remount, but that only animated the ARRIVING value
 * — the old one vanished — and every call site had to remember the key trick.
 * One badge, one roll: the digits change the way a counter should everywhere,
 * and no site can forget it.
 */
import { RollingNumber } from './RollingNumber';

export interface BadgeProps {
  /** The exact class string this site already used — skins stay feature-owned. */
  className: string;
  /** Unread/total count. Zero or negative renders nothing at all. */
  count?: number;
  /** Muted rooms and bare "something is new" markers: the box, no digits. */
  dot?: boolean;
  /** Counts above this render as `${max}+`. */
  max?: number;
  /** Screen-reader text — a lone number in a row reads as nothing in particular. */
  label?: string;
}

/** The clamp, exported so a test can pin it without rendering React. */
export function badgeText(count: number, max = 99): string {
  return count > max ? `${max}+` : String(count);
}

export function Badge({ className, count = 0, dot = false, max = 99, label }: BadgeProps) {
  // A dot carries its own meaning and needs no count; a numeric badge with
  // nothing to say must not leave an empty circle behind.
  if (!dot && !(count > 0)) return null;
  // A dot has no digits to roll; a number does.
  return dot ? (
    <span className={className} aria-label={label} />
  ) : (
    <span className={className} aria-label={label}>
      <RollingNumber value={badgeText(count, max)} />
    </span>
  );
}
