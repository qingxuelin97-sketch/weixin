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

describe('the gift planner is actually consulted', () => {
  it('considerGift runs in the foreground pass', () => {
    // A planner with no caller is the shape this repo keeps re-shipping:
    // `money-motive` would pass every one of its own tests while she never
    // sent anything, and the symptom ("she never gives me anything") is
    // indistinguishable from the planner correctly saying no.
    expect(
      runtime.includes('considerGift('),
      'considerGift 必须在前台 pass 里被调用，否则 AI 送礼整条线是死的。',
    ).toBe(true);
    expect(runtime.includes('considerGroupGift(')).toBe(true);
  });

  it('the delivery path is reachable from the handler bag', () => {
    expect(runtime.includes('runGift(')).toBe(true);
    expect(read('src/ai/handlers.ts').includes('d.runGift(')).toBe(true);
  });
});

describe('the AI authoring flows have an entry point', () => {
  it('a generated persona card is reachable from 新建好友', () => {
    // A generator with no way in is a module with tests and no users — the
    // exact shape of failure this whole file exists to catch.
    expect(read('src/features/contacts/NewContactPage.tsx').includes('/contact-new/ai')).toBe(true);
    expect(read('src/App.tsx').includes('/contact-new/ai')).toBe(true);
  });

  it('a generated group is reachable from 发起群聊', () => {
    expect(read('src/features/contacts/GroupCreatePage.tsx').includes('/group-new/ai')).toBe(true);
    expect(read('src/App.tsx').includes('/group-new/ai')).toBe(true);
  });

  it('one self-repair loop, not three', () => {
    // story-generate, persona-generate and group-generate all run the same
    // chain; three copies would be three places for the repair budget, the
    // JSON extraction and the failure reporting to drift apart.
    for (const f of ['story-generate', 'persona-generate', 'group-generate']) {
      expect(read(`src/ai/${f}.ts`).includes("from './generate-chain'")).toBe(true);
    }
  });
});

describe('an incoming call can actually reach the screen', () => {
  it('the overlay is mounted in the shell, not behind a route', () => {
    // A call you have to navigate to is not a call. This is also why the
    // `direction: "in"` branch in render-msg sat unreachable for two
    // milestones: there was a describer, and no way to produce one.
    expect(read('src/App.tsx').includes('<IncomingCall />')).toBe(true);
  });

  it('the planner and the handler are both wired', () => {
    expect(read('src/ai/gift-service.ts').includes('planCall(')).toBe(true);
    expect(runtime.includes('considerCall(')).toBe(true);
    expect(runtime.includes("registerHandler('ai_call'")).toBe(true);
  });
});

describe('the bubble types she never used are finally offered', () => {
  it('voice is proposed situationally, not just listed as legal', () => {
    // `voice` (M2) and `image` (M1) were both legal bubble types that nothing
    // ever produced, for the same reason: the base rules say the type exists,
    // and cannot say when a person would use one.
    expect(read('src/ai/engine.ts').includes('voiceDirective(')).toBe(true);
    expect(read('src/ai/engine.ts').includes('photoDirective(')).toBe(true);
  });

  it('she can post about the two of you', () => {
    expect(read('src/ai/moments-engine.ts').includes('aboutYouDirective(')).toBe(true);
  });
});

describe('drift is recorded, applied, and undoable', () => {
  it('something writes it', () => {
    expect(read('src/ai/engine.ts').includes('noteDrift(')).toBe(true);
    expect(runtime.includes('noteDrift(')).toBe(true);
  });

  it('something READS it — otherwise she drifts without behaving differently', () => {
    // The failure mode this guards is subtle: the delta accumulates, the state
    // page shows "她比刚认识时更主动了", and nothing about her actual pacing
    // changes. A visible number with no behaviour behind it is worse than no
    // feature, because it is a claim the app cannot back up.
    expect(runtime.includes('driftedPersona(')).toBe(true);
    expect(read('src/ai/gift-service.ts').includes('driftedPersona(')).toBe(true);
    expect(read('src/ai/moments-engine.ts').includes('driftedPersona(')).toBe(true);
  });

  it('the user can see it and undo it', () => {
    const page = read('src/features/settings/PersonaEditPage.tsx');
    expect(page.includes('explainDrift(')).toBe(true);
    expect(page.includes('resetDrift(')).toBe(true);
  });

  it('being ignored finally produces its affect event', () => {
    // `user_ignored` was defined and weighted in affect.ts since M-E3 with no
    // producer anywhere: the one negative signal the user generates by doing
    // NOTHING had never once fired.
    expect(runtime.includes("'user_ignored'")).toBe(true);
  });
});

describe('anti-AI-tone v2 runs on the output, not just in the prompt', () => {
  for (const file of ['src/ai/engine.ts', 'src/ai/group-engine.ts']) {
    it(`${file} scrubs and feeds back`, () => {
      // The v1 rules are static text; the whole point of v2 is that something
      // finally LOOKS at what came back. A version wired into only one of the
      // two engines would leave the group — where repetition is most visible,
      // because the lines are short and stacked — exactly as it was.
      const src = read(file);
      expect(src.includes('scrubBubbles(')).toBe(true);
      expect(src.includes('styleNote(')).toBe(true);
    });
  }
});

describe('the social graph reaches a surface the user can see', () => {
  it('arcs are read on the reply path, the opener path and Moments', () => {
    // M-E4's graph has been moving since it shipped and was invisible in all
    // three places. Wiring it to exactly one surface would be almost as bad:
    // an arc you can only see in a proactive message is an arc you will
    // usually miss.
    expect(read('src/ai/engine.ts').includes('arcAwareness(')).toBe(true);
    expect(read('src/ai/engine.ts').includes('freshArc(')).toBe(true);
    expect(read('src/ai/moments-engine.ts').includes('arcMomentDirective(')).toBe(true);
  });
});

describe('group pacing reaches the director', () => {
  const ge = read('src/ai/group-engine.ts');

  it('the director call carries the pacing block', () => {
    // `pacingDirective` computing a perfect answer that nobody passes along is
    // the same failure as the topic string it replaces: the room would still
    // never get bored, and every one of its own tests would still pass.
    expect(ge.includes('pacing: pacingDirective(')).toBe(true);
  });

  it('the topic row is folded, not overwritten', () => {
    // Overwriting is what made the topic ageless — with no `since` and no
    // `past` there is nothing to get bored of and nothing to avoid repeating.
    expect(ge.includes('advanceTopic(')).toBe(true);
    expect(
      /putSetting\(topicKey\([^)]*\), decision\.topicState/.test(ge),
      '话题不能再直接覆写字符串——那样它永远没有年龄，也就永远不会腻。',
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
