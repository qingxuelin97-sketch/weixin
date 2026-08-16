import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  flipDelta,
  flipWorthPlaying,
  flipTransform,
  flipKeyframes,
  flipDuration,
  rememberFlipSource,
  takeFlipSource,
  peekFlipSource,
  forgetFlipSource,
  clearFlipSources,
  flipSourceCount,
  FLIP_KEYS,
  type FlipRect,
} from '../../src/lib/flip';
import { rubberBand, PULL_THRESHOLD, PULL_MAX } from '../../src/components/usePullRefresh';
import {
  staggerDelay,
  staggerProps,
  STAGGER_CAP,
  STAGGER_STEP_MS,
  STAGGER_WINDOW_MS,
} from '../../src/lib/stagger';

/**
 * Animation slack (M-I8).
 *
 * This milestone is the one that adds motion everywhere at once — shared
 * elements, sheet drags, pull-to-refresh, pinch zoom, a red-packet sequence —
 * and motion is the single subsystem in this repo where "written correctly"
 * and "does not destabilize 39 goldens" are different questions. These tests
 * hold the answers to the second one, plus the pure arithmetic that the
 * interactive halves are built on.
 */

const root = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(resolve(root, dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...walk(p));
    else if (/\.(tsx?|css)$/.test(e.name)) out.push(p);
  }
  return out;
}

/* ======================= the rule the gate depends on ======================= */

