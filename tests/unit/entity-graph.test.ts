import { describe, it, expect } from 'vitest';
import {
  trigrams,
  termFreq,
  encodeVector,
  decodeVector,
  buildCorpus,
  bm25,
  stability,
  retention,
  isForgotten,
  entityOf,
  groupByEntity,
  predicateOf,
  findSuperseded,
  rankFacts,
  selectForInjection,
  UNGROUPED,
  BASE_STABILITY_MS,
} from '../../src/ai/entity-graph';
import type { MemoryFactVM } from '../../src/data/types';

/**
 * Memory with structure and a real forgetting curve (M-E2).
 *
 * The three things the flat list could not do, each pinned down here:
 * retrieval that depends on the conversation, contradictions that retire the
 * old fact instead of coexisting with it, and forgetting whose rate depends on
 * whether the memory is ever actually used.
 */

const T0 = 1_755_100_000_000;
const DAY = 86_400_000;

function fact(over: Partial<MemoryFactVM> & Pick<MemoryFactVM, 'fact'>): MemoryFactVM {
  return {
    id: over.id ?? `f_${over.fact}`,
    subjectId: 'ai_lin',
    importance: 3,
    sensitivity: 'normal',
    evidenceMsgIds: [1],
    status: 'confirmed',
    isPinned: false,
    createdAt: T0,
    confidence: 0.9,
    refCount: 0,
    ...over,
  };
}

/* ------------------------------------------------------------------ */

describe('trigrams (the tokenizer we can ship)', () => {
  it('produces overlapping windows so a substring query still matches', () => {
    const t = trigrams('他搬到成都了');
    expect(t).toContain('到成都');
    expect(t).toContain('成都');
  });

  it('keeps Latin words and numbers whole and case-folded', () => {
    const t = trigrams('用了 iPhone 15');
    expect(t).toContain('iphone');
    expect(t).toContain('15');
  });

  it('ignores punctuation, which carries no retrieval signal', () => {
    expect(termFreq('喜欢，咖啡！')).toEqual(termFreq('喜欢咖啡'));
  });

  it('handles very short facts without producing nothing', () => {
    expect(trigrams('爱吃辣').length).toBeGreaterThan(0);
    expect(trigrams('好').length).toBeGreaterThan(0);
    expect(trigrams('')).toEqual([]);
    expect(trigrams('！？。')).toEqual([]);
  });
});

describe('vector encoding round-trips through the embedding column', () => {
  it('survives encode → decode intact', () => {
    const text = '他妹妹在上海读研究生';
    expect(decodeVector(encodeVector(text))).toEqual(termFreq(text));
  });

  it('treats a corrupt or absent column as empty rather than throwing', () => {
    expect(decodeVector(undefined).size).toBe(0);
    expect(decodeVector('').size).toBe(0);
    expect(() => decodeVector('garbage|:|::|x:NaN')).not.toThrow();
    expect(decodeVector('好:2|坏:notanumber').get('好')).toBe(2);
  });
});

describe('BM25 retrieval', () => {
  const facts = [
    fact({ id: 'f1', fact: '他妹妹在上海读研究生' }),
    fact({ id: 'f2', fact: '他喜欢喝手冲咖啡' }),
    fact({ id: 'f3', fact: '他讨厌加班' }),
  ];

  it('scores the on-topic fact above the others', () => {
    const corpus = buildCorpus(facts);
    const q = termFreq('你妹妹最近怎么样');
    expect(bm25(corpus, 'f1', q)).toBeGreaterThan(bm25(corpus, 'f2', q));
    expect(bm25(corpus, 'f1', q)).toBeGreaterThan(bm25(corpus, 'f3', q));
  });

  it('scores zero when nothing overlaps', () => {
    const corpus = buildCorpus(facts);
    expect(bm25(corpus, 'f2', termFreq('量子力学'))).toBe(0);
  });

  it('uses a stored vector when present and recomputes when absent', () => {
    const stored = fact({ id: 's', fact: '占位', embedding: encodeVector('他妹妹在上海') });
    const corpus = buildCorpus([stored]);
    // The stored vector wins over the (unrelated) text — that is what makes an
    // older row without an embedding merely slower, never wrong.
    expect(bm25(corpus, 's', termFreq('妹妹'))).toBeGreaterThan(0);
  });
});

