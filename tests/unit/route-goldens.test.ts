import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Route ↔ golden ledger (M-I11). Same shape as the SCHEDULED_ACTION_KINDS and
 * DELETE_CONTACT_CASCADE ledgers: every route mounted in App.tsx must appear
 * here, mapped either to the golden that covers it or to an explicit exemption
 * with the reason beside it. Add a route without deciding → this file turns
 * red. "写了没接线" for pages means "shipped outside the screenshot gate".
 */
const ROUTE_LEDGER: Record<
  string,
  { golden: string; pendingCast?: true } | { exempt: string }
> = {
  '/': { exempt: 'redirect to /chats' },
  '*': { exempt: 'redirect to /chats' },
  '/chats': { golden: 'chat-list' },
  '/contacts': { golden: 'contacts' },
  '/discover': { golden: 'discover' },
  '/me': { golden: 'me' },
  '/chat/:convId': { golden: 'chat-single' }, // + chat-group
  '/search': { golden: 'search-empty' }, // + search-results
  '/moments': { golden: 'moments-feed' },
  '/moments/publish': { golden: 'moments-publish' },
  '/moments/repost/:momentId': { exempt: 'needs a tapped source post; compose UI mirrors publish' },
  '/moments/topic/:tag': { exempt: 'needs a tapped topic; list body mirrors moments-feed' },
  '/moments/album/:contactId': { golden: 'moments-album' },
  '/profile': { golden: 'profile' },
  '/favorites': { golden: 'favorites' },
  '/settings': { golden: 'settings' },
  '/settings/api': { golden: 'settings-api' },
  '/settings/asr': { golden: 'settings-asr' },
  // pendingCast (M-J3): the shot is WIRED (pages.spec.ts) but the PNG can only
  // be minted by CI's regen-goldens — local Chromium baselines are宪法-banned.
  // The flag is self-cleaning: once the PNG lands in the repo, a guard below
  // demands the flag be removed, so "pending" can never quietly become "never".
  '/settings/tts': { golden: 'settings-tts', pendingCast: true },
  '/settings/backup': { golden: 'backup' },
  '/settings/notify-test': { golden: 'settings-notify-test' },
  '/settings/env': { exempt: 'probe timings (ms readouts) are nondeterministic by design' },
  '/settings/usage': { golden: 'settings-usage' },
  '/settings/prompt-lab': { golden: 'settings-prompt-lab' },
  '/settings/media': { golden: 'settings-media' },
  '/settings/native': { golden: 'settings-native' },
  '/settings/battery': { golden: 'settings-battery' },
  '/settings/worldbook': { golden: 'settings-worldbook' },
  '/persona/:contactId': { golden: 'persona-edit' },
  '/memory/:contactId': { golden: 'memory' },
  '/merged/:convId/:msgId': { exempt: 'needs an in-session merged forward; card itself is in chat goldens' },
  '/story': { golden: 'story-list' },
  '/story/script/:scriptId': { exempt: 'needs a generated script row; layout is list+detail of story-list' },
  '/story/run/:saveId': { exempt: 'needs a live run; states are exercised by story unit tests' },
  '/contact/:contactId': { golden: 'contact-profile' },
  '/status/:contactId': { golden: 'status' },
  '/report': { golden: 'report' },
  '/contact-new': { exempt: 'thin two-row chooser; both children covered by their own flows' },
  '/contact-new/ai': { exempt: 'generation preview needs an LLM round; fixture-tested in unit suite' },
  '/group-new': { exempt: 'member-pick grid, exercised by unit-tested group-build flow' },
  '/group-new/ai': { exempt: 'generation progress needs an LLM round' },
  '/chat/:convId/info': { golden: 'chat-info' },
  '/groups': { exempt: 'thin list reusing contacts rows' },
  '/new-friends': { exempt: 'static placeholder list' },
  '/contacts-chats-only': { exempt: 'thin SimpleListPage variant' },
  '/contacts-tags': { exempt: 'thin SimpleListPage variant' },
  '/call/:convId': { exempt: 'live call surface (audio + session); 真机人验 per specs' },
  '/rp/send/:convId': { golden: 'rp-send' },
  '/rp/open/:rpId': { golden: 'rp-open' },
  '/rp/:rpId': { golden: 'rp-detail' },
  '/transfer/:convId': { golden: 'transfer-send' },
  '/wallet': { golden: 'wallet' },
};

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
      (v): v is { golden: string; pendingCast?: true } => 'golden' in v,
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
