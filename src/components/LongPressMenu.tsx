/**
 * The one long-press MENU (M-I0, completed in I18).
 *
 * `useLongPress` unified the gesture — the timer, the slop radius, the fired
 * guard — but the thing the gesture opens stayed two hand-written copies: the
 * chat-list's light `conv-menu` card and the chat page's dark `msg-menu`
 * capsule, each with its own scrim story (one had a scrim, one had a document
 * capture listener), its own dismiss registration, and its own idea of what a
 * menu looks like. Two menus is how "tap outside" ends up meaning two different
 * things in one app.
 *
 * The chat bubble's capsule is the reference skin — it is the one that matches
 * the device, and WeChat's conversation-row menu is the same dark popup with
 * white text. So the list menu adopts it; only the AXIS differs (a capsule over
 * a bubble reads across, a row menu reads down).
 *
 * Behaviour is now identical in both places and owned here:
 *   - a transparent scrim eats the dismissing tap, so closing the menu never
 *     also opens whatever was underneath it;
 *   - the dismiss stack gets exactly one registration, so hardware back closes
 *     the menu before it leaves the page;
 *   - choosing an item runs it and closes — no call site has to remember to.
 */
import { useDismissable } from '../app/useDismissable';
import './long-press-menu.css';

export interface LongPressMenuItem {
  /** Visible label; also the React key — these menus are all short text. */
  label: string;
  onSelect: () => void;
}

export interface LongPressMenuProps {
  items: LongPressMenuItem[];
  /** Where the finger was, in viewport coordinates. */
  at: { x: number; y: number };
  /** `row` = capsule over a bubble · `column` = list over a list row. */
  layout?: 'row' | 'column';
  onClose: () => void;
  /** Accessible name — "消息操作" / "会话操作". */
  label?: string;
}

/** Assumed capsule width when clamping it back inside the screen. */
const ROW_WIDTH = 130;
/** The capsule sits above the finger so the bubble stays readable. */
const ROW_LIFT = 48;
/** …but never under the nav bar. */
const ROW_MIN_TOP = 52;
/** Assumed column height, so a press near the bottom doesn't push it offscreen. */
const COLUMN_HEIGHT = 230;

export function LongPressMenu({
  items,
  at,
  layout = 'row',
  onClose,
  label,
}: LongPressMenuProps) {
  // Registered unconditionally: the component only exists while the menu is
  // open, so "mounted" IS "open".
  useDismissable(true, onClose);

  // An empty capsule reads as breakage; callers that can produce zero actions
  // are protected here rather than each guarding separately.
  if (items.length === 0) return null;

  const style =
    layout === 'row'
      ? {
          left: Math.min(at.x, window.innerWidth - ROW_WIDTH),
          top: Math.max(at.y - ROW_LIFT, ROW_MIN_TOP),
        }
      : { top: Math.min(at.y, window.innerHeight - COLUMN_HEIGHT) };

  return (
    <div
      className="lp-menu__scrim"
      // pointerdown, not click: the dismiss has to land before the press can
      // turn into a tap on the row underneath.
      onPointerDown={onClose}
      onClick={(e) => e.stopPropagation()}
    >
      <div
        className={`lp-menu lp-menu--${layout}`}
        role="menu"
        aria-label={label}
        style={style}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        {items.map((item) => (
          <button
            key={item.label}
            role="menuitem"
            onClick={() => {
              item.onSelect();
              onClose();
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}