describe('forgetting curve', () => {
  it('a pinned fact is never forgotten, at any age', () => {
    const f = fact({ fact: 'x', isPinned: true, createdAt: T0 - 3650 * DAY });
    expect(stability(f)).toBe(Infinity);
    expect(retention(f, T0)).toBe(1);
    expect(isForgotten(f, T0)).toBe(false);
  });

  it('use makes a memory durable — the whole point of the change', () => {
    const old = T0 - 60 * DAY;
    const unused = fact({ id: 'a', fact: 'x', createdAt: old, lastRefAt: old, refCount: 0 });
    const used = fact({ id: 'b', fact: 'x', createdAt: old, lastRefAt: old, refCount: 20 });
    expect(stability(used)).toBeGreaterThan(stability(unused) * 2);
    expect(retention(used, T0)).toBeGreaterThan(retention(unused, T0));
  });

  it('re-reference resets the clock (age counts from lastRefAt)', () => {
    const born = T0 - 300 * DAY;
    const stale = fact({ id: 'a', fact: 'x', createdAt: born });
    const refreshed = fact({ id: 'b', fact: 'x', createdAt: born, lastRefAt: T0 - DAY });
    expect(isForgotten(stale, T0)).toBe(true);
    expect(isForgotten(refreshed, T0)).toBe(false);
  });

  it('hearsay is less durable than firsthand knowledge', () => {
    const gossip = fact({ id: 'g', fact: 'x', confidence: 0.4, source: 'hearsay' });
    const direct = fact({ id: 'd', fact: 'x', confidence: 0.9 });
    expect(stability(gossip)).toBeLessThan(stability(direct));
  });

  it('importance stretches the curve proportionally', () => {
    const low = fact({ id: 'l', fact: 'x', importance: 1 });
    const high = fact({ id: 'h', fact: 'x', importance: 5 });
    expect(stability(high) / stability(low)).toBeCloseTo(5, 5);
  });

  it('survives a NaN importance rather than producing NaN retention', () => {
    const broken = fact({ fact: 'x', importance: Number.NaN });
    expect(Number.isFinite(stability(broken))).toBe(true);
    expect(retention(broken, T0)).toBeGreaterThan(0);
  });

  it('is calibrated near the old 30-day half-life for an ordinary fact', () => {
    const f = fact({ fact: 'x', importance: 3, confidence: 0.9, createdAt: T0 - 30 * DAY });
    expect(retention(f, T0)).toBeGreaterThan(0.4);
    expect(retention(f, T0)).toBeLessThan(0.6);
    expect(BASE_STABILITY_MS).toBeGreaterThan(0);
  });
});

describe('entities', () => {
  it('picks the subject out of common fact shapes', () => {
    expect(entityOf('他妹妹的生日是三月')).toBe('他妹妹');
    expect(entityOf('和Ada聊到：他换了工作')).toBe('Ada');
    expect(entityOf('听小雨说：他最近在准备面试')).toBe('小雨');
  });

  it('returns nothing rather than guessing — a wrong entity is worse than none', () => {
    expect(entityOf('')).toBeUndefined();
    expect(entityOf('嗯')).toBeUndefined();
    expect(entityOf('今天天气不错')).toBeUndefined();
  });

  it('groups for the memory page with a stable, non-reshuffling order', () => {
    const facts = [
      fact({ id: '1', fact: '他妹妹在上海', aboutId: '他妹妹' }),
      fact({ id: '2', fact: '他妹妹读研究生', aboutId: '他妹妹' }),
      fact({ id: '3', fact: '公司在张江', aboutId: '公司' }),
      fact({ id: '4', fact: '随便一句没有主语的话' }),
    ];
    const groups = groupByEntity(facts);
    expect(groups[0].entity).toBe('他妹妹');
    expect(groups[0].facts).toHaveLength(2);
    // Facts with no clear subject always land last, never interleaved.
    expect(groups.at(-1)?.entity).toBe(UNGROUPED);
    expect(groupByEntity(facts)).toEqual(groups); // deterministic
  });
});

