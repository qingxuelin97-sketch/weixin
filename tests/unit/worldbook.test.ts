import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  matchWorldbook,
  clampEntry,
  WORLDBOOK_MAX_ENTRIES,
  WORLDBOOK_CHAR_BUDGET,
  type WorldbookEntry,
} from '../../src/ai/worldbook';
import { repo } from '../../src/db/repo';

/**
 * 世界书 (M-I4): authored lore, matched not extracted. The two properties
 * worth locking are the BUDGET (a prolific author must not silently double
 * every prompt) and the SCOPE/TIER walls (someone else's lore, or full-tier
 * lore on an off-tier surface, must never fire).
 */

const T0 = 1_700_000_000_000;

const entry = (over: Partial<WorldbookEntry>): WorldbookEntry => ({
  id: `w_${Math.abs(JSON.stringify(over).length)}_${over.title ?? 'x'}`,
  title: 't',
  keywords: [],
  content: '内容',
  scope: 'global',
  priority: 50,
  enabled: true,
  createdAt: T0,
  ...over,
});

describe('matching', () => {
  it('keyworded entries need a hit; constant entries always fire in scope', () => {
    const es = [
      entry({ title: 'cat', keywords: ['年糕'], content: '她的猫叫年糕，很凶' }),
      entry({ title: 'city', keywords: [], content: '你们都住在杭州' }),
    ];
    expect(matchWorldbook(es, { query: '今天买菜' })).toEqual(['你们都住在杭州']);
    expect(matchWorldbook(es, { query: '年糕今天乖吗' })).toEqual(
      expect.arrayContaining(['她的猫叫年糕，很凶', '你们都住在杭州']),
    );
  });

  it('scope walls hold: persona lore never fires for someone else', () => {
    const es = [
      entry({ title: 'a', scope: 'persona', scopeId: 'ai_a', content: 'A 的设定' }),
      entry({ title: 'c', scope: 'conv', scopeId: 'conv_1', content: '这个群的设定' }),
    ];
    expect(matchWorldbook(es, { query: '', contactId: 'ai_b', convId: 'conv_2' })).toEqual([]);
    expect(matchWorldbook(es, { query: '', contactId: 'ai_a', convId: 'conv_1' })).toEqual(
      expect.arrayContaining(['A 的设定', '这个群的设定']),
    );
  });

  it('nsfw-flagged lore never rides an off-tier surface (rule #6 direction)', () => {
    const es = [entry({ title: 'x', nsfw: true, content: '成人设定' })];
    expect(matchWorldbook(es, { query: '', tier: 'off' })).toEqual([]);
    expect(matchWorldbook(es, { query: '', tier: 'ambiguous' })).toEqual(['成人设定']);
  });

  it('disabled entries are dead, and the budget caps count AND characters', () => {
    expect(matchWorldbook([entry({ enabled: false })], { query: '' })).toEqual([]);
    const many = Array.from({ length: 20 }, (_, i) =>
      entry({ title: `e${i}`, id: `w${i}`, content: `设定${i}`.padEnd(50, '。'), priority: i }),
    );
    const out = matchWorldbook(many, { query: '' });
    expect(out.length).toBeLessThanOrEqual(WORLDBOOK_MAX_ENTRIES);
    expect(out.join('').length).toBeLessThanOrEqual(WORLDBOOK_CHAR_BUDGET);
    // Highest priority survives the cut.
    expect(out[0]).toContain('设定19');
  });

  it('keyword hits outrank raw priority', () => {
    const es = [
      entry({ id: 'w1', title: 'hi', keywords: ['烧烤'], priority: 10, content: '老地方是后门烧烤摊' }),
      entry({ id: 'w2', title: 'lo', keywords: [], priority: 15, content: '常量背景' }),
    ];
    const out = matchWorldbook(es, { query: '走，老地方烧烤' });
    expect(out[0]).toBe('老地方是后门烧烤摊');
  });

  it('clamp bounds every authored field', () => {
    const c = clampEntry(
      entry({
        title: 'x'.repeat(100),
        content: 'y'.repeat(1000),
        keywords: Array.from({ length: 20 }, (_, i) => `k${i}`.repeat(30)),
        priority: 999,
      }),
    );
    expect(c.title.length).toBeLessThanOrEqual(20);
    expect(c.content.length).toBeLessThanOrEqual(200);
    expect(c.keywords.length).toBeLessThanOrEqual(8);
    expect(c.priority).toBe(100);
  });
});

describe('SillyTavern character_book mapping', () => {
  it('imports the book that used to be silently dropped', async () => {
    const { importStCard } = await import('../../src/ai/sillytavern');
    const card = importStCard(
      {
        spec: 'chara_card_v2',
        spec_version: '2.0',
        data: {
          name: '小雨',
          description: '插画师',
          character_book: {
            entries: [
              { keys: ['年糕'], content: '{{char}}的猫叫年糕', enabled: true, insertion_order: 10 },
              { keys: [], content: '大家都在杭州', constant: true },
              { keys: ['skip'], content: '', enabled: true }, // empty → skipped
              { keys: ['off'], content: '停用的', enabled: false }, // disabled → skipped
            ],
          },
        },
      },
      'ai_x',
    );
    expect(card).not.toBeNull();
    expect(card!.worldbook).toHaveLength(2);
    expect(card!.worldbook[0].content).toBe('小雨的猫叫年糕'); // macro expanded
    expect(card!.worldbook[0].scope).toBe('persona');
    expect(card!.worldbook[0].scopeId).toBe('ai_x');
    expect(card!.worldbook[1].keywords).toEqual([]); // constant → keywordless
    expect(card!.notes.some((n) => n.includes('世界书'))).toBe(true);
  });

  it('round-trips: export carries the book back out', async () => {
    const { exportStCard } = await import('../../src/ai/sillytavern');
    const { makePersona } = await import('../../src/data/persona-defaults');
    const card = exportStCard('小雨', makePersona({ contactId: 'ai_x', core: 'c' }), {}, [
      entry({ title: '猫', keywords: ['年糕'], content: '她的猫叫年糕' }),
    ]);
    const book = card.data.character_book as { entries: Array<Record<string, unknown>> };
    expect(book.entries).toHaveLength(1);
    expect(book.entries[0].keys).toEqual(['年糕']);
    expect(book.entries[0].comment).toBe('猫');
    // No entries → no empty book key polluting the card.
    const bare = exportStCard('x', makePersona({ contactId: 'a', core: 'c' }));
    expect('character_book' in bare.data).toBe(false);
  });
});

describe('storage + wiring', () => {
  it('round-trips through the repo', async () => {
    const e = entry({ id: 'w_rt', title: '往返', content: '存得住' });
    await repo.putWorldbookEntry(e);
    const all = await repo.getWorldbook();
    expect(all.find((x) => x.id === 'w_rt')?.content).toBe('存得住');
    await repo.deleteWorldbookEntry('w_rt');
    expect((await repo.getWorldbook()).find((x) => x.id === 'w_rt')).toBeUndefined();
  });

  it('both chat engines actually inject it (写了没接线 = 没做)', () => {
    for (const f of ['src/ai/engine.ts', 'src/ai/group-engine.ts']) {
      const src = readFileSync(resolve(__dirname, '../..', f), 'utf8');
      expect(src.includes('worldLinesFor'), `${f} does not consult the worldbook`).toBe(true);
    }
    // And the render sits INSIDE the memory layer, not as a new block.
    const prompt = readFileSync(resolve(__dirname, '../../src/ai/prompt.ts'), 'utf8');
    expect(prompt).toContain('memory.world');
    expect(prompt.includes('# 世界书')).toBe(false);
  });
});
