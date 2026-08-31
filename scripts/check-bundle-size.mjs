#!/usr/bin/env node
/**
 * Startup-weight ratchet (M-I18).
 *
 * The M-I round added ~30k lines and nothing anywhere would have noticed if the
 * bundle had doubled: `pnpm build` only warns about chunk size (a warning that
 * has been printing, and being ignored, for milestones), and the phone is the
 * one place the cost is actually paid — a WebView parses this on every cold
 * start, over whatever connection the user has.
 *
 * This is a RATCHET, not a target: the budget sits just above today's real
 * number, so ordinary feature work passes and a step change (a new heavy dep,
 * an accidental barrel import that drags the world in) fails loudly. When a
 * change legitimately needs more room, raise BUDGET_KB deliberately in the same
 * commit — that edit is the record of the decision.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

/**
 * Total gzipped JS+CSS shipped to the browser, in KB. Measured 307 at M-I18.
 *
 * 340→360 (M-J wave 1): J1 心智一致性 + J3 图像生成 landed ~11KB of first-party
 * main-chunk code with ZERO new runtime dependencies (the only new lazy chunk,
 * image.ts, is 2.7KB and loads on demand). Raised deliberately per this file's
 * own doctrine; J13 will split the ratchet into main-chunk vs lazy budgets so
 * the number stops punishing code that never blocks cold start.
 */
const BUDGET_KB = 360;

const dir = 'dist/assets';
let entries;
try {
  entries = readdirSync(dir);
} catch {
  console.error(`✗ ${dir} not found — run \`pnpm build\` first.`);
  process.exit(1);
}

const files = entries
  .filter((f) => f.endsWith('.js') || f.endsWith('.css'))
  .map((f) => {
    const bytes = gzipSync(readFileSync(join(dir, f)), { level: 9 }).length;
    return { f, kb: bytes / 1024 };
  })
  .sort((a, b) => b.kb - a.kb);

const totalKb = files.reduce((n, x) => n + x.kb, 0);

for (const { f, kb } of files.slice(0, 5)) {
  console.log(`  ${kb.toFixed(0).padStart(4)} KB gz  ${f}`);
}
console.log(`  ${'—'.repeat(24)}`);
console.log(`  ${totalKb.toFixed(0).padStart(4)} KB gz  total (budget ${BUDGET_KB})`);

if (totalKb > BUDGET_KB) {
  console.error(
    `\n✗ 启动包超预算：${totalKb.toFixed(0)} KB > ${BUDGET_KB} KB。\n` +
      `  要么减重（查上面最大的那个 chunk），要么在同一个提交里显式上调 BUDGET_KB 并说明原因。`,
  );
  process.exit(1);
}

console.log(`\n✓ 启动包在预算内（余量 ${(BUDGET_KB - totalKb).toFixed(0)} KB）`);
