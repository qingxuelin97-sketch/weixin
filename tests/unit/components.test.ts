import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  pushDismiss,
  popDismiss,
  hasDismissable,
  clearDismissStack,
} from '../../src/app/dismiss-stack';
import { showConfirm, showPrompt, showActionSheet, dismissAllDialogs } from '../../src/components/dialog';
import { Badge, badgeText } from '../../src/components/Badge';

/**
 * Component foundation (M-I0).
 *
 * The app went seven milestones with zero shared overlay primitives: five
 * `window.prompt` sites, twenty copy-pasted switches, eight bespoke fixed
 * overlays with independently invented z-indexes, and no hardware back button
 * at all. These tests hold the two properties that made the migration worth
 * doing: nothing raw remains, and back always has exactly one meaning.
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

describe('nothing raw remains', () => {
  it('window.prompt / confirm / alert are gone from features', () => {
    // The migration is only real if the old path is unreachable. A single
    // surviving window.prompt renders as a native browser dialog on Android —
    // the most jarring possible break of the WeChat illusion.
    for (const f of walk('src/features')) {
      const src = read(f);
      expect(src.includes('window.prompt'), `${f} still calls window.prompt`).toBe(false);
      expect(src.includes('window.confirm'), `${f} still calls window.confirm`).toBe(false);
      expect(src.includes('window.alert'), `${f} still calls window.alert`).toBe(false);
    }
  });

  it('no feature CSS invents a z-index anymore', () => {
    // Overlay stacking is a total order or it is a bug factory. New overlays
    // must pick a NAMED token layer from tokens.css. (Values ≤5 are local
    // in-flow stacking — a nav bar above its own page content — not overlays.)
    for (const f of walk('src/features').concat(walk('src/components'))) {
      if (!f.endsWith('.css')) continue;
      for (const line of read(f).split('\n')) {
        const m = /z-index:\s*(\d+)/.exec(line);
        if (m && Number(m[1]) > 5) {
          throw new Error(`${f}: raw z-index ${m[1]} — use a --z-* token`);
        }
      }
    }
  });

  it('the copy-pasted switch markup is gone', () => {
    // The component keeps the exact CSS classes (goldens must not move), so
    // the only thing to guard is that nobody hand-writes the span pair again.
    for (const f of walk('src/features')) {
      expect(
        read(f).includes('className={`switch$'),
        `${f} hand-writes switch markup — use <Switch/>`,
      ).toBe(false);
    }
  });

  it('destructive deletes go through showConfirm', () => {
    // 删除该聊天 destroyed a whole thread on one tap for seven milestones.
    expect(read('src/features/chat-list/ChatListPage.tsx')).toContain('showConfirm');
    expect(read('src/features/chat/ChatInfoPage.tsx')).toContain('showConfirm');
    expect(read('src/features/settings/MediaLibraryPage.tsx')).toContain('showConfirm');
  });

  it('the hosts are actually mounted', () => {
    const app = read('src/App.tsx');
    expect(app).toContain('<DialogHost />');
    expect(app).toContain('useBackButton');
  });

  it('exactly one file defines the long-press threshold', () => {
    // Two hand-rolled copies of this gesture is how the thresholds drift apart.
    // The hook owns LONG_PRESS_MS; features consume useLongPress.
    const owners = walk('src/features')
      .concat(walk('src/components'))
      .filter((f) => /LONG_PRESS_MS\s*=/.test(read(f)));
    expect(owners).toEqual(['src/components/useLongPress.ts']);
  });

  it('the forward picker is a Sheet, not a hand-rolled mask', () => {
    // Sheet must have a real consumer (写了没接线 = 没做), and the old
    // mask/panel pair must be unreachable.
    expect(read('src/features/chat/ChatPage.tsx')).toContain("components/Sheet");
    expect(read('src/features/chat/chat.css')).not.toContain('forward-mask');
  });

  it('every conditional overlay registers with the dismiss stack', () => {
    // Back must close the topmost overlay, which only works if each overlay
    // actually registers. New overlays: copy this pattern, then add yourself.
    for (const f of [
      'src/components/Sheet.tsx',
      'src/components/ImageViewer.tsx',
      'src/components/MediaPicker.tsx',
      'src/components/LongPressMenu.tsx', // the shared long-press menu
      'src/features/chat/ChatPage.tsx', // composer panels
      'src/features/chat-list/ChatListPage.tsx', // ＋ dropdown
    ]) {
      expect(read(f).includes('useDismissable'), `${f} does not register with the dismiss stack`).toBe(true);
    }
  });
});

/**
 * The two pieces I0 named but left half-done (finished in I18): the badge and
 * the long-press MENU. Both were "one component" on paper and two hand-written
 * copies in the tree.
 */
