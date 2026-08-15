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
