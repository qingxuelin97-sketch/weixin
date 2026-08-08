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
    __rows: rows,
  };
});

import {
  enqueue,
  hasPendingFor,
  runDueActions,
  registerHandler,
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
