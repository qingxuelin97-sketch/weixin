import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SCHEDULED_ACTION_KINDS } from '../../src/db/schema';
import { STORES } from '../../src/db/idb';

/**
 * Wiring guards (M-G0).
 *
 * This repository's most expensive bugs have all been the same shape: code
 * that exists, has tests, and is never reached. The M4 heartbeat handler was
 * never registered. `extractMemory` shipped with zero callers. `notify.ts` was
 * dead for a milestone. `hasEscapelessCycle` was written, tested, and never
 * called by the validator it was written for. And `story_tick` was registered
 * with a plain `registerHandler` directly beneath a comment claiming it was
 * chained — which turned one LLM timeout into a permanently dead story.
 *
 * Behavioural tests cannot catch these: the unreached code passes its own unit
 * tests perfectly. So this file asserts the WIRING, by reading the source. It
 * is deliberately crude — a grep with a rationale — because the alternative is
 * mounting the whole React runtime to discover that a string is missing.
 */

const root = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

const runtime = read('src/app/useSchedulerRuntime.ts');

/**
 * Kinds that queue their own successor. For these the successor MUST be
 * enqueued before the work that can fail, or one failure ends the chain
 * forever — there is nothing left to re-trigger it.
 */
const SELF_CHAINING = ['heartbeat', 'agent_dm', 'moment_post', 'story_tick'] as const;

describe('self-chaining kinds are actually chained', () => {
  for (const kind of SELF_CHAINING) {
    it(`${kind} uses registerChainedHandler, not registerHandler`, () => {
      expect(
        runtime.includes(`registerChainedHandler('${kind}'`),
        `${kind} 是自续链 kind，必须用 registerChainedHandler（先续链后干活）。` +
          `用普通 registerHandler 时，work 抛一次错这条链就永远断了——` +
          `story_tick 就是这么让剧情永久卡死的。`,
      ).toBe(true);
      expect(
        runtime.includes(`registerHandler('${kind}'`),
        `${kind} 同时还有一个普通 registerHandler 注册，两者会互相覆盖。`,
      ).toBe(false);
    });
  }
});

describe('every scheduled-action kind has a handler', () => {
  // Reserved-but-unimplemented kinds are legitimate; they just must be listed
  // here on purpose rather than discovered as a silent hole in production.
  const RESERVED: readonly string[] = [];

  for (const kind of SCHEDULED_ACTION_KINDS) {
    it(`${kind} is registered`, () => {
      const registered =
        runtime.includes(`registerHandler('${kind}'`) ||
        runtime.includes(`registerChainedHandler('${kind}'`);
      if (RESERVED.includes(kind)) {
        expect(registered, `${kind} 被列为预留 kind，却已经注册了 handler——更新 RESERVED`).toBe(
          false,
        );
        return;
      }
      expect(
        registered,
        `${kind} 在 SCHEDULED_ACTION_KINDS 里，但没有任何 handler 注册——` +
          `enqueue 出去的行会被执行器取出、标记完成，然后什么都不做。`,
      ).toBe(true);
    });
  }
});

describe('the story beat does not schedule itself from inside its own work', () => {
  it('runStoryBeat leaves scheduling to the chain', () => {
    const svc = read('src/ai/story-service.ts');
    const work = svc.slice(svc.indexOf('export async function runStoryBeat'));
    expect(
      work.includes('scheduleNextBeat('),
      'runStoryBeat 不能自己排下一拍——那样 playBeat 一抛错就再也没有下一拍了。' +
        '排期归 chainNextBeat（先续链后干活）。',
    ).toBe(false);
  });
});

/**
 * Declared indexes must have a reader.
 *
 * `bySubject`, `byStatus` and `byRp` all shipped with the schema and were
 * never used — the queries they existed for did `getAll()` and filtered in JS
 * instead. That is invisible in review (the code reads fine) and invisible in
 * tests (the results are right); it surfaces months later as an app that got
 * slow. An index nobody reads is either a missing optimisation or dead weight,
 * and both are worth a red test.
 */
describe('every declared index has a reader', () => {
  const src = [
    read('src/db/repo.ts'),
    read('src/db/idb.ts'),
    read('src/ai/scheduler.ts'),
  ].join('\n');

  for (const store of STORES) {
    for (const idx of store.indexes ?? []) {
      it(`${store.name}.${idx.name} is queried somewhere`, () => {
        expect(
          src.includes(`'${idx.name}'`),
          `索引 ${store.name}.${idx.name} 声明了但没有任何查询用它——` +
            `要么接上（省一次全表扫），要么删掉（省一份写入开销）。`,
        ).toBe(true);
      });
    }
  }
});
