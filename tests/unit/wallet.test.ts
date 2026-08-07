import { describe, it, expect } from 'vitest';
import {
  grabDelayMs,
  claimShare,
  isFullyClaimed,
  markBestLuck,
  currentBalance,
  appendTx,
} from '../../src/lib/wallet';
import { splitLuckyPacket } from '../../src/lib/money';
import type { RedPacketVM, RpClaimVM, WalletTxVM } from '../../src/data/types';

const NOW = 1_754_500_000_000;

function packet(over: Partial<RedPacketVM> = {}): RedPacketVM {
  const id = over.id ?? 'rp_1';
  const totalFen = over.totalFen ?? 10000;
  const count = over.count ?? 3;
  return {
    id,
    convId: 'g',
    senderId: 'ai_chen',
    totalFen,
    count,
    kind: 'lucky',
    greeting: '恭喜发财',
    sharesFen: over.sharesFen ?? splitLuckyPacket(totalFen, count, id),
    status: 'active',
    createdAt: NOW,
    ...over,
  };
}

describe('grabDelayMs', () => {
  it('is deterministic per (packet, grabber)', () => {
    expect(grabDelayMs('fast', 'rp_1', 'ai_lin')).toBe(grabDelayMs('fast', 'rp_1', 'ai_lin'));
  });
  it('keeps each speed inside its window', () => {
    const fast = grabDelayMs('fast', 'rp_1', 'a');
    const slow = grabDelayMs('slow', 'rp_1', 'a');
    expect(fast).toBeGreaterThanOrEqual(1000);
    expect(fast).toBeLessThanOrEqual(8000);
    expect(slow).toBeGreaterThanOrEqual(10000);
    expect(slow).toBeLessThanOrEqual(45000);
  });
  it('gives different grabbers different delays (no simultaneous grab)', () => {
    expect(grabDelayMs('mid', 'rp_1', 'ai_lin')).not.toBe(grabDelayMs('mid', 'rp_1', 'ai_ada'));
  });
  it('defaults an unset speed to the mid window', () => {
    const d = grabDelayMs(undefined, 'rp_1', 'a');
    expect(d).toBeGreaterThanOrEqual(5000);
    expect(d).toBeLessThanOrEqual(20000);
  });
});

describe('claimShare', () => {
  it('hands out shares in order and conserves the total', () => {
    const rp = packet({ totalFen: 10000, count: 3 });
    const claims: RpClaimVM[] = [];
    for (const who of ['ai_lin', 'ai_ada', 'self']) {
      const c = claimShare(rp, claims, who, NOW);
      expect(c).not.toBeNull();
      claims.push(c!);
    }
    expect(claims.reduce((n, c) => n + c.amountFen, 0)).toBe(10000);
    expect(claims.map((c) => c.amountFen)).toEqual(rp.sharesFen);
  });

  it('refuses a second claim from the same person', () => {
    const rp = packet();
    const first = claimShare(rp, [], 'ai_lin', NOW)!;
    expect(claimShare(rp, [first], 'ai_lin', NOW)).toBeNull();
  });

  it('returns null once every share is taken', () => {
    const rp = packet({ totalFen: 300, count: 2 });
    const a = claimShare(rp, [], 'a', NOW)!;
    const b = claimShare(rp, [a], 'b', NOW)!;
    expect(claimShare(rp, [a, b], 'c', NOW)).toBeNull();
  });
});

describe('isFullyClaimed / markBestLuck', () => {
  it('reports partial vs full', () => {
    const rp = packet({ totalFen: 300, count: 2 });
    const a = claimShare(rp, [], 'a', NOW)!;
    expect(isFullyClaimed(rp, [a])).toBe(false);
    const b = claimShare(rp, [a], 'b', NOW + 1)!;
    expect(isFullyClaimed(rp, [a, b])).toBe(true);
  });

  it('crowns exactly one winner, the largest share', () => {
    const rp = packet({ totalFen: 600, count: 3, sharesFen: [100, 400, 100] });
    const claims: RpClaimVM[] = [
      { id: 'r:a', rpId: rp.id, claimerId: 'a', amountFen: 100, isBest: false, claimedAt: NOW },
      { id: 'r:b', rpId: rp.id, claimerId: 'b', amountFen: 400, isBest: false, claimedAt: NOW + 1 },
      { id: 'r:c', rpId: rp.id, claimerId: 'c', amountFen: 100, isBest: false, claimedAt: NOW + 2 },
    ];
    const out = markBestLuck(rp, claims);
    expect(out.filter((c) => c.isBest)).toHaveLength(1);
    expect(out.find((c) => c.isBest)?.claimerId).toBe('b');
  });

  it('crowns nobody until the packet is fully claimed', () => {
    const rp = packet({ totalFen: 600, count: 3 });
    const claims: RpClaimVM[] = [
      { id: 'r:a', rpId: rp.id, claimerId: 'a', amountFen: 500, isBest: false, claimedAt: NOW },
    ];
    expect(markBestLuck(rp, claims).some((c) => c.isBest)).toBe(false);
  });

  it('breaks a tie toward the earliest claim', () => {
    const rp = packet({ totalFen: 200, count: 2, sharesFen: [100, 100] });
    const claims: RpClaimVM[] = [
      { id: 'r:a', rpId: rp.id, claimerId: 'a', amountFen: 100, isBest: false, claimedAt: NOW },
      { id: 'r:b', rpId: rp.id, claimerId: 'b', amountFen: 100, isBest: false, claimedAt: NOW + 5 },
    ];
    expect(markBestLuck(rp, claims).find((c) => c.isBest)?.claimerId).toBe('a');
  });
});

describe('wallet ledger', () => {
  const tx = (id: string, amountFen: number, balanceAfterFen: number, createdAt: number): WalletTxVM => ({
    id,
    kind: 'adjust',
    amountFen,
    title: 't',
    balanceAfterFen,
    createdAt,
  });

  it('is zero with no history', () => {
    expect(currentBalance([])).toBe(0);
  });

  it('reads the balance from the latest entry', () => {
    expect(currentBalance([tx('a', 1000, 1000, NOW), tx('b', -300, 700, NOW + 1)])).toBe(700);
  });

  it('advances the running balance on append', () => {
    const txs = [tx('a', 10000, 10000, NOW)];
    const next = appendTx(txs, {
      id: 'b',
      kind: 'rp_out',
      amountFen: -2500,
      title: '发出红包',
      createdAt: NOW + 1,
    });
    expect(next.balanceAfterFen).toBe(7500);
  });

  it('round-trips a full send→receive cycle back to the same balance', () => {
    let txs: WalletTxVM[] = [tx('seed', 50000, 50000, NOW)];
    const out = appendTx(txs, { id: 'o', kind: 'rp_out', amountFen: -8000, title: '发出', createdAt: NOW + 1 });
    txs = [...txs, out];
    const back = appendTx(txs, { id: 'i', kind: 'rp_in', amountFen: 8000, title: '收到', createdAt: NOW + 2 });
    expect(back.balanceAfterFen).toBe(50000);
  });
});
