import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Scheduler fixes from the M-B sweep:
 *  - M4: hasPendingFor matches the PARSED contactId field (substring matching
 *    false-positived on payloads that merely mention an id), and a pending
 *    nudge must not suppress the standing heartbeat chain.
 *  - M6: seconds-scale kinds (rp_grab / transfer_accept) drain before
 *    LLM-bound kinds regardless of fireAt order.
 */

vi.mock('../../src/db/idb', () => {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    idbGet: async (_s: string, k: string) => rows.get(k),
    idbGetAll: async () => [...rows.values()],
    idbPut: async (_s: string, row: Record<string, unknown>) => {
      rows.set(row.id as string, row);
    },
    idbDelete: async (_s: string, k: string) => {
      rows.delete(k);
    },
    // duePending queries the byFireAt index (v6) instead of scanning the store.
    idbRangeByIndex: async (_s: string, _i: string, b: { upTo?: number }) =>
      [...rows.values()].filter((r) => b.upTo == null || (r.fireAt as number) <= b.upTo),
    // byStatus (M-G1). Modelled as a real equality lookup on the named index,
    // NOT as "return everything" — a permissive fake here would let a
    // regression back into a full scan without any test noticing.
    idbGetAllByIndex: async (_s: string, index: string, value: IDBValidKey) => {
      const field = index === 'byStatus' ? 'status' : index === 'byFireAt' ? 'fireAt' : 'id';
      return [...rows.values()].filter((r) => r[field] === value);
    },
    __rows: rows,
  };
});

import {
  enqueue,
  hasPendingFor,
  runDueActions,
  registerHandler,
  registerChainedHandler,
  setHandlerErrorSink,
  gcActions,
  ACTION_RETENTION_MS,
} from '../../src/ai/scheduler';
import * as idb from '../../src/db/idb';

const rows = (idb as unknown as { __rows: Map<string, Record<string, unknown>> }).__rows;
const NOW = 1_800_000_000_000;

beforeEach(() => {
  rows.clear();
});

describe('hasPendingFor (M4)', () => {
  it('matches the parsed contactId field only — never a substring elsewhere', async () => {
    await enqueue({
      kind: 'group_msg',
      fireAt: NOW + 1000,
      payload: { convId: 'g1', contactId: 'ai_lin', hint: '聊聊 ai_ada 说过的事' },
      now: NOW,
    });
    expect(await hasPendingFor('group_msg', 'ai_lin')).toBe(true);
    // ai_ada appears in the hint text; the old substring match said true.
    expect(await hasPendingFor('group_msg', 'ai_ada')).toBe(false);
  });

  it('a pending nudge does not count as the standing heartbeat', async () => {
    await enqueue({
      kind: 'heartbeat',
      fireAt: NOW + 1000,
      payload: { contactId: 'ai_lin', convId: 'c1', nudge: true },
      now: NOW,
    });
    expect(await hasPendingFor('heartbeat', 'ai_lin')).toBe(false);
    await enqueue({
      kind: 'heartbeat',
      fireAt: NOW + 2000,
      payload: { contactId: 'ai_lin', convId: 'c1' },
      now: NOW,
    });
    expect(await hasPendingFor('heartbeat', 'ai_lin')).toBe(true);
  });

  it('ignores done rows and other kinds', async () => {
    const a = await enqueue({
      kind: 'heartbeat',
      fireAt: NOW + 1000,
      payload: { contactId: 'ai_lin', convId: 'c1' },
      now: NOW,
    });
    rows.set(a.id, { ...a, status: 'done' });
    expect(await hasPendingFor('heartbeat', 'ai_lin')).toBe(false);
  });
});

describe('runDueActions ordering (M6)', () => {
  it('drains rp_grab/transfer_accept before slower kinds even when due later', async () => {
    const order: string[] = [];
    registerHandler('heartbeat', async () => void order.push('heartbeat'));
    registerHandler('rp_grab', async () => void order.push('rp_grab'));
    registerHandler('transfer_accept', async () => void order.push('transfer_accept'));

    // Heartbeat became due FIRST — yet money actions must still jump the queue.
    await enqueue({ kind: 'heartbeat', fireAt: NOW - 5000, payload: { contactId: 'a' }, now: NOW });
    await enqueue({ kind: 'rp_grab', fireAt: NOW - 1000, payload: { rpId: 'rp1' }, now: NOW });
    await enqueue({
      kind: 'transfer_accept',
      fireAt: NOW - 500,
      payload: { transferId: 't1' },
      now: NOW,
    });

    expect(await runDueActions(NOW)).toBe(3);
    expect(order).toEqual(['rp_grab', 'transfer_accept', 'heartbeat']);
  });

  it('within the fast class, earlier fireAt still goes first', async () => {
    const order: string[] = [];
    registerHandler('rp_grab', async (p) => void order.push(String(p.rpId)));
    await enqueue({ kind: 'rp_grab', fireAt: NOW - 100, payload: { rpId: 'late' }, now: NOW });
    await enqueue({ kind: 'rp_grab', fireAt: NOW - 900, payload: { rpId: 'early' }, now: NOW });
    await runDueActions(NOW);
    expect(order).toEqual(['early', 'late']);
  });
});

