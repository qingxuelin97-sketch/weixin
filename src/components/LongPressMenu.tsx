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
import { useEffect } from 'react';
import { useDismissable } from '../app/useDismissable';
import { pressHaptic } from '../lib/sound';
import { menuIcon } from './menu-icons';
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
  /** `row` = 消息上方的图标网格（M-K2 起）· `column` = 列表行上的竖排菜单。 */
  layout?: 'row' | 'column';
  onClose: () => void;
  /** Accessible name — "消息操作" / "会话操作". */
  label?: string;
}

/** Assumed column height, so a press near the bottom doesn't push it offscreen. */
const COLUMN_HEIGHT = 230;

/**
 * 消息菜单的网格几何 (M-K2)。微信 8.0：一行最多五格，每格 62×60，面板四周 4px。
 *
 * 此前这里是一条横排胶囊，按「约 130px 宽」来夹进屏幕——那是三四个动作的年代。
 * 菜单长到十个动作之后，后六个就整个排到了屏幕右边外面，长按一条消息只剩
 * 「复制 引用 重新生成 让她重说」可点，转发/收藏/删除全都够不着。
 */
export const GRID_COLS = 5;
export const GRID_CELL_W = 62;
export const GRID_CELL_H = 60;
const GRID_PAD = 4;
/** 面板与手指之间留给小三角的距离。 */
const GRID_GAP = 14;
/** 不压到导航栏下面。 */
const GRID_MIN_TOP = 52;
const EDGE = 8;

export interface GridPlacement {
  left: number;
  top: number;
  width: number;
  height: number;
  cols: number;
  /** 小三角相对面板左边的 x。 */
  arrowX: number;
  /** 放不下上方时翻到手指下方，三角随之朝上。 */
  below: boolean;
}

/** 纯函数：n 个动作、手指位置、视口 → 面板放在哪。永远完整落在屏幕里。 */
export function gridMenuPlacement(
  n: number,
  at: { x: number; y: number },
  viewport: { w: number; h: number },
): GridPlacement {
  const cols = Math.max(1, Math.min(n, GRID_COLS));
  const rows = Math.max(1, Math.ceil(n / cols));
  const width = cols * GRID_CELL_W + GRID_PAD * 2;
  const height = rows * GRID_CELL_H + GRID_PAD * 2;
  let top = at.y - height - GRID_GAP;
  let below = false;
  if (top < GRID_MIN_TOP) {
    top = at.y + GRID_GAP;
    below = true;
  }
  top = Math.max(GRID_MIN_TOP, Math.min(top, viewport.h - height - EDGE));
  const left = Math.max(EDGE, Math.min(at.x - width / 2, viewport.w - width - EDGE));
  const arrowX = Math.max(14, Math.min(at.x - left, width - 14));
  return { left, top, width, height, cols, arrowX, below };
}

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
  // 长按触感 (M-K12): the tick that says "held long enough" — WeChat's long
  // press is felt, not only seen. Once per opening, for the same reason.
  useEffect(() => {
    pressHaptic();
  }, []);

  // An empty capsule reads as breakage; callers that can produce zero actions
  // are protected here rather than each guarding separately.
  if (items.length === 0) return null;

  if (layout === 'column') {
    return (
      <div
        className="lp-menu__scrim"
        // pointerdown, not click: the dismiss has to land before the press can
        // turn into a tap on the row underneath.
        onPointerDown={onClose}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="lp-menu lp-menu--column"
          role="menu"
          aria-label={label}
          style={{ top: Math.min(at.y, window.innerHeight - COLUMN_HEIGHT) }}
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

  const place = gridMenuPlacement(items.length, at, {
    w: window.innerWidth,
    h: window.innerHeight,
  });
  return (
    <div className="lp-menu__scrim" onPointerDown={onClose} onClick={(e) => e.stopPropagation()}>
      <div
        className={`lp-menu lp-menu--grid${place.below ? ' lp-menu--below' : ''}`}
        role="menu"
        aria-label={label}
        style={{
          left: place.left,
          top: place.top,
          width: place.width,
          gridTemplateColumns: `repeat(${place.cols}, 1fr)`,
          ['--lp-arrow-x' as string]: `${place.arrowX}px`,
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        {items.map((item) => (
          <button
            key={item.label}
            role="menuitem"
            className="lp-menu__cell"
            onClick={() => {
              item.onSelect();
              onClose();
            }}
          >
            <span className="lp-menu__icon">{menuIcon(item.label)}</span>
            <span className="lp-menu__label">{item.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
