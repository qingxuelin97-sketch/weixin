import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROUTE_LEDGER, smokePaths, smokeSkips, pathMatchesRoute } from '../lib/route-ledger';
import type { RouteRow } from '../lib/route-ledger';

/**
 * Route ↔ golden ledger (M-I11), shared with the boot-smoke spec since M-J0.
 * Same shape as the SCHEDULED_ACTION_KINDS and DELETE_CONTACT_CASCADE ledgers:
 * every route mounted in App.tsx must appear in tests/lib/route-ledger.ts,
 * mapped either to the golden that covers it or to an explicit exemption with
 * the reason beside it — AND to a smoke decision (a concrete bootable URL, or
 * a skip with its reason). Add a route without deciding → this file turns red.
 * "写了没接线" for pages means "shipped outside the screenshot gate".
 */

const ROOT = join(__dirname, '..', '..');

function routesFromApp(): string[] {
  const src = readFileSync(join(ROOT, 'src', 'App.tsx'), 'utf8');
  return [...src.matchAll(/path="([^"]+)"/g)].map((m) => m[1]);
}

function goldenNames(): Set<string> {
  const out = new Set<string>();
  const dir = join(ROOT, 'tests', 'screenshot');
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith('-snapshots')) continue;
    for (const png of readdirSync(join(dir, entry))) {
      out.add(png.replace(/-chromium-linux\.png$/, ''));
    }
  }
  return out;
}

/** Golden names actually wired into a screenshot spec (what CI regen will cast). */
function specClaimedNames(): string {
  const dir = join(ROOT, 'tests', 'screenshot');
  return readdirSync(dir)
    .filter((f) => f.endsWith('.spec.ts'))
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
}

describe('route ↔ golden ledger', () => {
  it('every mounted route has a ledger entry (add one when adding a route)', () => {
    const missing = routesFromApp().filter((r) => !(r in ROUTE_LEDGER));
    expect(missing).toEqual([]);
  });

  it('every ledger route actually exists in App.tsx (no stale entries)', () => {
    const mounted = new Set(routesFromApp());
    const stale = Object.keys(ROUTE_LEDGER).filter((r) => !mounted.has(r));
    expect(stale).toEqual([]);
  });

  it('every claimed golden file exists on disk (pendingCast: wired, awaiting CI mint)', () => {
    const have = goldenNames();
    const entries = Object.values(ROUTE_LEDGER).filter(
      (v): v is Extract<RouteRow, { golden: string }> => 'golden' in v,
    );
    const missing = entries
      .filter((v) => !v.pendingCast)
      .map((v) => v.golden)
      .filter((g) => !have.has(g));
    expect(missing).toEqual([]);
    // pendingCast is NOT an exemption: the shot must already be wired into a
    // spec file, so the very next regen-goldens run mints it. A name no spec
    // references would stay "pending" forever — that is the state this guard
    // makes unrepresentable.
    const specs = specClaimedNames();
    for (const v of entries.filter((x) => x.pendingCast)) {
      expect(
        specs.includes(`'${v.golden}'`),
        `${v.golden} 标了 pendingCast 却没有任何 screenshot spec 会拍它——登记不等于接线`,
      ).toBe(true);
    }
  });

  it('pendingCast is self-cleaning: once the PNG exists the flag must go', () => {
    const have = goldenNames();
    const lingering = Object.values(ROUTE_LEDGER)
      .filter((v): v is { golden: string; pendingCast?: true } => 'golden' in v && !!v.pendingCast)
      .map((v) => v.golden)
      .filter((g) => have.has(g));
    // CI 铸完基线后这里转红：把对应条目的 pendingCast 摘掉，让它回到
    // 「存在性强断言」的正常轨道。
    expect(lingering).toEqual([]);
  });
});

describe('route ↔ smoke ledger (M-J0 — the two lists must never fork again)', () => {
  it('every smoke path is concrete and instantiates exactly its own route', () => {
    for (const [route, row] of Object.entries(ROUTE_LEDGER)) {
      if (!('path' in row.smoke)) continue;
      const p = row.smoke.path;
      expect(p.includes(':'), `${route} 的冒烟路径还带着未填的参数: ${p}`).toBe(false);
      expect(pathMatchesRoute(p, route), `${route} 的冒烟路径 ${p} 根本走不进这条路由`).toBe(true);
    }
  });

  it("the catch-all's smoke path matches no real route (otherwise it tests the wrong thing)", () => {
    const star = ROUTE_LEDGER['*'];
    expect(star && 'path' in star.smoke).toBe(true);
    const p = ('path' in star.smoke && star.smoke.path) as string;
    const hijackers = Object.keys(ROUTE_LEDGER).filter(
      (r) => r !== '*' && pathMatchesRoute(p, r),
    );
    expect(hijackers).toEqual([]);
  });

  it('a skipped smoke carries a real reason (skip 的门槛比 golden 豁免更高)', () => {
    for (const { route, reason } of smokeSkips()) {
      expect(reason.trim().length, `${route} 的 skip 没写原因`).toBeGreaterThan(10);
    }
  });

  it('smoke decisions cover the whole ledger — path or skip, no third state', () => {
    // The RouteRow type already forces this at compile time; this assert keeps
    // it true for anyone editing the ledger with type errors ignored.
    expect(smokePaths().length + smokeSkips().length).toBe(Object.keys(ROUTE_LEDGER).length);
  });

  it('route-smoke.spec.ts derives from THIS ledger and keeps no list of its own', () => {
    const spec = readFileSync(join(ROOT, 'tests', 'screenshot', 'route-smoke.spec.ts'), 'utf8');
    expect(spec, 'smoke spec 不再 import 共享台账——两份清单又要分叉了').toMatch(
      /from '\.\.\/lib\/route-ledger'/,
    );
    expect(spec, 'smoke spec 里出现了手抄的路由数组——清单只能有一份').not.toMatch(
      /const ROUTES\s*[:=]/,
    );
  });
});
