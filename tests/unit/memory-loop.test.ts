import { describe, it, expect } from 'vitest';
import 'fake-indexeddb/auto';
import { repo } from '../../src/db/repo';
import { touchFacts, maintainMemory, selectFactsForInjection } from '../../src/ai/memory';
import {
  maybeScheduleMemExtract,
  getExtractMarker,
  setExtractMarker,
  MEM_EXTRACT_MIN_NEW,
} from '../../src/ai/memory-service';
import type { MemoryFactVM } from '../../src/data/types';

const T0 = 1_754_600_000_000;
const DAY = 86_400_000;

function fact(over: Partial<MemoryFactVM>): MemoryFactVM {
  return {
    id: `f_${Math.abs(JSON.stringify(over).length)}_${over.id ?? ''}`,
    subjectId: 'ai_m',
    fact: '用户喜欢喝美式',
    importance: 3,
    sensitivity: 'normal',
    evidenceMsgIds: [1],
    status: 'pending',
    isPinned: false,
    createdAt: T0,
    source: 'chat',
    confidence: 0.9,
    refCount: 0,
    ...over,
  };
}

describe('fact lifecycle (touch → confirm, stale → archive)', () => {
  it('touchFacts bumps refCount and flips pending→confirmed on first use', async () => {
    const f = fact({ id: 'f_touch', subjectId: 'ai_t1' });
    await repo.putMemory(f);
    await touchFacts('ai_t1', ['f_touch'], T0 + 1000);
    const after = (await repo.getMemory('ai_t1')).find((x) => x.id === 'f_touch')!;
    expect(after.status).toBe('confirmed');
    expect(after.refCount).toBe(1);
    expect(after.lastRefAt).toBe(T0 + 1000);
  });

  it('maintainMemory archives low-importance facts unreferenced for 30 days, spares pinned', async () => {
    await repo.putMemory(fact({ id: 'f_old_trivia', subjectId: 'ai_t2', importance: 1 }));
    await repo.putMemory(fact({ id: 'f_old_pinned', subjectId: 'ai_t2', importance: 1, isPinned: true }));
    await repo.putMemory(fact({ id: 'f_important', subjectId: 'ai_t2', importance: 4 }));
    await repo.putMemory(fact({ id: 'f_recent', subjectId: 'ai_t2', importance: 1, lastRefAt: T0 + 35 * DAY }));

    const archived = await maintainMemory('ai_t2', T0 + 40 * DAY);
    expect(archived).toBe(1);
    const byId = new Map((await repo.getMemory('ai_t2')).map((f) => [f.id, f.status]));
    expect(byId.get('f_old_trivia')).toBe('archived');
    expect(byId.get('f_old_pinned')).toBe('pending');
    expect(byId.get('f_important')).toBe('pending');
    expect(byId.get('f_recent')).toBe('pending');
  });

  it('selectFactsForInjection exposes the injected ids (for ref bookkeeping)', () => {
    const sel = selectFactsForInjection([fact({ id: 'a' }), fact({ id: 'b', isPinned: true })], T0);
    expect(new Set(sel.ids)).toEqual(new Set(['a', 'b']));
  });
});

describe('silence-trigger scheduling', () => {
  async function seedConv(convId: string, n: number) {
    for (let i = 0; i < n; i++) {
      await repo.addMessage({
        convId,
        senderId: i % 2 ? 'ai_s' : 'self',
        type: 'text',
        content: `msg ${i}`,
        status: 'sent',
        createdAt: T0 + i * 1000,
      });
    }
  }

  it('queues once past the threshold, dedupes on the same frontier', async () => {
    await seedConv('cv_mem1', MEM_EXTRACT_MIN_NEW);
    expect(await maybeScheduleMemExtract('cv_mem1', 'ai_s', T0)).toBe(true);
    // Same frontier again → the action id already exists → no double spend.
    expect(await maybeScheduleMemExtract('cv_mem1', 'ai_s', T0 + 1)).toBe(false);
  });

  it('does nothing below the threshold', async () => {
    await seedConv('cv_mem2', MEM_EXTRACT_MIN_NEW - 1);
    expect(await maybeScheduleMemExtract('cv_mem2', 'ai_s', T0)).toBe(false);
  });

  it('marker advances hide already-extracted spans', async () => {
    await seedConv('cv_mem3', MEM_EXTRACT_MIN_NEW);
    const msgs = await repo.getMessages('cv_mem3', { limit: 60 });
    await setExtractMarker('cv_mem3', msgs[msgs.length - 1].id);
    expect(await getExtractMarker('cv_mem3')).toBe(msgs[msgs.length - 1].id);
    expect(await maybeScheduleMemExtract('cv_mem3', 'ai_s', T0)).toBe(false);
  });
});
