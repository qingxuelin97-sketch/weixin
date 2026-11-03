#!/usr/bin/env node
/**
 * Startup-weight ratchet (M-I18, split into two ledgers at M-J10).
 *
 * The M-I round added ~30k lines and nothing anywhere would have noticed if the
 * bundle had doubled: `pnpm build` only warns about chunk size (a warning that
 * has been printing, and being ignored, for milestones), and the phone is the
 * one place the cost is actually paid — a WebView parses this on every cold
 * start, over whatever connection the user has.
 *
 * ## Two ledgers, because they measure different costs
 *
 * The single total-gzip number this started as had a perverse property: moving
 * a module behind a dynamic import — which makes cold start genuinely faster —
 * did not move the number at all, so the ratchet quietly punished the right
 * fix and rewarded doing nothing. (That trap is written up in CLAUDE.md §3.5;
 * it caught us twice before it got a name.)
 *
 *  - **MAIN** is what a cold start actually parses: the entry chunk referenced
 *    by index.html plus every stylesheet. This is the number that maps to
 *    "how long until the app is usable", and it is the one that should be hard
 *    to raise.
 *  - **LAZY** is everything a dynamic import pulls in later (the image
 *    generator, the year-report canvas, Capacitor's per-plugin web shims…).
 *    It still deserves a ceiling — a lazy chunk is bytes on someone's data
 *    plan, and an accidental barrel import shows up here first — but it is a
 *    looser one, because none of it blocks first paint.
 *
 * Both are RATCHETS, not targets: they sit just above today's real numbers, so
 * ordinary feature work passes and a step change (a new heavy dep, an
 * accidental import that drags the world in) fails loudly. When a change
 * legitimately needs more room, raise the number deliberately in the same
 * commit — that edit is the record of the decision.
 *
 * History of the old combined budget, kept because the reasoning still applies:
 *   307 (M-I18 baseline) → 340 → 360 (M-J wave 1: J1+J3, ~11KB first-party,
 *   zero new deps) → 375 (M-J wave 1b: J5+J8+J9+J12, ~13KB) → 385 (M-J7:
 *   拍一拍/翻译/清空). At the split, main measured ~350 and lazy ~35.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

/**
 * Cold-start JS+CSS: the entry chunk plus every stylesheet, gzipped, in KB.
 *
 * Calibrated at the split (M-J10) to 365 against a real 361. The split's first
 * finding was worth writing down: **main was 361 and lazy was 14** — essentially
 * the whole app was cold-start weight, and the four lazy chunks that existed
 * (image gen, report canvas, two Capacitor shims) were rounding error. So the
 * lazy budget below is not the constraint; this one is, and the way to buy
 * room under it is to move a real screen behind a dynamic import, which now
 * actually shows up as progress instead of moving nothing.
 *
 * M-J7 did exactly that and the number moved for the first time: eight cold
 * routes (both call screens, story run + script detail, the two AI-authoring
 * screens, merged-forward viewer, notify test) went behind `React.lazy`,
 * taking main from 364 to 342. Re-tightened to 348 rather than left at 365,
 * because a ratchet that keeps the slack it just earned is not a ratchet — the
 * next 20KB of首屏 would slide in unnoticed and the work would have bought
 * nothing.
 */
/*
 * M-K10 took main from 345 to 305 in three moves, none of which deleted a
 * feature: react-virtuoso out of the chat list (it was the biggest first-party
 * dependency in main — gzip ~16KB — virtualizing a list of a few dozen rows),
 * the native-only SQLite driver + migrator behind `import()`, and the whole
 * scheduler runtime (25 handlers and the subsystems behind them) loaded after
 * hydrate instead of parsed before first paint. Re-tightened 348 → 312 for the
 * same reason as last time: keeping the slack would hand the next 40KB of
 * cold-start weight a free pass.
 */
