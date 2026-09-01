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
 * finding is worth writing down: **main is 361 and lazy is 14** — essentially
 * the whole app is cold-start weight, and the four lazy chunks that exist
 * (image gen, report canvas, two Capacitor shims) are rounding error. So the
 * lazy budget below is not the constraint; this one is, and the way to buy
 * room under it is to move a real screen behind a dynamic import, which now
 * actually shows up as progress instead of moving nothing.
 */
const MAIN_BUDGET_KB = 365;
/** Everything a dynamic import fetches later. Looser: none of it blocks paint. */
const LAZY_BUDGET_KB = 60;

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
    // CSS is always cold-start weight: it is linked from index.html and blocks
    // first paint whether or not the JS that uses it is lazy.
    const main = f.endsWith('.css') || entryJs.has(f);
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
