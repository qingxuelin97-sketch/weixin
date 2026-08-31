import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { withConvSummary } from '../../src/ai/memory';
import {
  simulate,
  LIMITS,
  MAX_BACKFILL,
  type SimContact,
  type SimGroup,
  type SimInput,
} from '../../src/ai/simulate';
import {
  matchWorldbook,
  WORLDBOOK_MAX_ENTRIES,
  WORLDBOOK_CHAR_BUDGET,
  WORLDBOOK_FUZZY_MAX,
  type WorldbookEntry,
} from '../../src/ai/worldbook';
import { makePersona } from '../../src/data/persona-defaults';
import type { PersonaVM } from '../../src/data/types';

/**
 * M-I18 — three things the plan promised that a line-by-line audit found were
 * never actually wired:
 *
 *   1. groups never READ `conv_summaries`, though the writer covered them;
 *   2. `simulate()` could not plan a gift or any of the I3 social kinds, so an
 *      absence was a window in which none of them could happen — and they also
 *      escaped the offline budget entirely;
 *   3. the worldbook matched keywords by exact substring only, so lore about
 *      「年糕」 sat silent through a conversation about 你家猫.
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const src = (rel: string) => readFileSync(resolve(__dirname, '../..', rel), 'utf8');

/* ==================================================================== */

describe('群聊读会话摘要 (写了没接线)', () => {
  it('prefixes the summary onto the retrieved facts, per surface', () => {
    expect(withConvSummary(['事实A'], '昨天在聊装修', 'group')).toEqual([
      '上次群里聊到：昨天在聊装修',
      '事实A',
    ]);
    expect(withConvSummary(['事实A'], '昨天在聊装修', 'single')[0]).toContain('上次你们聊到');
  });

  it('says nothing when there is no summary — an empty line is worse than none', () => {
    const facts = ['事实A'];
    expect(withConvSummary(facts, undefined, 'group')).toBe(facts);
    expect(withConvSummary(facts, '   ', 'group')).toBe(facts);
  });

  it('BOTH engines read the row and use the shared injector', () => {
    for (const f of ['src/ai/engine.ts', 'src/ai/group-engine.ts']) {
      const code = src(f);
      expect(code, `${f} never reads conv_summaries`).toContain('getConvSummary');
      expect(code, `${f} hand-rolls the summary line`).toContain('withConvSummary');
    }
  });

  it('the summary rides INSIDE the memory layer, never as a new prompt layer', () => {
    // The six-layer order is fixed by the constitution; a summary block of its
    // own would be layer seven.
    expect(src('src/ai/group-engine.ts')).toContain('memory.topK = withConvSummary');
  });
});

/* ==================================================================== */