/*
 * M-K11 took main from 312.0 to 305.3 by moving the chat send pipeline (the
 * single + group engines, memory extraction, translation, sticker battles —
 * the whole engine tree) behind the same dynamic entry the scheduler runtime
 * already used (`src/app/ai-runtime.ts`). Two things had pinned it in main: a
 * static `abortConversation` import in the store (now `ai/inflight`) and
 * ChatPage's own imports. A first cut with two separate `import()`s measured
 * 41% overhead (three small chunks, no shared dictionary) and was redone as
 * one entry: main −6.68 / lazy +7.63 / total +0.95 = 14%, under the one-third
 * line. Re-tightened 312 → 308 rather than to the bone: K8/K9/K12 are UI work
 * on golden-gated pages that must stay in main, and the ratchet is for step
 * changes, not for making every screen tweak find a saving first.
 */
const MAIN_BUDGET_KB = 308;
/**
 * Everything a dynamic import fetches later. Looser: none of it blocks paint.
 *
 * Raised 60→90 in M-J10 for a reason worth stating, because it looks like
 * slackening: moving a screen from main to lazy is **net zero bytes** and
 * strictly better cold start, so a lazy budget that goes red on migration
 * punishes exactly the fix the split was built to reward — the same mistake
 * the single-total ratchet made, just one level down.
 *
 * The rule that keeps this honest is a pair, not a number: **a main→lazy
 * migration must lower MAIN by at least as much as it raises LAZY.** Both
 * numbers print on every run and belong in the commit message, so the check is
 * a reviewer reading two lines. What this budget still catches is what it was
 * for: NEW deferred code piling up unbounded.
 *
 * M-K5 made that rule measurable, because read literally it forbids almost every
 * split: gzip compresses each chunk on its own, so code that leaves main loses
 * the cross-chunk dictionary it shared there and comes back slightly bigger.
 * Measured: the scheduler runtime split was main −18 / lazy +20 (11% overhead),
 * the call-engine split main −3.3 / lazy +4.3 (30%), seven tiny contact pages
 * main −2.2 / lazy +3.4 (59%). The refined rule: **a migration may grow the
 * TOTAL by at most one third of the MAIN it removes.** The first two pass and
 * shipped; the third failed and was reverted — a split whose overhead eats more
 * than a third of its own saving is making the app heavier to look lighter.
 * Same discipline as before: both numbers, and the ratio, go in the commit.
 */
/*
 * Raised 90 → 96 in M-K11 for exactly the reason the M-J10 note gives: the
 * engine tree moved here from main (main −6.68, lazy +7.63, total +0.95), and
 * a lazy budget that goes red on a migration punishes the fix.
 */
/*
 * 96 → 98 in M-K9: the first-run guide (WelcomePage + its stylesheet, ~2.7KB
 * as its own chunk). It is seen once per install, so it is lazy ON PURPOSE —
 * statically imported it measured main 308.33 against 308, i.e. every launch
 * of every install paying 2KB for a screen shown once. A deliberate new
 * deferred screen is exactly the "legitimately needs more room" case.
 */
const LAZY_BUDGET_KB = 98;

const dir = 'dist/assets';
let entries;
try {
  entries = readdirSync(dir);
} catch (e) {
  // Narrow on purpose: a bare `catch {}` here once reported a ReferenceError
  // in this very file as "dist/assets not found", sending the reader off to
  // re-run a build that was already fine.
  if (e?.code !== 'ENOENT') throw e;
  console.error(`✗ ${dir} not found — run \`pnpm build\` first.`);
  process.exit(1);
}