describe('the badge is one component', () => {
  /** Every class string a badge is allowed to wear. Skins stay feature-owned. */
  const BADGE_CLASSES = [
    'tabbar__badge',
    'conv-row__badge',
    'chat-nav__unread',
    'discover__num-badge',
    'discover__reddot',
  ];
  const pages = () => walk('src/features').concat(walk('src/app')).filter((f) => f.endsWith('.tsx'));

  it('has real consumers — 写了没接线 = 没做', () => {
    const consumers = pages().filter((f) => /from\s+'[^']*components\/Badge'/.test(read(f)));
    expect(consumers.length, `only ${consumers.length} pages use <Badge/>`).toBeGreaterThanOrEqual(4);
  });

  it('nobody hand-writes a badge span anymore', () => {
    // The three rules a badge encodes (hide at zero, clamp at 99+, dot when
    // muted) were copy-pasted four times. A new hand-rolled span is how one
    // copy quietly starts rendering `100`.
    for (const f of pages()) {
      const inline = new RegExp(`<span[^>]*(${BADGE_CLASSES.join('|')})`);
      expect(inline.test(read(f)), `${f} hand-writes badge markup — use <Badge/>`).toBe(false);
    }
  });

  it('clamps at 99+ and renders nothing at zero', () => {
    expect(badgeText(1)).toBe('1');
    expect(badgeText(99)).toBe('99');
    expect(badgeText(100)).toBe('99+');
    // An empty red circle is worse than no circle; a dot has no count to show.
    expect(Badge({ className: 'x', count: 0 })).toBeNull();
    expect(Badge({ className: 'x' })).toBeNull();
    expect(Badge({ className: 'x', dot: true })).not.toBeNull();
  });
});

describe('the long-press menu is one component', () => {
  it('both consumers render the shared menu', () => {
    for (const f of ['src/features/chat/ChatPage.tsx', 'src/features/chat-list/ChatListPage.tsx']) {
      expect(read(f), `${f} does not use <LongPressMenu/>`).toContain('<LongPressMenu');
    }
  });

  it('the old hand-rolled menus are unreachable', () => {
    // `--z-msg-menu` keeps its token name (the layer is still the layer), so
    // strip the token before looking for the old class.
    for (const f of walk('src/features')) {
      const src = read(f).replaceAll('--z-msg-menu', '--z-<layer>');
      expect(src.includes('msg-menu'), `${f} still hand-rolls the message menu`).toBe(false);
      expect(src.includes('conv-menu'), `${f} still hand-rolls the conversation menu`).toBe(false);
    }
    // …and the skin lives with the component, not in a feature stylesheet.
    expect(read('src/components/long-press-menu.css')).toContain('.lp-menu');
  });

  it('dismissal is the component\'s job in both places', () => {
    // The chat page used to close its menu with a document-level pointerdown
    // capture listener while the chat list used a scrim — two behaviours for
    // "tap outside", in one app. The scrim now lives in the component.
    expect(read('src/features/chat/ChatPage.tsx')).not.toContain("addEventListener('pointerdown'");
    expect(read('src/components/LongPressMenu.tsx')).toContain('lp-menu__scrim');
  });
});

describe('the sheet and the composer are independent', () => {
  // I0 shipped them deliberately unentangled: Sheet is a dumb controlled
  // container, `useComposerPanel` is the three-state keyboard⇄panel machine
  // (禁止重写清单). Nothing enforced it, and the tempting shortcut — teaching
  // the sheet to lock itself to the keyboard height — would weld the one
  // machine that must stay analyzable to a generic overlay.
  it('Sheet knows nothing about the composer', () => {
    const sheet = read('src/components/Sheet.tsx');
    expect(/useComposerPanel|ComposerMode/.test(sheet), 'Sheet imports the composer machine').toBe(
      false,
    );
    // More generally: a component may never reach into a feature.
    expect(/from\s+'[^']*features\//.test(sheet), 'Sheet imports from src/features').toBe(false);
  });

  it('the composer machine knows nothing about Sheet', () => {
    const composer = read('src/features/chat/useComposerPanel.ts');
    expect(/components\/Sheet|<Sheet/.test(composer), 'the composer machine imports Sheet').toBe(
      false,
    );
  });
});

describe('the dismiss stack', () => {
  afterEach(() => clearDismissStack());

  it('pops in reverse order of opening', () => {
    const order: string[] = [];
    pushDismiss(() => order.push('a'));
    pushDismiss(() => order.push('b'));
    expect(popDismiss()).toBe(true);
    expect(popDismiss()).toBe(true);
    expect(popDismiss()).toBe(false);
    expect(order).toEqual(['b', 'a']);
  });

  it('an unregistered overlay cannot be popped twice', () => {
    // The overlay closed itself (scrim tap); back must NOT re-fire its close —
    // that would eat the press that should have navigated.
    const order: string[] = [];
    const un = pushDismiss(() => order.push('a'));
    un();
    expect(popDismiss()).toBe(false);
    expect(order).toEqual([]);
  });

  it('a throwing close handler does not break the chain', () => {
    pushDismiss(() => {
      throw new Error('boom');
    });
    expect(popDismiss()).toBe(true);
    expect(hasDismissable()).toBe(false);
  });
});

describe('the dialog service', () => {
  afterEach(() => dismissAllDialogs());

  it('dismissAll resolves rather than abandons', async () => {
    // A hung promise here is a frozen flow the user cannot see: the caller
    // awaits an answer that never comes.
    const confirm = showConfirm({ title: 't' });
    const prompt = showPrompt({ title: 't' });
    const sheet = showActionSheet({ actions: ['x'] });
    dismissAllDialogs();
    expect(await confirm).toBe(false);
    expect(await prompt).toBeNull();
    expect(await sheet).toBeNull();
  });

  it('queues a second ask instead of stacking two scrims', async () => {
    const first = showConfirm({ title: '1' });
    const second = showConfirm({ title: '2' });
    dismissAllDialogs();
    expect(await first).toBe(false);
    expect(await second).toBe(false);
  });
});