describe('simulate 覆盖 gift 与 I3 社交 kind', () => {
  const NOON = new Date(2026, 4, 11, 12, 0, 0).getTime();

  const single = (id: string, over: Partial<PersonaVM> = {}, lastMsgAt = NOON - 30 * HOUR): SimContact => ({
    contactId: id,
    convId: `conv_${id}`,
    persona: makePersona({ contactId: id, core: 'c', generosity: 1, proactivity: 0.6, ...over }),
    lastMsgAt,
    gift: { affinity: 90 },
  });

  const group = (convId: string, memberIds: string[]): SimGroup => ({
    convId,
    memberIds,
    lastMsgAt: NOON - 30 * HOUR,
  });

  /** A 72h absence: long enough that all three planners get a real window. */
  const away = (input: SimInput, seed: string) => simulate(NOON - 72 * HOUR, NOON, input, seed);

  it('a three-day absence can now contain a gift', () => {
    let found = false;
    for (let i = 0; i < 40 && !found; i++) {
      const plan = away({ singles: [single(`p${i}`)], groups: [] }, `s${i}`);
      for (const e of plan.events.filter((x) => x.kind === 'ai_money')) {
        found = true;
        // The envelope the live `ai_money` handler reads, not a placeholder.
        expect(e.payload!.amountFen).toBeGreaterThan(0);
        expect(Number.isInteger(e.payload!.amountFen)).toBe(true); // rule #3: fen
        expect(String(e.payload!.line ?? '').length).toBeGreaterThan(0);
        // …under the SAME id the live pass would mint, or the actionExists
        // guard three lines later would send a second one.
        expect(e.id).toMatch(/^gift_conv_p\d+_\d+$/);
        expect(e.at).toBeGreaterThan(plan.from);
        expect(e.at).toBeLessThanOrEqual(plan.to);
      }
    }
    expect(found, 'no seed in 40 produced an offline gift').toBe(true);
  });

  it('at most one gift per absence, however the dice fall', () => {
    const many = Array.from({ length: 12 }, (_, i) => single(`q${i}`));
    for (let i = 0; i < 30; i++) {
      const plan = away({ singles: many, groups: [] }, `g${i}`);
      expect(plan.events.filter((e) => e.kind === 'ai_money').length).toBeLessThanOrEqual(
        LIMITS.gifts,
      );
    }
  });

  it('a 聚会 can be proposed while you are away, under the live stable id', () => {
    let found = false;
    for (let i = 0; i < 60 && !found; i++) {
      const plan = away({ singles: [], groups: [group(`gc${i}`, ['a', 'b', 'c', 'd'])] }, `e${i}`);
      for (const e of plan.events.filter((x) => x.kind === 'group_event')) {
        found = true;
        expect(e.id).toBe(`gevt_gc${i}_${Math.floor(plan.from / (7 * DAY))}_propose`);
        expect(e.payload!.phase).toBe('propose');
        expect(['a', 'b', 'c', 'd']).toContain(e.contactId);
        expect(e.at).toBeGreaterThan(plan.from);
        expect(e.at).toBeLessThanOrEqual(plan.to);
      }
    }
    expect(found, 'no seed in 60 produced an offline 聚会').toBe(true);
  });

  it('a 拉群 proposal can be planned offline too', () => {
    let found = false;
    for (let i = 0; i < 80 && !found; i++) {
      const her = single(`h${i}`, { relations: { user: '老友', [`f1_${i}`]: '同学', [`f2_${i}`]: '同事' } });
      const input: SimInput = {
        singles: [her, single(`f1_${i}`), single(`f2_${i}`)],
        groups: [],
        groupRosters: [],
      };
      for (const e of away(input, `i${i}`).events.filter((x) => x.kind === 'agent_invite')) {
        found = true;
        expect(e.id).toMatch(/^ainv_/);
        expect(e.payload!.friend1).toBeTruthy();
        expect(e.payload!.friend2).not.toBe(e.payload!.friend1);
      }
    }
    expect(found, 'no seed in 80 produced an offline 拉群提议').toBe(true);
  });

  it('a trio already sharing a room is never proposed one', () => {
    for (let i = 0; i < 80; i++) {
      const her = single(`h${i}`, { relations: { [`f1_${i}`]: '同学', [`f2_${i}`]: '同事' } });
      const input: SimInput = {
        singles: [her, single(`f1_${i}`), single(`f2_${i}`)],
        groups: [],
        groupRosters: [[`h${i}`, `f1_${i}`, `f2_${i}`]],
      };
      expect(away(input, `i${i}`).events.some((e) => e.kind === 'agent_invite')).toBe(false);
    }
  });

  it('the new kinds answer to the window budget instead of bypassing it', () => {
    const many = Array.from({ length: 20 }, (_, i) => single(`b${i}`, { momentsPerDay: 4 }));
    const groups = Array.from({ length: 6 }, (_, i) => group(`bg${i}`, ['a', 'b', 'c', 'd']));
    for (let i = 0; i < 20; i++) {
      const plan = away({ singles: many, groups }, `bud${i}`);
      expect(plan.events.length).toBeLessThanOrEqual(LIMITS.events);
      // Only the kinds that actually make a network call spend the call budget.
      const paid = plan.events.filter(
        (e) => e.kind !== 'moment_like' && e.kind !== 'ai_money' && e.kind !== 'agent_invite',
      );
      expect(paid.length).toBeLessThanOrEqual(LIMITS.llmCalls);
      expect(
        plan.events.filter((e) => e.kind === 'group_event' || e.kind === 'agent_invite').length,
      ).toBeLessThanOrEqual(LIMITS.socialPlans);
    }
  });

  it('never stamps a new kind behind that conversation’s last message', () => {
    // The rowid-order == time-order invariant, for the kinds added here.
    const lastMsgAt = NOON - 3 * HOUR;
    for (let i = 0; i < 40; i++) {
      const plan = away(
        {
          singles: [single(`z${i}`, {}, lastMsgAt)],
          groups: [{ convId: `zg${i}`, memberIds: ['a', 'b', 'c', 'd'], lastMsgAt }],
        },
        `f${i}`,
      );
      for (const e of plan.events) {
        if (!e.convId) continue;
        expect(e.at, `${e.kind} landed behind the conversation`).toBeGreaterThan(lastMsgAt);
      }
    }
  });

  it('stays deterministic and inside the truncated window', () => {
    const input: SimInput = {
      singles: [single('d1'), single('d2')],
      groups: [group('dg', ['a', 'b', 'c', 'd'])],
    };
    const a = away(input, 'det');
    const b = away(input, 'det');
    expect(a).toEqual(b);
    expect(a.truncated).toBe(true);
    expect(a.to - a.from).toBe(MAX_BACKFILL);
  });

  it('backfill materialises the live id and the live payload', () => {
    const code = src('src/ai/backfill.ts');
    expect(code).toContain('ev.id ??');
    expect(code).toContain('...(ev.payload ?? {})');
  });

  it('simulate is still a pure function — no clock, no dice, no storage', () => {
    const code = src('src/ai/simulate.ts');
    expect(code).not.toMatch(/Date\.now/);
    expect(code).not.toMatch(/Math\.random/);
    expect(code).not.toMatch(/from '\.\.\/db\/repo'/);
  });
});