describe('contradictions supersede, coexistence does not', () => {
  it('a move retires the old residence', () => {
    const old = fact({ id: 'old', fact: '他住在北京', aboutId: '他', createdAt: T0 - 10 * DAY });
    const fresh = fact({ id: 'new', fact: '他搬到成都了', aboutId: '他', createdAt: T0 });
    const { superseded } = findSuperseded([old], fresh);
    expect(superseded.map((f) => f.id)).toEqual(['old']);
  });

  it('liking two things is NOT a contradiction', () => {
    // Treating preferences as exclusive would silently delete half of what a
    // persona knows about you — the most damaging possible false positive.
    const a = fact({ id: 'a', fact: '他喜欢咖啡', aboutId: '他' });
    const b = fact({ id: 'b', fact: '他喜欢茶', aboutId: '他', createdAt: T0 + DAY });
    expect(findSuperseded([a], b).superseded).toEqual([]);
  });

  it('two different people living in two cities are both right', () => {
    const lin = fact({ id: 'lin', fact: '小雨住在北京', aboutId: '小雨' });
    const ada = fact({ id: 'ada', fact: 'Ada住在成都', aboutId: 'Ada', createdAt: T0 + DAY });
    expect(findSuperseded([lin], ada).superseded).toEqual([]);
  });

  it('never overrules a fact the user pinned', () => {
    const pinned = fact({ id: 'p', fact: '他住在北京', aboutId: '他', isPinned: true });
    const fresh = fact({ id: 'n', fact: '他搬到成都了', aboutId: '他', createdAt: T0 + DAY });
    expect(findSuperseded([pinned], fresh).superseded).toEqual([]);
  });

  it('does not resurrect an already-archived row', () => {
    const archived = fact({ id: 'a', fact: '他住在北京', aboutId: '他', status: 'archived' });
    const fresh = fact({ id: 'n', fact: '他搬到成都了', aboutId: '他', createdAt: T0 + DAY });
    expect(findSuperseded([archived], fresh).superseded).toEqual([]);
  });

  it('recognises the exclusive slots and only those', () => {
    expect(predicateOf('他搬到成都了')).toBe('residence');
    expect(predicateOf('他入职了字节')).toBe('workplace');
    expect(predicateOf('他们分手了')).toBe('relationship');
    expect(predicateOf('他喜欢咖啡')).toBeUndefined();
    expect(predicateOf('上周一起看了电影')).toBeUndefined();
  });
});

describe('ranking and selection', () => {
  const facts = [
    fact({ id: 'sister', fact: '他妹妹在上海读研究生', importance: 3 }),
    fact({ id: 'coffee', fact: '他喜欢喝手冲咖啡', importance: 4 }),
    fact({ id: 'work', fact: '他讨厌加班', importance: 3 }),
  ];

  it('lets the conversation topic outrank raw importance', () => {
    // Without a query, 'coffee' wins on importance alone. With one, the fact
    // about the thing you are actually discussing comes first — which is the
    // entire reason retrieval exists.
    expect(rankFacts(facts, T0)[0].fact.id).toBe('coffee');
    expect(rankFacts(facts, T0, { query: '你妹妹研究生读得怎么样' })[0].fact.id).toBe('sister');
  });

  it('degrades to importance × retention when there is no query', () => {
    const ranked = rankFacts(facts, T0);
    expect(ranked.every((r) => r.parts.topical === 0)).toBe(true);
  });

  it('is deterministic and stable — the prompt prefix must stay cacheable', () => {
    const a = selectForInjection(facts, T0, { query: '咖啡' });
    const b = selectForInjection(facts, T0, { query: '咖啡' });
    expect(a).toEqual(b);
  });

  it('always includes pinned facts, and excludes forgotten ones', () => {
    const pinned = fact({ id: 'p', fact: '他对花生过敏', isPinned: true, importance: 1 });
    const ancient = fact({
      id: 'gone',
      fact: '某年某月的一件小事',
      importance: 1,
      confidence: 0.4,
      createdAt: T0 - 400 * DAY,
    });
    const out = selectForInjection([pinned, ancient, ...facts], T0);
    expect(out.pinned).toContain('他对花生过敏');
    expect(out.topK).not.toContain('某年某月的一件小事');
  });

  it('never injects an archived fact', () => {
    const dead = fact({ id: 'd', fact: '过期的事', status: 'archived', importance: 5 });
    const out = selectForInjection([dead, ...facts], T0);
    expect([...out.pinned, ...out.topK]).not.toContain('过期的事');
  });

  it('returns the ids it injected so their use can be recorded', () => {
    const out = selectForInjection(facts, T0);
    expect(out.ids).toHaveLength(out.pinned.length + out.topK.length);
    expect(new Set(out.ids).size).toBe(out.ids.length); // no duplicates
  });

  it('handles an empty corpus without dividing by zero', () => {
    expect(selectForInjection([], T0, { query: '任何东西' })).toEqual({
      pinned: [],
      topK: [],
      ids: [],
    });
  });
});
