import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import 'fake-indexeddb/auto';
import { repo } from '../../src/db/repo';
import { idbPut } from '../../src/db/idb';
import {
  enqueue,
  pendingActions,
  hasPendingFor,
  gcActions,
  markDone,
} from '../../src/ai/scheduler';
import type { MemoryFactVM, MessageVM, MomentVM, RpClaimVM } from '../../src/data/types';

/**
 * Operation budgets (M-G1).
 *
 * Every performance problem this round fixed had the same shape: an index was
 * declared in the schema and nobody read it, so a query the database could
 * answer directly was answered by deserializing the whole store into JS. It is
 * invisible in code review (`getAll` then `filter` reads fine) and invisible in
 * tests (the results are correct), and it only shows up months later as an app
 * that got slow and nobody knows when.
 *
 * So this file counts WORK, not wall-clock: how many rows the storage layer
 * hands to JS for a given operation. Timing assertions would flake on CI;
 * "reading one contact's memory must not touch the other 4,999 facts" cannot.
 *
 * Every budget here is generous — they exist to catch a return to O(store),
 * not to police constant factors.
 */

/** Rows delivered to JS by each `getAll`, per store, since the last reset. */
const rowsRead = new Map<string, number>();
let getAllCalls = 0;

const realStoreGetAll = IDBObjectStore.prototype.getAll;
const realIndexGetAll = IDBIndex.prototype.getAll;

function record(store: string, req: IDBRequest) {
  getAllCalls++;
  req.addEventListener('success', () => {
    const n = Array.isArray(req.result) ? req.result.length : 0;
    rowsRead.set(store, (rowsRead.get(store) ?? 0) + n);
  });
}

beforeAll(() => {
  // Instrumenting the real IndexedDB prototypes (rather than mocking our own
  // idb layer) is deliberate: a mock would happily report whatever we told it
  // to, and the whole question here is what the DRIVER actually does.
  IDBObjectStore.prototype.getAll = function (this: IDBObjectStore, ...args: unknown[]) {
    const req = (realStoreGetAll as (...a: unknown[]) => IDBRequest).apply(this, args);
    record(this.name, req);
    return req;
  } as typeof realStoreGetAll;
  IDBIndex.prototype.getAll = function (this: IDBIndex, ...args: unknown[]) {
    const req = (realIndexGetAll as (...a: unknown[]) => IDBRequest).apply(this, args);
    record(this.objectStore.name, req);
    return req;
  } as typeof realIndexGetAll;
});

afterAll(() => {
  IDBObjectStore.prototype.getAll = realStoreGetAll;
  IDBIndex.prototype.getAll = realIndexGetAll;
});

beforeEach(() => {
  rowsRead.clear();
  getAllCalls = 0;
});

const read = (store: string) => rowsRead.get(store) ?? 0;

const T0 = 1_755_400_000_000;

/* ------------------------------- fixtures ------------------------------- */

const FACTS_PER_SUBJECT = 40;
const SUBJECTS = 50; // 2,000 facts total — enough that a full scan is obvious

async function seedMemory(): Promise<void> {
  const rows: MemoryFactVM[] = [];
  for (let s = 0; s < SUBJECTS; s++) {
    for (let i = 0; i < FACTS_PER_SUBJECT; i++) {
      rows.push({
        id: `f_${s}_${i}`,
        subjectId: `ai_${s}`,
        fact: `第 ${i} 条事实`,
        importance: 3,
        status: 'confirmed',
        source: 'chat',
        createdAt: T0 + i,
        updatedAt: T0 + i,
      } as unknown as MemoryFactVM);
    }
  }
  for (const r of rows) await repo.putMemory(r);
}

describe('reading one subject’s memory does not touch anybody else’s', () => {
  beforeAll(async () => {
    await seedMemory();
  });

  it('reads only that subject’s facts', async () => {
    rowsRead.clear();
    const facts = await repo.getMemory('ai_7');
    expect(facts).toHaveLength(FACTS_PER_SUBJECT);
    // The budget. Before M-G1 this was `getAll()` + a JS filter, so it read
    // SUBJECTS × FACTS_PER_SUBJECT rows — and the chat engine runs it up to
    // eleven times for a single group message.
    expect(read('memory_facts')).toBeLessThanOrEqual(FACTS_PER_SUBJECT);
  });

  it('stays flat as the store grows', async () => {
    rowsRead.clear();
    await repo.getMemory('ai_1');
    const small = read('memory_facts');

    for (let i = 0; i < 500; i++) {
      await repo.putMemory({
        id: `bulk_${i}`,
        subjectId: 'ai_999',
        fact: 'x',
        importance: 1,
        status: 'confirmed',
        source: 'chat',
        createdAt: T0,
        updatedAt: T0,
      } as unknown as MemoryFactVM);
    }

    rowsRead.clear();
    await repo.getMemory('ai_1');
    // Cost is a function of the ANSWER, not of the database. This is the
    // property that "getAll then filter" quietly does not have.
    expect(read('memory_facts')).toBe(small);
  });
});

