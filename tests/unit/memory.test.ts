import { describe, it, expect } from 'vitest';
import { scoreFact, selectFactsForInjection } from '../../src/ai/memory';
import type { MemoryFactVM } from '../../src/data/types';

const NOW = 1_754_500_000_000;
const day = 86_400_000;

function fact(over: Partial<MemoryFactVM> = {}): MemoryFactVM {
  return {
    id: Math.random().toString(36).slice(2),
    subjectId: 'ai_lin',
    fact: '用户喜欢喝美式',
    importance: 3,
    sensitivity: 'normal',
    evidenceMsgIds: [1],
    status: 'pending',
    isPinned: false,
    createdAt: NOW,
    ...over,
  };
}

describe('scoreFact', () => {
  it('scores a fresh fact at its full importance', () => {
    expect(scoreFact(fact({ importance: 4, createdAt: NOW }), NOW)).toBeCloseTo(4, 5);
  });

  it('halves the score after one 30-day half-life', () => {
    const f = fact({ importance: 4, createdAt: NOW - 30 * day });
    expect(scoreFact(f, NOW)).toBeCloseTo(2, 5);
  });

  it('uses lastRefAt when present (a re-referenced fact stays fresh)', () => {
    const stale = fact({ importance: 4, createdAt: NOW - 60 * day });
    const refreshed = fact({ importance: 4, createdAt: NOW - 60 * day, lastRefAt: NOW });
    expect(scoreFact(refreshed, NOW)).toBeGreaterThan(scoreFact(stale, NOW));
  });

  it('ranks a high-importance old fact below a fresh one of equal weight', () => {
    const old = fact({ importance: 5, createdAt: NOW - 90 * day });
    const fresh = fact({ importance: 3, createdAt: NOW });
    expect(scoreFact(fresh, NOW)).toBeGreaterThan(scoreFact(old, NOW));
  });
});

describe('selectFactsForInjection', () => {
  it('always includes pinned facts, capped', () => {
    const facts = Array.from({ length: 15 }, (_, i) =>
      fact({ isPinned: true, importance: 1, fact: `pinned ${i}` }),
    );
    const out = selectFactsForInjection(facts, NOW, { maxPinned: 10 });
    expect(out.pinned).toHaveLength(10);
  });

  it('excludes archived facts entirely', () => {
    const out = selectFactsForInjection(
      [fact({ status: 'archived', fact: '过期的事' }), fact({ fact: '有效的事' })],
      NOW,
    );
    expect([...out.pinned, ...out.topK]).toEqual(['有效的事']);
  });

  it('does not duplicate a pinned fact into topK', () => {
    const p = fact({ isPinned: true, fact: '生日 3 月 5 日' });
    const out = selectFactsForInjection([p, fact({ fact: '别的事' })], NOW);
    expect(out.pinned).toEqual(['生日 3 月 5 日']);
    expect(out.topK).toEqual(['别的事']);
  });

  it('caps topK and orders by score desc', () => {
    const facts = [
      fact({ importance: 1, fact: '弱' }),
      fact({ importance: 5, fact: '强' }),
      fact({ importance: 3, fact: '中' }),
    ];
    const out = selectFactsForInjection(facts, NOW, { topK: 2 });
    expect(out.topK).toEqual(['强', '中']);
  });

  it('is deterministic for the same input (prompt prefix stays cacheable)', () => {
    const facts = [fact({ fact: 'a' }), fact({ fact: 'b' }), fact({ fact: 'c' })];
    expect(selectFactsForInjection(facts, NOW)).toEqual(selectFactsForInjection(facts, NOW));
  });
});