/**
 * M-E1 scheduler debt.
 *
 * Two properties that were simply absent: settled rows were never removed (the
 * store grew forever while `duePending` scanned all of it once a second), and a
 * self-chaining handler queued its successor AFTER the work — so one thrown
 * error ended that AI's chain permanently, with no trace anywhere.
 */
describe('chain-before-work (M-E1)', () => {
  beforeEach(() => {
    rows.clear();
    setHandlerErrorSink(() => {});
  });

  it('queues the successor even when the work throws', async () => {
    const order: string[] = [];
    registerChainedHandler('heartbeat', {
      chain: async () => void order.push('chain'),
      work: async () => {
        order.push('work');
        throw new Error('провал'); // network, refusal, storage — pick any
      },
    });
    await enqueue({ kind: 'heartbeat', fireAt: NOW - 1, payload: {}, now: NOW, id: 'hb' });
    await runDueActions(NOW);
    // Chain FIRST: the successor exists regardless of what the work did.
    expect(order).toEqual(['chain', 'work']);
  });

  it('still does the work when the chain step throws', async () => {
    const order: string[] = [];
    registerChainedHandler('heartbeat', {
      chain: async () => {
        order.push('chain');
        throw new Error('scheduling failed');
      },
      work: async () => void order.push('work'),
    });
    await enqueue({ kind: 'heartbeat', fireAt: NOW - 1, payload: {}, now: NOW, id: 'hb2' });
    await runDueActions(NOW);
    expect(order).toEqual(['chain', 'work']);
  });

  it('reports handler failures instead of swallowing them', async () => {
    const seen: string[] = [];
    setHandlerErrorSink((scope) => void seen.push(scope));
    registerHandler('recall', async () => {
      throw new Error('boom');
    });
    await enqueue({ kind: 'recall', fireAt: NOW - 1, payload: {}, now: NOW, id: 'rc' });
    await runDueActions(NOW);
    // This catch is where "她突然不说话了" went to die for four milestones.
    expect(seen).toContain('action:recall');
  });
});

describe('gcActions (M-E1)', () => {
  beforeEach(() => rows.clear());

  it('removes settled rows past the retention window and keeps everything else', async () => {
    const old = NOW - ACTION_RETENTION_MS - 1;
    await enqueue({ kind: 'recall', fireAt: old, payload: {}, now: old, id: 'old_done' });
    await enqueue({ kind: 'recall', fireAt: old, payload: {}, now: old, id: 'old_pending' });
    await enqueue({ kind: 'recall', fireAt: NOW, payload: {}, now: NOW, id: 'fresh_done' });
    rows.set('old_done', { ...rows.get('old_done')!, status: 'done' });
    rows.set('fresh_done', { ...rows.get('fresh_done')!, status: 'done' });

    expect(await gcActions(NOW)).toBe(1);
    expect(rows.has('old_done')).toBe(false);
    // A pending row is never GC'd, however old — it still has to happen.
    expect(rows.has('old_pending')).toBe(true);
    // And a recent settled row survives, so `actionExists` can still block a
    // once-ever action (a nudge) from being queued a second time.
    expect(rows.has('fresh_done')).toBe(true);
  });

  it('ages a backfilled row by when this device learned of it, not its fireAt', async () => {
    // Backfill materializes rows with fireAt far in the past; judging by fireAt
    // alone would delete them the moment they completed.
    await enqueue({ kind: 'group_msg', fireAt: NOW - 400 * 86_400_000, payload: {}, now: NOW, id: 'bf' });
    rows.set('bf', { ...rows.get('bf')!, status: 'done' });
    expect(await gcActions(NOW)).toBe(0);
    expect(rows.has('bf')).toBe(true);
  });

  it('keeps the queue from growing without bound over a long run', async () => {
    for (let i = 0; i < 200; i++) {
      const t = NOW - ACTION_RETENTION_MS - i * 3_600_000;
      await enqueue({ kind: 'heartbeat', fireAt: t, payload: {}, now: t, id: `h${i}` });
      rows.set(`h${i}`, { ...rows.get(`h${i}`)!, status: 'done' });
    }
    await gcActions(NOW);
    expect(rows.size).toBe(0);
  });
});
