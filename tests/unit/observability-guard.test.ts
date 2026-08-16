import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Load-bearing catches must LOG (M-I11).
 *
 * Most silent catches in this repo are correct: a failed mood write or a
 * best-effort cache eviction should never break a turn, and the comment beside
 * each says so. These four are different — each one wraps a whole FEATURE, and
 * swallowing its error makes "the feature is dead" indistinguishable from
 * "nothing happened to be scheduled":
 *
 *   backfill      — offline world evolution, and it makes LLM calls
 *   notify.sync   — the app's only presence while it is closed
 *   agentdm.seed  — the entire AI↔AI chemistry layer
 *   dismiss.close — a throwing overlay presents as "back button does nothing"
 *
 * The plugin-proxy bug that cost three weeks of dead device builds was hidden
 * by exactly this shape of catch, which is why it is a test and not a habit.
 */
const ROOT = join(__dirname, '..', '..');

function src(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

/** Body of the catch that follows the first occurrence of `anchor`. */
function catchAfter(source: string, anchor: string): string {
  const at = source.indexOf(anchor);
  expect(at, `anchor not found: ${anchor}`).toBeGreaterThan(-1);
  const c = source.indexOf('catch', at);
  expect(c, `no catch after: ${anchor}`).toBeGreaterThan(-1);
  const open = source.indexOf('{', c);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(open, i);
  }
  throw new Error(`unbalanced catch after: ${anchor}`);
}

describe('feature-level catches log instead of swallowing', () => {
  const cases: Array<[label: string, file: string, anchor: string, scope: string]> = [
    ['backfill', 'src/app/useSchedulerRuntime.ts', 'await runBackfill(', "logError('backfill'"],
    [
      'notify sync',
      'src/app/useSchedulerRuntime.ts',
      'await syncNotifications(',
      "logError('notify.sync'",
    ],
    [
      'agent-dm seeding',
      'src/app/useSchedulerRuntime.ts',
      'await scheduleNextAgentDm()',
      "logError('agentdm.seed'",
    ],
    ['dismiss close', 'src/app/dismiss-stack.ts', 'top.close()', "logError('dismiss.close'"],
  ];

  for (const [label, file, anchor, scope] of cases) {
    it(`${label} reports through errlog`, () => {
      expect(catchAfter(src(file), anchor)).toContain(scope);
    });
  }
});