describe('no animation module drives itself with rAF', () => {
  /**
   * Playwright's `animations: 'disabled'` fast-forwards CSS animations, CSS
   * transitions and WAAPI to their end state. It knows NOTHING about a
   * requestAnimationFrame loop, so a hand-ticked animation would leave every
   * golden sampling whichever frame it happened to catch — the gate would
   * flicker and stop being trusted, which is worse than not having it.
   */
  const MOTION_MODULES = [
    'src/lib/spring.ts',
    'src/lib/flip.ts',
    'src/lib/useFlipEnter.ts',
    'src/lib/stagger.ts',
    'src/lib/useStagger.ts',
    'src/app/PageStack.tsx',
    'src/components/RollingNumber.tsx',
    'src/components/PullRefresh.tsx',
  ];

  /**
   * Gesture files are on the SAME rule, not exempt from it.
   *
   * They are listed separately only because the exemption motion.md grants them
   * is narrower than it sounds: a gesture may write `transform` straight from a
   * pointer event (the browser already throttles those to the frame rate), but
   * it still may not run a loop of its own. A screenshot is never taken with a
   * finger down; it is absolutely taken while a release animation settles.
   */
  const GESTURE_MODULES = [
    'src/app/useEdgeBack.ts',
    'src/components/useSwipeRow.ts',
    'src/components/useSheetDrag.ts',
    'src/components/usePullRefresh.ts',
    'src/components/ImageViewer.tsx',
  ];

  for (const f of [...MOTION_MODULES, ...GESTURE_MODULES]) {
    it(`${f} has no requestAnimationFrame call`, () => {
      expect(read(f)).not.toMatch(/requestAnimationFrame\s*\(/);
    });
  }

  it('every release-time settle goes through the spring compiler', () => {
    // A gesture that ends in a `setInterval`/`transition` instead of WAAPI is
    // the same failure by another route: the gate can freeze WAAPI, and the
    // physics stays consistent with the rest of the app.
    for (const f of ['src/components/useSheetDrag.ts', 'src/components/usePullRefresh.ts']) {
      expect(read(f), `${f} must settle via lib/spring`).toMatch(/from '\.\.\/lib\/spring'/);
    }
    expect(read('src/components/ImageViewer.tsx')).toMatch(/springSamples/);
  });
});

/* ============================ dead CSS is alive ============================ */

describe('the dead CSS from M-H3 now has consumers', () => {
  /**
   * `.stagger-in` and `.skeleton` shipped in motion.css in M-H3 and were never
   * referenced by anything for five milestones — CSS that reads as a delivered
   * feature every time someone opens that file. "写了没接线 = 没做".
   */
  const consumers = (needle: string) =>
    walk('src')
      .filter((f) => /\.tsx?$/.test(f))
      .filter((f) => read(f).includes(needle));

  it('.stagger-in is applied by real list code', () => {
    // The class name is produced in ONE place (lib/stagger.ts) so the class and
    // its --stagger-delay variable cannot drift apart.
    expect(read('src/lib/stagger.ts')).toContain("'stagger-in'");
    // …and that place has callers: all three lists you can land on.
    const users = consumers('useStagger');
    expect(users).toContain('src/features/chat-list/ChatListPage.tsx');
    expect(users).toContain('src/features/moments/MomentsPage.tsx');
    expect(users).toContain('src/features/contacts/ContactsPage.tsx');
  });

  it('.skeleton covers images that are actually still loading', () => {
    const users = consumers('skeleton');
    expect(users).toContain('src/features/moments/MomentCard.tsx');
    expect(users).toContain('src/features/chat/MessageBubble.tsx');
    expect(users).toContain('src/components/ImageViewer.tsx');
  });

  it('a shimmer never covers a placeholder that will never load', () => {
    // `ph:` refs have no URL and never will — their gradient IS the content.
    // Shimmering over them would turn the whole seeded feed grey, and the
    // moments golden with it.
    for (const f of ['src/features/moments/MomentCard.tsx', 'src/features/chat/MessageBubble.tsx']) {
      expect(read(f), `${f} shimmers unconditionally`).toMatch(/url && !loaded|if \(!url\)/);
    }
  });

  it('.badge-roll was deleted rather than left behind', () => {
    // Superseded by <RollingNumber/>. A rule with no consumers is exactly the
    // problem this milestone is here to fix — it must not be recreated.
    const css = read('src/styles/motion.css');
    expect(css).not.toMatch(/^\.badge-roll\s*\{/m);
    expect(walk('src').filter((f) => /className.*badge-roll/.test(read(f)))).toEqual([]);
  });
});

/* ============================== FLIP, pure half ============================== */

describe('FLIP measurement', () => {
  const thumb: FlipRect = { x: 20, y: 400, width: 78, height: 78 };
  const full: FlipRect = { x: 0, y: 100, width: 390, height: 390 };

  it('inverts the destination onto the source', () => {
    const d = flipDelta(thumb, full);
    expect(d.dx).toBe(20);
    expect(d.dy).toBe(300);
    expect(d.sx).toBeCloseTo(0.2, 5);
    expect(d.sy).toBeCloseTo(0.2, 5);
  });

  it('survives a destination that has not laid out yet', () => {
    // A zero-width target would divide to Infinity, and a transform containing
    // Infinity is silently dropped by the browser — an invisible failure.
    const d = flipDelta(thumb, { x: 0, y: 0, width: 0, height: 0 });
    expect(Number.isFinite(d.sx)).toBe(true);
    expect(d.sx).toBe(1);
    expect(d.sy).toBe(1);
  });

  it('refuses transitions that are not worth a composited layer', () => {
    expect(flipWorthPlaying(thumb, full)).toBe(true);
    // Identical rects: a one-frame no-op that still costs a layer.
    expect(flipWorthPlaying(full, full)).toBe(false);
    // A source with no area — scrolled away, display:none — would start the
    // photo from a dot.
    expect(flipWorthPlaying({ x: 5, y: 5, width: 0, height: 10 }, full)).toBe(false);
  });

  it('writes a transform with a top-left origin in mind', () => {
    expect(flipTransform({ dx: 12, dy: -4, sx: 0.5, sy: 0.25 })).toBe(
      'translate(12px, -4px) scale(0.5, 0.25)',
    );
  });
});

describe('FLIP keyframes', () => {
  const thumb: FlipRect = { x: 20, y: 400, width: 78, height: 78 };
  const full: FlipRect = { x: 0, y: 100, width: 390, height: 390 };

  it('starts sitting exactly on the source', () => {
    const frames = flipKeyframes(thumb, full);
    expect(frames[0].offset).toBe(0);
    expect(frames[0].transform).toBe('translate(20px, 300px) scale(0.2, 0.2)');
  });

  it('ends exactly in place — no residual sub-pixel transform', () => {
    // An animation that stops 0.4px short leaves a visible seam against the
    // static layout it is supposed to be landing in.
    const frames = flipKeyframes(thumb, full);
    expect(frames[frames.length - 1].transform).toBe('translate(0px, 0px) scale(1, 1)');
    expect(frames[frames.length - 1].offset).toBe(1);
  });

  it('pins the transform origin on every frame', () => {
    // The whole arithmetic is top-left relative; a centered origin would make
    // the scale move the element too, and the translate would have to fight it.
    for (const f of flipKeyframes(thumb, full)) expect(f.transformOrigin).toBe('0 0');
  });

  it('produces offsets WAAPI will accept', () => {
    const frames = flipKeyframes(thumb, full);
    for (let i = 1; i < frames.length; i++) {
      expect(Number(frames[i].offset)).toBeGreaterThan(Number(frames[i - 1].offset));
      expect(Number(frames[i].offset)).toBeLessThanOrEqual(1);
    }
  });

  it('fades only when asked', () => {
    expect(flipKeyframes(thumb, full)[0].opacity).toBeUndefined();
    // The source usually stays on screen behind the transition, and
    // cross-fading two copies of one photo reads as a ghost.
    expect(flipKeyframes(thumb, full, { fade: true })[0].opacity).toBe('0');
  });

  it('is deterministic — the same rects twice are the same animation', () => {
    // Goldens depend on this: an animation that samples differently between
    // runs is a flaky test waiting to happen.
    expect(flipKeyframes(thumb, full)).toEqual(flipKeyframes(thumb, full));
    expect(flipDuration()).toBe(flipDuration());
  });

  it('runs for a bounded, sane time', () => {
    expect(flipDuration()).toBeGreaterThan(100);
    expect(flipDuration()).toBeLessThan(1200);
  });
});

describe('the FLIP source registry', () => {
  const rect: FlipRect = { x: 1, y: 2, width: 3, height: 4 };
  beforeEach(() => clearFlipSources());

  it('hands the rect to whoever mounts next', () => {
    rememberFlipSource('k', rect, 1000);
    expect(takeFlipSource('k', 1100)).toEqual(rect);
  });

  it('consumes: an entrance plays once', () => {
    rememberFlipSource('k', rect, 1000);
    takeFlipSource('k', 1000);
    expect(takeFlipSource('k', 1000)).toBeNull();
  });

  it('peeks without consuming, because closing needs the rect again', () => {
    rememberFlipSource('k', rect, 1000);
    expect(peekFlipSource('k', 1000)).toEqual(rect);
    expect(peekFlipSource('k', 1000)).toEqual(rect);
  });

  it('expires, so a stale tap cannot hijack a later entrance', () => {
    // The tap that did not navigate is the dangerous case: without a TTL the
    // NEXT profile card opened, minutes later, flies in from a row that is no
    // longer on screen.
    rememberFlipSource('k', rect, 1000);
    expect(takeFlipSource('k', 1000 + 5000)).toBeNull();
    rememberFlipSource('k', rect, 1000);
    expect(peekFlipSource('k', 1000 + 5000)).toBeNull();
  });

  it('does not leak: an expired peek drops the row too', () => {
    rememberFlipSource('k', rect, 0);
    peekFlipSource('k', 99_999);
    expect(flipSourceCount()).toBe(0);
  });

  it('can be abandoned explicitly', () => {
    rememberFlipSource('k', rect, 0);
    forgetFlipSource('k');
    expect(flipSourceCount()).toBe(0);
  });

  it('keys are built in one place so writer and reader cannot drift', () => {
    expect(FLIP_KEYS.contactAvatar('c_1')).toBe('contact-avatar:c_1');
    expect(FLIP_KEYS.contactAvatar('c_1')).not.toBe(FLIP_KEYS.contactAvatar('c_2'));
    expect(typeof FLIP_KEYS.imageViewer).toBe('string');
  });
});

/* ============================== pull to refresh ============================== */

describe('the rubber band', () => {
  it('tracks the finger at the very start', () => {
    // Derivative 1 at zero: the first pixels move 1:1, or the gesture feels
    // like it did not catch.
    expect(rubberBand(1)).toBeCloseTo(1, 1);
  });

  it('resists more the further it is pulled', () => {
    const a = rubberBand(60) - rubberBand(50);
    const b = rubberBand(260) - rubberBand(250);
    expect(a).toBeGreaterThan(b);
  });

  it('is monotonic — pulling further never moves less', () => {
    let prev = -1;
    for (let d = 0; d < 600; d += 7) {
      const y = rubberBand(d);
      expect(y).toBeGreaterThanOrEqual(prev);
      prev = y;
    }
  });

  it('never reaches the cap, however hard it is pulled', () => {
    expect(rubberBand(100_000)).toBeLessThan(PULL_MAX);
    expect(rubberBand(0)).toBe(0);
    expect(rubberBand(-40)).toBe(0);
  });

  it('the commit point is reachable', () => {
    // A threshold above what the band can ever produce is a refresh nobody can
    // trigger — and it fails silently, which is the worst kind.
    expect(PULL_THRESHOLD).toBeLessThan(PULL_MAX);
    expect(rubberBand(400)).toBeGreaterThan(PULL_THRESHOLD);
  });
});

/* ================================= stagger ================================= */

describe('the first-mount stagger', () => {
  it('spaces the first rows and then stops', () => {
    expect(staggerDelay(0, 0)).toBe(0);
    expect(staggerDelay(3, 0)).toBe(3 * STAGGER_STEP_MS);
    // Past the cap the stagger is imperceptible and only slow: 200 rows at
    // 26ms each is a five-second entrance.
    expect(staggerDelay(STAGGER_CAP, 0)).toBeNull();
    expect(staggerDelay(80, 0)).toBeNull();
  });

  it('refuses rows that arrive after the list did', () => {
    // Row 40 mounting because you scrolled to it must NOT fade in — the effect
    // belongs to arriving at the list, not to arriving at a row.
    expect(staggerDelay(2, STAGGER_WINDOW_MS + 1)).toBeNull();
  });

  it('never hands out a class without its delay, or a delay without its class', () => {
    const props = staggerProps(2, 0);
    expect(props?.className).toBe('stagger-in');
    expect(props?.style['--stagger-delay']).toBe(`${2 * STAGGER_STEP_MS}ms`);
    expect(staggerProps(2, STAGGER_WINDOW_MS + 1)).toBeUndefined();
  });

  it('ignores nonsense indices rather than producing a negative delay', () => {
    expect(staggerDelay(-1, 0)).toBeNull();
  });
});

/* ============================== wiring & policy ============================== */

describe('everything written is actually wired', () => {
  it('the FLIP module has three real call sites', () => {
    // 写了没接线 = 没做. Each of these is a place a user can SEE the transition.
    expect(read('src/features/contacts/ContactsPage.tsx')).toContain('captureFlipSource');
    expect(read('src/features/contacts/ContactProfilePage.tsx')).toContain('useFlipEnter');
    expect(read('src/features/chat/ChatPage.tsx')).toContain('captureFlipSource');
    expect(read('src/features/moments/MomentCard.tsx')).toContain('captureFlipSource');
    // …and the viewer is the other half of two of them.
    expect(read('src/components/ImageViewer.tsx')).toContain('takeFlipSource');
    expect(read('src/components/ImageViewer.tsx')).toContain('playFlipOut');
  });

  it('the sheet drag stub from M-I0 is filled in', () => {
    const sheet = read('src/components/Sheet.tsx');
    expect(sheet).toContain('useSheetDrag');
    // Back / scrim / drag must all end at the same close — one return semantic
    // (specs/motion.md rule 4).
    expect(sheet).toContain('useDismissable');
  });

  it('BOTH bottom sheets drag, not just the controlled one', () => {
    // `showActionSheet` is the app's most-used bottom surface (every 更多 menu,
    // every long-press action list). Giving <Sheet/> a thumb-friendly dismissal
    // and leaving this one tap-only is the worse of the two inconsistencies.
    expect(read('src/components/dialog.tsx')).toContain('useSheetDrag');
  });

  it('a drag that ends over the scrim is not a scrim tap', () => {
    // Otherwise the release that decided "keep it open" is immediately undone
    // by the click that follows it.
    for (const f of ['src/components/Sheet.tsx', 'src/components/dialog.tsx']) {
      expect(read(f), `${f} treats a finished drag as a scrim tap`).toContain('drag.dragging()');
    }
  });

  it('both draggable sheets opt out of the browser’s own scroll', () => {
    // Without `touch-action: none` Android claims the vertical drag before a
    // single pointermove is delivered, and the gesture simply never starts.
    const css = read('src/components/overlay.css');
    expect(css).toMatch(/\.sheet\s*\{[^}]*touch-action:\s*none/);
    expect(css).toMatch(/\.asheet\s*\{[^}]*touch-action:\s*none/);
  });

  it('pull-to-refresh reuses the store loaders rather than inventing a path', () => {
    // A second way to load the feed is a second way for it to disagree with
    // itself. The moments force-reload and the conversation re-read already
    // exist; the gesture only calls them.
    expect(read('src/features/moments/MomentsPage.tsx')).toMatch(/loadMoments\(true\)/);
    expect(read('src/features/chat-list/ChatListPage.tsx')).toContain('refreshConversations');
    expect(read('src/store/appStore.ts')).toContain('refreshConversations:');
  });

  it('the clip and the host are different elements', () => {
    // Putting `overflow: hidden` on the element that translates carries the
    // clip along with it, and the indicator never appears at all — the single
    // commonest way to build a pull-to-refresh that silently does nothing.
    const css = read('src/components/pull-refresh.css');
    expect(css).toMatch(/\.pull-clip\s*\{[^}]*overflow:\s*hidden/);
    expect(css).not.toMatch(/\.pull-host\s*\{[^}]*overflow:\s*hidden/);
    for (const f of [
      'src/features/chat-list/ChatListPage.tsx',
      'src/features/moments/MomentsPage.tsx',
    ]) {
      expect(read(f)).toContain('pull-clip');
      expect(read(f)).toContain('pull-host');
    }
  });

  it('the red packet plays all three beats', () => {
    const page = read('src/features/money/RedPacketOpenPage.tsx');
    const css = read('src/features/money/money.css');
    expect(page).toContain('rp-open--opening'); // envelope lift
    expect(page).toContain('rp-open__coin--flip'); // coin
    expect(page).toContain('rp-open__digit'); // amount roll
    for (const kf of ['rp-coin-flip', 'rp-lift', 'rp-digit-roll']) {
      expect(css, `@keyframes ${kf} missing`).toContain(`@keyframes ${kf}`);
    }
  });

  it('the open sequence cannot navigate after the page is gone', () => {
    // The V1 version left a bare setTimeout running: back out during the spin
    // and it still fired, yanking you into a detail page you had left.
    const page = read('src/features/money/RedPacketOpenPage.tsx');
    expect(page).toContain('clearTimeout');
  });
});

/* ====================== the containing-block trap ====================== */

describe('nothing leaves a transform behind', () => {
  /**
   * THE BUG THIS MILESTONE SHIPPED AND THEN CAUGHT, written down so the next
   * person does not spend an afternoon on it:
   *
   * `.stagger-in` was declared with `animation-fill-mode: both`, which holds
   * the LAST keyframe forever. The last keyframe is `transform: translateY(0)`
   * — visually nothing, computationally `matrix(1,0,0,1,0,0)`. And ANY
   * non-`none` transform makes an element a containing block for
   * `position: fixed` descendants.
   *
   * So every staggered Moments card silently became the viewport for anything
   * fixed inside it. The symptom was nowhere near the cause: the full-screen
   * image viewer opened from a card rendered INSIDE the card — 390×276 at
   * y=296 instead of 390×844 at y=0.
   *
   * The same trap exists for WAAPI: `springTo` fills forwards, so a settled
   * gesture animation keeps a computed transform on its element until it is
   * cancelled. Both halves are guarded here.
   */

  it('.stagger-in does not hold its final transform', () => {
    const rule = /\.stagger-in\s*\{[^}]*\}/.exec(read('src/styles/motion.css'))?.[0] ?? '';
    expect(rule).toContain('animation:');
    expect(rule, '`both`/`forwards` makes every staggered row a containing block').not.toMatch(
      /\b(both|forwards)\b/,
    );
    expect(rule).toMatch(/\bbackwards\b/);
  });

  it('every gesture that fills a spring also cancels it', () => {
    // A settled pull-to-refresh left `transform: translateY(0)` on the host,
    // which is the same containing-block bug by a different route — and it
    // only appears AFTER the user has pulled once, which is the worst kind of
    // bug to reproduce.
    for (const f of ['src/components/usePullRefresh.ts', 'src/components/useSheetDrag.ts']) {
      const src = read(f);
      expect(src, `${f} never cancels its filled animation`).toMatch(/anim\?\.cancel\(\)/);
    }
    // The FLIP entrance is the third one: it fills both so the first frame is
    // already inverted, and cancels on finish so nothing is pinned afterwards.
    expect(read('src/lib/flip.ts')).toMatch(/anim\.cancel\(\)/);
  });

  it('the viewer is a child of a card and must therefore stay full-screen', () => {
    // Documented so the coupling is not rediscovered: MomentCard renders
    // <ImageViewer/> inline, so anything that gives an ancestor a transform
    // breaks it. If this ever moves to a portal, this test can go.
    expect(read('src/features/moments/MomentCard.tsx')).toContain('<ImageViewer');
    expect(read('src/components/image-viewer.css')).toMatch(
      /\.image-viewer\s*\{[^}]*position:\s*fixed/,
    );
  });
});

describe('motion stays inside its guard rails', () => {
  const cssFiles = walk('src').filter((f) => f.endsWith('.css'));

  it('every new animation collapses under prefers-reduced-motion', () => {
    // The rule is per FILE: a stylesheet that animates must also say how it
    // stops. Appending keyframes and forgetting the guard at the bottom is the
    // documented failure mode of motion.css itself.
    for (const f of cssFiles) {
      const src = read(f);
      if (!/animation:/.test(src)) continue;
      expect(src, `${f} animates but has no reduced-motion guard`).toContain(
        'prefers-reduced-motion',
      );
    }
  });

  /**
   * Anything outside this set animates on the main thread and drops frames on
   * the device this app is actually for.
   */
  const ALLOWED = new Set([
    'transform',
    'opacity',
    'transform-origin',
    'offset',
    'filter', // page dimming (M-H3) — GPU-composited like transform/opacity
    'background-position', // skeleton shimmer: moves a gradient, triggers no layout
  ]);

  /**
   * The ledger of what predates the rule, with the reason beside it — the same
   * shape as the route↔golden ledger. An exemption is allowed to exist; being
   * unnamed is not, because an unnamed one is indistinguishable from a mistake.
   */
  const KEYFRAME_EXEMPTIONS: Record<string, string> = {
    'src/features/chat/chat.css:background':
      'M-I6 search-hit flash: a 1.2s one-shot tint on the single row a search jump landed on. ' +
      'Repainting one row once is cheaper than the pseudo-element + stacking context an ' +
      'opacity version needs, and it never runs during a transition.',
  };

  it('only transform and opacity are animated', () => {
    for (const f of cssFiles) {
      const src = read(f);
      const blocks = src.match(/@keyframes[^{]+\{[\s\S]*?\n\}/g) ?? [];
      for (const block of blocks) {
        for (const prop of block.matchAll(/^\s{4}([a-z-]+):/gm)) {
          if (ALLOWED.has(prop[1])) continue;
          if (KEYFRAME_EXEMPTIONS[`${f}:${prop[1]}`]) continue;
          throw new Error(
            `${f}: @keyframes animates ${prop[1]} — use transform/opacity, or add a ` +
              'reasoned entry to KEYFRAME_EXEMPTIONS',
          );
        }
      }
    }
  });

  it('every exemption is still real', () => {
    // An exemption whose file no longer contains the property is a stale note
    // that makes the ledger lie about what the codebase does.
    for (const key of Object.keys(KEYFRAME_EXEMPTIONS)) {
      const [file, prop] = key.split(':');
      expect(read(file), `stale exemption ${key}`).toContain(`${prop}:`);
    }
  });

  it('new overlays still pick a named z layer', () => {
    for (const f of cssFiles) {
      for (const line of read(f).split('\n')) {
        const m = /z-index:\s*(\d+)/.exec(line);
        if (m && Number(m[1]) > 5) throw new Error(`${f}: raw z-index ${m[1]} — use a --z-* token`);
      }
    }
  });
});