// index.html names the entry chunk; Vite emits no modulepreload links here
// because the entry is self-contained, so "referenced by index.html" is an
// exact description of the cold-start JS. Anything else under assets/ got there
// through a dynamic import.
let html = '';
try {
  html = readFileSync('dist/index.html', 'utf8');
} catch {
  console.error('✗ dist/index.html not found — run `pnpm build` first.');
  process.exit(1);
}
const entryJs = new Set([...html.matchAll(/assets\/([\w.-]+\.js)/g)].map((m) => m[1]));
/**
 * Stylesheets linked from index.html (M-K7). Only THESE block first paint.
 *
 * Until M-K7 every .css counted as main, on the reasoning written beside the
 * classifier below — "it is linked from index.html". That was true while the
 * build emitted exactly one stylesheet. A CSS file imported only by lazy
 * modules is split by Vite into its own file and fetched WITH its chunk, the
 * same as that chunk's JS: lazy weight. Classify by the same evidence the JS
 * side uses — what index.html actually references.
 */
const entryCss = new Set([...html.matchAll(/assets\/([\w.-]+\.css)/g)].map((m) => m[1]));
if (entryCss.size === 0) {
  // Same failure mode as above: a ratchet that measures "0 KB of CSS" passes
  // exactly when it must not.
  console.error('✗ no stylesheet linked from dist/index.html — the ratchet cannot measure main CSS.');
  process.exit(1);
}
if (entryJs.size === 0) {
  // Fail loudly rather than silently measuring "0 KB of main": a build whose
  // entry cannot be found is exactly when this check must not pass.
  console.error('✗ no entry chunk found in dist/index.html — the ratchet cannot measure main.');
  process.exit(1);
}

const files = entries
  .filter((f) => f.endsWith('.js') || f.endsWith('.css'))
  .map((f) => {
    const bytes = gzipSync(readFileSync(join(dir, f)), { level: 9 }).length;
    // Entry CSS is cold-start weight: linked from index.html, it blocks first
    // paint whether or not the JS that uses it is lazy. A lazy chunk's own
    // stylesheet is not linked there and loads with the chunk (see entryCss).
    const main = entryCss.has(f) || entryJs.has(f);
    return { f, kb: bytes / 1024, main };
  })
  .sort((a, b) => b.kb - a.kb);

const mainKb = files.filter((x) => x.main).reduce((n, x) => n + x.kb, 0);
const lazyKb = files.filter((x) => !x.main).reduce((n, x) => n + x.kb, 0);

for (const { f, kb, main } of files.slice(0, 6)) {
  console.log(`  ${kb.toFixed(0).padStart(4)} KB gz  ${main ? '[main]' : '[lazy]'} ${f}`);
}
console.log(`  ${'—'.repeat(30)}`);
console.log(`  ${mainKb.toFixed(0).padStart(4)} KB gz  main  (budget ${MAIN_BUDGET_KB})`);
console.log(`  ${lazyKb.toFixed(0).padStart(4)} KB gz  lazy  (budget ${LAZY_BUDGET_KB})`);

let failed = false;
if (mainKb > MAIN_BUDGET_KB) {
  console.error(
    `\n✗ 冷启动主包超预算：${mainKb.toFixed(0)} KB > ${MAIN_BUDGET_KB} KB。\n` +
      `  这个数字直接对应"打开到能用要多久"。要么减重、要么把不阻塞首屏的模块改成\n` +
      `  动态 import（那会把它挪进 lazy 账本），要么在同一个提交里显式上调并说明。`,
  );
  failed = true;
}
if (lazyKb > LAZY_BUDGET_KB) {
  console.error(
    `\n✗ 懒加载总量超预算：${lazyKb.toFixed(0)} KB > ${LAZY_BUDGET_KB} KB。\n` +
      `  懒 chunk 不阻塞首屏，但仍然是用户的流量；通常意味着某个 barrel import 把\n` +
      `  一整片东西拖了进来。`,
  );
  failed = true;
}
if (failed) process.exit(1);

console.log(
  `\n✓ 启动包在预算内（主 ${(MAIN_BUDGET_KB - mainKb).toFixed(0)} KB 余量，` +
    `懒 ${(LAZY_BUDGET_KB - lazyKb).toFixed(0)} KB 余量）`,
);