/* ==================================================================== */

describe('世界书近似匹配', () => {
  const T0 = 1_700_000_000_000;
  const entry = (over: Partial<WorldbookEntry>): WorldbookEntry => ({
    id: `w_${over.title ?? 'x'}`,
    title: 't',
    keywords: [],
    content: '内容',
    scope: 'global',
    priority: 50,
    enabled: true,
    createdAt: T0,
    ...over,
  });

  const cat = entry({ id: 'w1', title: '猫', keywords: ['年糕'], content: '她的猫叫年糕，很凶' });
  const bbq = entry({ id: 'w2', title: '老地方', keywords: ['老地方'], content: '老地方是学校后门的烧烤摊' });
  const city = entry({ id: 'w3', title: '城市', keywords: ['杭州'], content: '你们都住在杭州' });
  const es = [cat, bbq, city];

  it('近似命中: lore keyed on 年糕 now fires for 你家猫', () => {
    // The exact-substring model had this entry silent for the whole
    // conversation — the one it was written for.
    expect(matchWorldbook(es, { query: '你家猫最近还好吗' })).toContain(cat.content);
  });

  it('近似命中: 后门那家烧烤 reaches the 老地方 entry', () => {
    expect(matchWorldbook(es, { query: '晚上去后门那家烧烤吧' })).toContain(bbq.content);
  });

  it('off-topic chat still injects nothing — approximate is not "always"', () => {
    for (const q of ['今天买菜了', '周末一起吃饭吗', '嗯', '我在的时候他说的', '哈哈哈']) {
      expect(matchWorldbook(es, { query: q }), q).toEqual([]);
    }
  });

  it('the two-tier model is intact: keywordless = constant, exact still exact', () => {
    const constant = entry({ id: 'w4', keywords: [], content: '你们都在同一个城市' });
    expect(matchWorldbook([cat, constant], { query: '完全无关的话' })).toEqual([constant.content]);
    expect(matchWorldbook([cat, constant], { query: '年糕今天乖吗' })).toEqual(
      expect.arrayContaining([cat.content, constant.content]),
    );
  });

  it('exact and constant hits always outrank approximate ones', () => {
    // `city` matches 杭州 exactly; `cat` only approximately, via 猫.
    const out = matchWorldbook(es, { query: '你家猫在杭州住得惯吗' });
    expect(out[0]).toBe(city.content);
    expect(out).toContain(cat.content);
  });

  it('approximate matches are capped on their own, and by the shared budget', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      entry({
        id: `f${i}`,
        title: `f${i}`,
        keywords: [`触发词${i}`],
        content: `她养的猫很怕生，编号${i}`.padEnd(60, '。'),
      }),
    );
    const out = matchWorldbook(many, { query: '你家猫最近还好吗' });
    expect(out.length).toBeLessThanOrEqual(WORLDBOOK_FUZZY_MAX);
    expect(out.length).toBeLessThanOrEqual(WORLDBOOK_MAX_ENTRIES);
    expect(out.join('').length).toBeLessThanOrEqual(WORLDBOOK_CHAR_BUDGET);
  });

  it('scope and tier walls hold for the approximate tier too', () => {
    const other = entry({
      id: 'w5',
      keywords: ['触发'],
      scope: 'persona',
      scopeId: 'ai_a',
      content: '她的猫叫年糕',
    });
    const adult = entry({ id: 'w6', keywords: ['触发'], nsfw: true, content: '她的猫叫年糕' });
    expect(matchWorldbook([other], { query: '你家猫呢', contactId: 'ai_b' })).toEqual([]);
    expect(matchWorldbook([adult], { query: '你家猫呢', tier: 'off' })).toEqual([]);
  });

  it('reuses the memory retriever rather than growing a second one', () => {
    const code = src('src/ai/worldbook.ts');
    expect(code).toContain("from './entity-graph'");
    expect(code).toMatch(/\btrigrams\b/);
    expect(code).toMatch(/\bbm25\b/);
  });
});
