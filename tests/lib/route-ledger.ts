/**
 * 路由台账——golden 与冒烟的**同一份**真源 (M-J0)。
 *
 * 此前有两份手抄清单：route-goldens.test.ts 的 ROUTE_LEDGER（golden 决策）和
 * route-smoke.spec.ts 的 ROUTES（能不能起来）。两份各自维护，新路由只要漏掉
 * smoke 那份就悄悄溜出「白屏检测」——而豁免 golden 的路由恰恰是最容易白屏还
 * 没人看的。现在每一行必须同时回答两个问题：
 *
 *   1. golden：有截图基线吗？没有的话为什么豁免？（豁免的是**像素回归**）
 *   2. smoke：怎么把它启动起来冒烟？参数路由给一个具体实例（种子 id，或该页
 *      自身的 missing 兜底态——兜底态也是「能起来」的证明）；实在起不来的
 *      标 skip 并写明原因。（skip 掉的是**启动检查**，门槛远比 golden 低，
 *      所以 skip 理由必须过硬）
 *
 * route-goldens.test.ts 守 golden 半边并断言 smoke 计划合法（每条 path 真的
 * 匹配自己的路由模式、没有残留的 `:param`）；route-smoke.spec.ts 从这里派生
 * 它要走的全部 URL，自己**不许**再维护清单——有守卫盯着它的 import。
 */

export type GoldenDecision = { golden: string; pendingCast?: true } | { exempt: string };
export type SmokeDecision = { path: string } | { skip: string };
export type RouteRow = GoldenDecision & { smoke: SmokeDecision };

