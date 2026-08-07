/**
 * Money helpers. All amounts are integer 分 (fen). The red-packet split is a
 * pure function so it is unit-tested for the conservation invariant
 * (sum of shares == total) and determinism.
 */

/** Format fen as a ￥ string, e.g. 12345 → "123.45". */
export function fenToYuan(fen: number): string {
  const sign = fen < 0 ? '-' : '';
  const abs = Math.abs(fen);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Parse a user-entered yuan string (e.g. "12.5") to integer fen. Returns null if invalid. */
export function yuanToFen(input: string): number | null {
  const m = input.trim().match(/^(\d+)(?:\.(\d{1,2}))?$/);
  if (!m) return null;
  const yuan = Number(m[1]);
  const cents = m[2] ? Number(m[2].padEnd(2, '0')) : 0;
  return yuan * 100 + cents;
}

/**
 * Deterministic PRNG (mulberry32) seeded from a stable string, so a red packet
 * splits the same way on replay/backfill. No Math.random anywhere in the engine.
 */
export function seededRng(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Split a lucky red packet into `count` shares (WeChat "拼手气" algorithm:
 * each draw takes a random slice of the remaining pool with a floor of 1 fen,
 * capped near twice the running average). Guarantees every share >= 1 and the
 * shares sum exactly to `totalFen`.
 *
 * @param totalFen total amount in fen (>= count)
 * @param count number of shares (>= 1)
 * @param seed stable seed (e.g. redPacketId) for deterministic replay
 * @returns integer fen shares, length === count, summing to totalFen
 */
export function splitLuckyPacket(totalFen: number, count: number, seed: string): number[] {
  if (count < 1) throw new Error('count must be >= 1');
  if (totalFen < count) throw new Error('totalFen must be >= count (每份至少 1 分)');
  const rng = seededRng(seed);
  const shares: number[] = [];
  let remaining = totalFen;
  let left = count;
  for (let i = 0; i < count - 1; i++) {
    // Max is twice the average of what's left, floored at 1, leaving 1 fen per remaining draw.
    const avg = remaining / left;
    const max = Math.max(1, Math.floor(avg * 2));
    const maxAllowed = Math.min(max, remaining - (left - 1)); // reserve 1 for each remaining
    const share = 1 + Math.floor(rng() * maxAllowed);
    shares.push(share);
    remaining -= share;
    left--;
  }
  shares.push(remaining); // last share takes the rest
  return shares;
}

/** Index of the largest share (手气最佳); ties resolve to the earliest. */
export function bestLuckIndex(shares: number[]): number {
  let best = 0;
  for (let i = 1; i < shares.length; i++) if (shares[i] > shares[best]) best = i;
  return best;
}