describe('the scheduler asks for pending rows, not for every row', () => {
  beforeEach(async () => {
    for (let i = 0; i < 200; i++) {
      const a = await enqueue({
        kind: 'heartbeat',
        fireAt: T0 + i,
        payload: { contactId: `ai_${i}`, convId: `c_${i}` },
        now: T0,
        id: `done_${i}`,
      });
      await markDone(a);
    }
    for (let i = 0; i < 5; i++) {
      await enqueue({
        kind: 'heartbeat',
        fireAt: T0 + i,
        payload: { contactId: `live_${i}`, convId: `c_${i}` },
        now: T0,
        id: `live_${i}`,
      });
    }
  });

  it('pendingActions reads the pending set only', async () => {
    rowsRead.clear();
    const pending = await pendingActions();
    expect(pending.length).toBeGreaterThan(0);
    // 200 settled rows are sitting in the same store and must not be paid for.
    // The settled ones are what a long-lived install accumulates most of.
    expect(read('scheduled_actions')).toBeLessThanOrEqual(pending.length);
  });

  it('hasPendingFor costs the pending set, not the store', async () => {
    rowsRead.clear();
    expect(await hasPendingFor('heartbeat', 'live_2')).toBe(true);
    expect(read('scheduled_actions')).toBeLessThan(50);
  });

  it('gcActions never reads the pending rows it cannot collect', async () => {
    rowsRead.clear();
    await gcActions(T0);
    const rows = read('scheduled_actions');
    // It asks for done + cancelled. The five pending rows are not collectable
    // and reading them would be pure waste on every foreground pass.
    expect(rows).toBeGreaterThan(0);
    expect(rows).toBeLessThanOrEqual(200);
  });
});

describe('feeds and claims are paged, not scanned', () => {
  beforeAll(async () => {
    for (let i = 0; i < 400; i++) {
      await idbPut('moments', {
        id: `m_${i}`,
        authorId: 'ai_1',
        text: `第 ${i} 条`,
        imageRefs: [],
        isNsfw: false,
        createdAt: T0 + i * 1000,
      } as unknown as MomentVM);
    }
    for (let rp = 0; rp < 20; rp++) {
      for (let c = 0; c < 5; c++) {
        await repo.putClaim({
          id: `${rp}:${c}`,
          rpId: `rp_${rp}`,
          contactId: `ai_${c}`,
          name: `n${c}`,
          amountFen: 100,
          claimedAt: T0 + c,
        } as unknown as RpClaimVM);
      }
    }
  });

  it('a feed page costs the page, not the history', async () => {
    rowsRead.clear();
    const page = await repo.getMoments({ limit: 20 });
    expect(page).toHaveLength(20);
    expect(page[0].createdAt).toBeGreaterThan(page[19].createdAt); // newest first
    // Walks the index backwards with a cursor, so `getAll` is never called on
    // this store at all. Before M-G1 it read all 400 and sliced afterwards.
    expect(read('moments')).toBe(0);
  });

  it('a red packet’s claims cost that packet only', async () => {
    rowsRead.clear();
    const claims = await repo.getClaims('rp_3');
    expect(claims).toHaveLength(5);
    expect(read('rp_claims')).toBeLessThanOrEqual(5);
  });
});

describe('deleting a conversation is one transaction, not one per message', () => {
  it('removes every message without materializing them', async () => {
    await repo.putConversation({
      id: 'big',
      type: 'single',
      title: 'x',
      peerId: 'ai_1',
      unreadCount: 0,
      lastMsgAt: T0,
    } as never);
    for (let i = 0; i < 300; i++) {
      await repo.addMessage({
        convId: 'big',
        senderId: 'self',
        type: 'text',
        content: `m${i}`,
        status: 'sent',
        createdAt: T0 + i,
      } as Omit<MessageVM, 'id'>);
    }

    rowsRead.clear();
    getAllCalls = 0;
    await repo.deleteConversation('big');

    // A cursor delete never hands the rows to JS. The old implementation read
    // them all and then opened one transaction per message — 300 serial
    // round-trips here, tens of thousands on a real thread.
    expect(read('messages')).toBe(0);
    expect(getAllCalls).toBe(0);
    expect(await repo.getMessages('big', { limit: 10 })).toHaveLength(0);
  });
});