export const ROUTE_LEDGER: Record<string, RouteRow> = {
  '/': { exempt: 'redirect to /chats', smoke: { path: '/' } },
  // The catch-all: any unknown path must land on /chats, so smoke it with one.
  '*': { exempt: 'redirect to /chats', smoke: { path: '/no-such-route-smoke' } },
  '/chats': { golden: 'chat-list', smoke: { path: '/chats' } },
  '/contacts': { golden: 'contacts', smoke: { path: '/contacts' } },
  '/discover': { golden: 'discover', smoke: { path: '/discover' } },
  '/me': { golden: 'me', smoke: { path: '/me' } },
  '/chat/:convId': { golden: 'chat-single', smoke: { path: '/chat/conv_lin' } }, // + chat-group
  '/search': { golden: 'search-empty', smoke: { path: '/search' } }, // + search-results
  '/moments': { golden: 'moments-feed', smoke: { path: '/moments' } },
  '/moments/publish': { golden: 'moments-publish', smoke: { path: '/moments/publish' } },
  '/moments/repost/:momentId': {
    exempt: 'needs a tapped source post; compose UI mirrors publish',
    smoke: { path: '/moments/repost/mo_seed_lin' }, // seeded moment
  },
  '/moments/topic/:tag': {
    exempt: 'needs a tapped topic; list body mirrors moments-feed',
    smoke: { path: '/moments/topic/深夜' }, // any tag boots; empty list is a valid state
  },
  '/moments/album/:contactId': { golden: 'moments-album', smoke: { path: '/moments/album/ai_lin' } },
  '/profile': { golden: 'profile', smoke: { path: '/profile' } },
  '/favorites': { golden: 'favorites', smoke: { path: '/favorites' } },
  '/settings': { golden: 'settings', smoke: { path: '/settings' } },
  '/settings/api': { golden: 'settings-api', smoke: { path: '/settings/api' } },
  '/settings/asr': { golden: 'settings-asr', smoke: { path: '/settings/asr' } },
  // pendingCast 旗已摘（M-J wave1b）：CI regen 在 67878d5 铸出了 settings-tts.png，
  // 自清洁守卫随即要求回到存在性强断言的正常轨道。
  '/settings/tts': { golden: 'settings-tts', smoke: { path: '/settings/tts' } },
  '/settings/backup': { golden: 'backup', smoke: { path: '/settings/backup' } },
  '/settings/notify-test': { golden: 'settings-notify-test', smoke: { path: '/settings/notify-test' } },
  '/settings/env': {
    exempt: 'probe timings (ms readouts) are nondeterministic by design',
    smoke: { path: '/settings/env' },
  },
  '/settings/usage': { golden: 'settings-usage', smoke: { path: '/settings/usage' } },
  '/settings/prompt-lab': { golden: 'settings-prompt-lab', smoke: { path: '/settings/prompt-lab' } },
  '/settings/media': { golden: 'settings-media', smoke: { path: '/settings/media' } },
  '/settings/native': { golden: 'settings-native', smoke: { path: '/settings/native' } },
  '/settings/battery': { golden: 'settings-battery', smoke: { path: '/settings/battery' } },
  '/settings/worldbook': { golden: 'settings-worldbook', smoke: { path: '/settings/worldbook' } },
  '/persona/:contactId': { golden: 'persona-edit', smoke: { path: '/persona/ai_lin' } },
  '/memory/:contactId': { golden: 'memory', smoke: { path: '/memory/ai_lin' } },
  '/merged/:convId/:msgId': {
    exempt: 'needs an in-session merged forward; card itself is in chat goldens',
    // No seedable merged message; the page's own graceful missing state is the
    // boot proof (SubNav + "这条聊天记录不存在了"), and that fallback rendering
    // is exactly what a stale deep link hits on a real phone.
    smoke: { path: '/merged/conv_lin/999999' },
  },
  '/story': { golden: 'story-list', smoke: { path: '/story' } },
  '/story/script/:scriptId': {
    exempt: 'needs a generated script row; layout is list+detail of story-list',
    smoke: { path: '/story/script/builtin_rainy_night' }, // builtin script id, stable
  },
  '/story/run/:saveId': {
    exempt: 'needs a live run; states are exercised by story unit tests',
    // Same missing-state argument as /merged: a save id that does not exist
    // must render the "存档不见了" shell, not a white screen.
    smoke: { path: '/story/run/save_smoke_missing' },
  },
  '/contact/:contactId': { golden: 'contact-profile', smoke: { path: '/contact/ai_lin' } },
  '/status/:contactId': { golden: 'status', smoke: { path: '/status/ai_lin' } },
  '/report': { golden: 'report', smoke: { path: '/report' } },
  '/contact-new': {
    exempt: 'thin two-row chooser; both children covered by their own flows',
    smoke: { path: '/contact-new' },
  },
  '/contact-new/ai': {
    exempt: 'generation preview needs an LLM round; fixture-tested in unit suite',
    smoke: { path: '/contact-new/ai' },
  },
  '/group-new': {
    exempt: 'member-pick grid, exercised by unit-tested group-build flow',
    smoke: { path: '/group-new' },
  },
  '/group-new/ai': {
    exempt: 'generation progress needs an LLM round',
    smoke: { path: '/group-new/ai' },
  },
  '/chat/:convId/info': { golden: 'chat-info', smoke: { path: '/chat/conv_lin/info' } },
  '/groups': { exempt: 'thin list reusing contacts rows', smoke: { path: '/groups' } },
  '/new-friends': { exempt: 'static placeholder list', smoke: { path: '/new-friends' } },
  '/contacts-chats-only': {
    exempt: 'thin SimpleListPage variant',
    smoke: { path: '/contacts-chats-only' },
  },
  '/contacts-tags': { exempt: 'thin SimpleListPage variant', smoke: { path: '/contacts-tags' } },
  '/call/:convId': {
    exempt: 'live call surface (audio + session); 真机人验 per specs',
    smoke: { path: '/call/conv_lin' }, // boots into the dialing phase; smoke leaves before answer
  },
  '/group-call/:convId': {
    exempt: 'live call surface (audio + session), group flavor (M-J6c); 真机人验 per specs',
    smoke: { path: '/group-call/conv_group' }, // dial beat only; smoke leaves before connect
  },
  '/rp/send/:convId': { golden: 'rp-send', smoke: { path: '/rp/send/conv_lin' } },
  '/rp/open/:rpId': {
    golden: 'rp-open',
    // No seeded red packet row; the open sheet must still mount (close button,
    // empty envelope) for a packet that was deleted or never existed.
    smoke: { path: '/rp/open/rp_smoke_missing' },
  },
  '/rp/:rpId': { golden: 'rp-detail', smoke: { path: '/rp/rp_smoke_missing' } },
  '/transfer/:convId': { golden: 'transfer-send', smoke: { path: '/transfer/conv_lin' } },
  '/wallet': { golden: 'wallet', smoke: { path: '/wallet' } },
  // 朋友圈单条详情 (M-J12). Smoke boots on a seeded post; the missing-id empty
  // state is separately exercised by moment-detail-e2e.spec.ts. pendingCast
  // 旗已摘：CI regen（d386ae3）铸出了 moment-detail.png。
  '/moments/:momentId': {
    golden: 'moment-detail',
    smoke: { path: '/moments/mo_seed_lin' },
  },
};

/** All concrete URLs the smoke spec must walk, in ledger order. */
export function smokePaths(): string[] {
  return Object.values(ROUTE_LEDGER).flatMap((row) =>
    'path' in row.smoke ? [row.smoke.path] : [],
  );
}

/** Routes whose smoke is skipped, with reasons — surfaced in the smoke spec log. */
export function smokeSkips(): Array<{ route: string; reason: string }> {
  return Object.entries(ROUTE_LEDGER).flatMap(([route, row]) =>
    'skip' in row.smoke ? [{ route, reason: row.smoke.skip }] : [],
  );
}

/**
 * Does a concrete path instantiate a route pattern? Segment-wise: `:param`
 * matches any non-empty segment, statics match verbatim. `*` matches anything
 * (it is the catch-all). Used by the ledger guard to prove every smoke path
 * actually exercises the row it sits on — a typo'd path would otherwise smoke
 * the catch-all redirect instead of the page it claims to cover.
 */
export function pathMatchesRoute(path: string, route: string): boolean {
  if (route === '*') return true;
  const rs = route.split('/');
  const ps = path.split('/');
  if (rs.length !== ps.length) return false;
  return rs.every((seg, i) => (seg.startsWith(':') ? ps[i].length > 0 : seg === ps[i]));
}
