import { describe, it, expect } from 'vitest';
import {
  fenToYuan,
  yuanToFen,
  splitLuckyPacket,
  bestLuckIndex,
  seededRng,
} from '../../src/lib/money';

describe('fen/yuan formatting', () => {
  it('formats fen to yuan', () => {
    expect(fenToYuan(0)).toBe('0.00');
    expect(fenToYuan(5)).toBe('0.05');
    expect(fenToYuan(12345)).toBe('123.45');
    expect(fenToYuan(-250)).toBe('-2.50');
  });
  it('parses yuan strings to fen', () => {
    expect(yuanToFen('12.5')).toBe(1250);
    expect(yuanToFen('0.01')).toBe(1);
    expect(yuanToFen('100')).toBe(10000);
    expect(yuanToFen('abc')).toBeNull();
    expect(yuanToFen('1.234')).toBeNull();
  });
});

describe('splitLuckyPacket conservation invariant', () => {
  it('shares always sum exactly to total and each >= 1', () => {
    const cases: Array<[number, number]> = [
      [10000, 5],
      [500, 5],
      [1, 1],
      [999, 100],
      [100000, 50],
      [3, 3],
    ];
    for (const [total, count] of cases) {
      const shares = splitLuckyPacket(total, count, `seed-${total}-${count}`);
      expect(shares).toHaveLength(count);
      expect(shares.reduce((a, b) => a + b, 0)).toBe(total);
      expect(Math.min(...shares)).toBeGreaterThanOrEqual(1);
    }
  });

  it('is deterministic for a given seed (replay-safe)', () => {
    const a = splitLuckyPacket(8888, 8, 'rp_abc');
    const b = splitLuckyPacket(8888, 8, 'rp_abc');
    expect(a).toEqual(b);
  });

  it('differs across seeds', () => {
    const a = splitLuckyPacket(8888, 8, 'rp_abc');
    const b = splitLuckyPacket(8888, 8, 'rp_xyz');
    expect(a).not.toEqual(b);
  });

  it('rejects impossible splits', () => {
    expect(() => splitLuckyPacket(3, 5, 's')).toThrow();
    expect(() => splitLuckyPacket(100, 0, 's')).toThrow();
  });

  it('bestLuckIndex points at the max share', () => {
    expect(bestLuckIndex([10, 50, 30])).toBe(1);
    expect(bestLuckIndex([5, 5, 5])).toBe(0);
  });
});

describe('seededRng', () => {
  it('produces values in [0,1) and is deterministic', () => {
    const r1 = seededRng('x');
    const r2 = seededRng('x');
    for (let i = 0; i < 20; i++) {
      const v = r1();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
      expect(v).toBe(r2());
    }
  });
});
