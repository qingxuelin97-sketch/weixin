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
 * The roll animation stays a call-site concern too: it is driven by React's
 * `key` (a changed count REMOUNTS the badge so the keyframes replay), and the
 * key belongs to the element as the parent writes it.
 */

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
  return (
    <span className={className} aria-label={label}>
      {dot ? '' : badgeText(count, max)}
    </span>
  );
}
