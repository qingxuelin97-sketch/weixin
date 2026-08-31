/**
 * Bidirectional page transitions (M-H3).
 *
 * Until now `Push` only animated ENTRANCES: it re-keyed on `location.key` so
 * the arriving page slid in from the right, while the departing page simply
 * unmounted on the same frame. The comment above it even claimed
 * "right-in / left-out" — there was never a left-out, because there was
 * nothing left to animate. Going back was an instant cut, which is the single
 * biggest reason the app reads as a web page rather than as WeChat.
 *
 * TWO STABLE SLOTS, PING-PONGED. This is the part that is easy to get wrong,
 * and the wrong version is worse than no animation at all: rendering the
 * outgoing page as a NEW element beside the current one does not keep the old
 * page alive — React mounts a second copy of it and unmounts the original. The
 * copy re-runs every mount effect and, when it goes, every cleanup. In this app
 * that cleanup parks the composer's unsent text as a draft, so the fresh copy
 * (which never saw the text) overwrote the real draft with nothing: type a
 * message, go back, and it was gone. Alternating between two slots whose keys
 * never change means the tree that was mounted STAYS mounted, in place, until
 * its animation ends.
 *
 * Direction comes from the router's own navigation type, so `navigate(-1)`,
 * the hardware back button and the edge-swipe gesture all produce the same
 * reverse transition without any of them knowing about each other.
 *
 * SCREENSHOT DISCIPLINE: everything here is a CSS animation. Playwright's
 * golden capture disables CSS animations and lands them on their end state, so
 * a transition in flight cannot destabilise a golden — which a
 * requestAnimationFrame implementation absolutely would (see lib/spring.ts).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useNavigationType, type Location } from 'react-router-dom';
import { useEdgeBack } from './useEdgeBack';

/** Must match --dur-page in tokens.css; the outgoing tree unmounts after this. */
const TRANSITION_MS = 300;

/** Tab roots switch instantly, exactly like WeChat's bottom bar. */
const TAB_PATHS = new Set(['/chats', '/contacts', '/discover', '/me', '/']);

function isTab(path: string): boolean {
  return TAB_PATHS.has(path);
}

/**
 * Identity of a location, for "did we move?".
 *
 * NOT `location.key` alone. A navigation the browser drives — a manual hash
 * edit, a deep link opened into a live document, Playwright's `page.goto` to a
 * different `#/...` — arrives with no history state, so React Router hands it
 * the key `'default'`, the same key the FIRST location had. Comparing keys
 * therefore reported "no change" and the stack kept rendering the old route at
 * the new URL: a deep link into a running app silently showed the page you
 * were already on.
 */
function idOf(l: Location): string {
  return `${l.pathname}${l.search}#${l.key}`;
}

interface StackState {
  /** The two slots. One holds the live page; the other may be animating out. */
  slots: [Location | null, Location | null];
  active: 0 | 1;
  dir: 'push' | 'pop';
  /** True while both slots are on screen. */
  busy: boolean;
}

export interface PageStackProps {
  /** A render function so both slots resolve the SAME routes at two locations. */
  children: (location: Location) => ReactNode;
}

export function PageStack({ children }: PageStackProps) {
  const location = useLocation();
  const navType = useNavigationType();
  const navigate = useNavigate();
  const rootRef = useRef<HTMLDivElement>(null);
  const [st, setSt] = useState<StackState>({
    slots: [location, null],
    active: 0,
    dir: 'push',
    busy: false,
  });

  // Adjusted DURING render, not in an effect.
  //
  // An effect runs after paint, which means one frame would render the OLD
  // route at the new URL. That is invisible for a tap — and fatal for a
  // redirect: `<Navigate replace>` inside the stale tree fires on that frame
  // and rewrites the URL, so a deep link bounced straight to the tab root.
  // Deriving state from props during render is the documented React pattern
  // for exactly this, and it costs one extra render, not a frame.
  const currentLoc = st.slots[st.active];
  if (!currentLoc || idOf(location) !== idOf(currentLoc)) {
    const instant = currentLoc ? isTab(location.pathname) && isTab(currentLoc.pathname) : true;
    const next: 0 | 1 = st.active === 0 ? 1 : 0;
    const slots: [Location | null, Location | null] = [null, null];
    slots[next] = location;
    // Tab↔tab is a cut, so the outgoing tree is dropped immediately — two full
    // tab pages on screen at once is both wrong and expensive.
    slots[st.active] = instant ? null : currentLoc;
    setSt({
      slots,
      active: next,
      dir: navType === 'POP' ? 'pop' : 'push',
      busy: !instant && Boolean(currentLoc),
    });
  }

  useEffect(() => {
    if (!st.busy) return;
    const t = setTimeout(() => {
      setSt((prev) => {
        if (!prev.busy) return prev;
        const slots: [Location | null, Location | null] = [null, null];
        slots[prev.active] = prev.slots[prev.active];
        return { ...prev, slots, busy: false };
      });
    }, TRANSITION_MS);
    return () => clearTimeout(t);
  }, [st.busy, st.active]);

  // The gesture is off on the tab roots: there is nothing behind them, and a
  // swipe that "goes back" from 微信 to whatever the browser saw before this
  // app is the worst possible outcome of a friendly gesture.
  const back = useCallback(() => navigate(-1), [navigate]);
  useEdgeBack(rootRef, { onBack: back, enabled: !isTab(location.pathname) });

  return (
    <div ref={rootRef} className={`page-stack${st.busy ? ' page-stack--busy' : ''}`}>
      {([0, 1] as const).map((i) => {
        const loc = st.slots[i];
        if (!loc) return null;
        const isCurrent = i === st.active;
        const phase = st.busy ? `page-stack__page--${st.dir}-${isCurrent ? 'in' : 'out'}` : '';
        return (
          // Stable key per SLOT, never per location: this is what keeps the
          // already-mounted tree mounted instead of cloning it.
          <div
            key={`slot-${i}`}
            className={`page-stack__page ${phase}`.trim()}
            aria-hidden={!isCurrent || undefined}
            {...(isCurrent ? { 'data-page-current': '' } : {})}
          >
            {children(loc)}
          </div>
        );
      })}
    </div>
  );
}
