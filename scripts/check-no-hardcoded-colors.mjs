#!/usr/bin/env node
/**
 * Constitution guard: no raw color literals in component CSS/TSX.
 * All colors MUST go through the semantic tokens in src/styles/tokens.css
 * so a single dark-mode token swap (V3) recolors the whole app.
 *
 * Allowed: src/styles/tokens.css (the one place literals are declared),
 *          `transparent`, `currentColor`, `inherit`, and rgba(var(--...)).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SRC = join(ROOT, 'src');
const TOKEN_FILE = join(SRC, 'styles', 'tokens.css');

// Directories whose color literals are DATA, not design tokens:
//   data/   → placeholder avatar tints (content, replaced by PNG library)
// Everything else must reference semantic tokens.
const EXEMPT_DIRS = [join(SRC, 'data')];

// hex colors (#fff / #ffffff / #ffffffff) and raw rgb()/hsl() functional literals
const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const RGB_HSL = /\b(?:rgb|hsl)a?\(\s*\d/g;

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  /** @type {string[]} */
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (['.css', '.ts', '.tsx'].includes(extname(p))) out.push(p);
  }
  return out;
}

/** Blank out /* … *​/ and // comments across the whole file, preserving newlines
 *  (so line numbers stay accurate) — colors mentioned in comments are docs, not code. */
function blankComments(text) {
  let out = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
  out = out.replace(/\/\/[^\n]*/g, (m) => ' '.repeat(m.length));
  return out;
}

const violations = [];
for (const file of walk(SRC)) {
  if (file === TOKEN_FILE) continue;
  if (EXEMPT_DIRS.some((d) => file.startsWith(d + '/'))) continue;
  const code = blankComments(readFileSync(file, 'utf8'));
  code.split('\n').forEach((line, i) => {
    for (const re of [HEX, RGB_HSL]) {
      re.lastIndex = 0;
      if (re.test(line)) {
        violations.push(`${relative(ROOT, file)}:${i + 1}  ${line.trim()}`);
        break;
      }
    }
  });
}

if (violations.length) {
  console.error('\n✗ Hardcoded color literals found (use semantic tokens from src/styles/tokens.css):\n');
  console.error(violations.join('\n'));
  console.error(`\n${violations.length} violation(s). Add a token instead of a raw color.\n`);
  process.exit(1);
}
console.log('✓ No hardcoded colors — all colors go through tokens.');
