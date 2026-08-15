/**
 * 表情包 v2 (M-I15): the taste ledger, per-agent collection, the engine's
 * custom-sticker swap gate, and the 斗图 battle machinery. All pure and
 * seeded — the suite mostly proves determinism and the probability shape.
 */
import { describe, it, expect } from 'vitest';
import {
  foldUserSticker,
  collectedStickers,
  maybeAgentSticker,
  USER_STICKER_MAX,
  AGENT_STICKER_SWAP_RATE,
} from '../../src/ai/sticker-taste';
import {
  battleUrge,
  wantsBattle,
  battleReply,
  stickerStreak,
} from '../../src/ai/sticker-battle';
import { STICKER_VOCAB } from '../../src/data/stickers';
import { renderMessageBody } from '../../src/ai/render-msg';
import type { MessageVM } from '../../src/data/types';

/* ------------------------------ taste ledger ------------------------------ */

describe('foldUserSticker', () => {
  it('appends a new ref', () => {
    expect(foldUserSticker([], 'idb:a')).toEqual(['idb:a']);
  });

  it('moves a re-sent ref to the tail instead of duplicating', () => {
    expect(foldUserSticker(['idb:a', 'idb:b'], 'idb:a')).toEqual(['idb:b', 'idb:a']);
  });

  it('ignores vocab glyphs — only customs are collectible', () => {
    expect(foldUserSticker(['idb:a'], '捂脸')).toEqual(['idb:a']);
  });

  it('is bounded', () => {
    let ledger: string[] = [];
    for (let i = 0; i < 100; i++) ledger = foldUserSticker(ledger, `idb:${i}`);
    expect(ledger.length).toBe(USER_STICKER_MAX);
    expect(ledger.at(-1)).toBe('idb:99');
  });
});

describe('collectedStickers', () => {
  const ledger = Array.from({ length: 40 }, (_, i) => `idb:${i}`);

  it('is deterministic per agent', () => {
    expect(collectedStickers('a', ledger)).toEqual(collectedStickers('a', ledger));
  });

  it('is a strict subset with real membership', () => {
    const got = collectedStickers('a', ledger);
    expect(got.length).toBeGreaterThan(0);
    expect(got.length).toBeLessThan(ledger.length);
    for (const r of got) expect(ledger).toContain(r);
  });

  it('two agents develop different taste', () => {
    expect(collectedStickers('a', ledger)).not.toEqual(collectedStickers('b', ledger));
  });
});

describe('maybeAgentSticker', () => {
  const pool = ['idb:x', 'idb:y', 'idb:z'];

  it('is deterministic per seed', () => {
    expect(maybeAgentSticker(pool, 's1')).toBe(maybeAgentSticker(pool, 's1'));
  });

  it('returns null for an empty pool', () => {
    expect(maybeAgentSticker([], 's1')).toBeNull();
  });

  it('swaps a seeded minority of turns, near the configured rate', () => {
    let swapped = 0;
    const n = 800;
    for (let i = 0; i < n; i++) if (maybeAgentSticker(pool, `s${i}`)) swapped++;
    expect(swapped / n).toBeGreaterThan(AGENT_STICKER_SWAP_RATE - 0.08);
    expect(swapped / n).toBeLessThan(AGENT_STICKER_SWAP_RATE + 0.08);
  });

  it('only ever returns pool members', () => {
    for (let i = 0; i < 200; i++) {
      const r = maybeAgentSticker(pool, `m${i}`);
      if (r) expect(pool).toContain(r);
    }
  });
});

/* -------------------------------- 斗图 -------------------------------- */

describe('battleUrge', () => {
  it('is zero with no sticker context', () => {
    expect(battleUrge(0)).toBe(0);
  });

  it('a budding war is likelier to continue than a lone sticker', () => {
    expect(battleUrge(2)).toBeGreaterThan(battleUrge(1));
  });

  it('long wars die down', () => {
    expect(battleUrge(6)).toBeLessThan(battleUrge(3));
    expect(battleUrge(20)).toBeGreaterThan(0); // but never fully impossible
  });
});

describe('wantsBattle / battleReply', () => {
  it('is deterministic per seed', () => {
    const ctx = { seed: 'c1:42', streak: 2 };
    expect(wantsBattle(ctx)).toBe(wantsBattle(ctx));
    expect(battleReply(ctx, ['idb:a'], 'idb:u')).toEqual(battleReply(ctx, ['idb:a'], 'idb:u'));
  });

  it('answers a seeded fraction of rounds — some yes, some no', () => {
    let yes = 0;
    for (let i = 0; i < 300; i++) {
      if (battleReply({ seed: `s${i}`, streak: 2 }, [], undefined)) yes++;
    }
    expect(yes).toBeGreaterThan(50);
    expect(yes).toBeLessThan(290);
  });

  it('answers from her customs or the vocab, never echoing what you just sent', () => {
    const customs = ['idb:a', 'idb:b'];
    for (let i = 0; i < 300; i++) {
      const r = battleReply({ seed: `e${i}`, streak: 3 }, customs, 'idb:a');
      if (!r) continue;
      expect(r.content).not.toBe('idb:a');
      expect(customs.includes(r.content) || r.content in STICKER_VOCAB).toBe(true);
    }
  });

  it('prefers collected customs when she has them', () => {
    let custom = 0;
    let total = 0;
    for (let i = 0; i < 400; i++) {
      const r = battleReply({ seed: `p${i}`, streak: 3 }, ['idb:a', 'idb:b'], undefined);
      if (!r) continue;
      total++;
      if (r.content.startsWith('idb:')) custom++;
    }
    expect(custom / total).toBeGreaterThan(0.5);
  });

  it('falls back to the vocab with no customs', () => {
    const r = battleReply({ seed: 'fb', streak: 4 }, [], undefined);
    if (r) expect(r.content in STICKER_VOCAB).toBe(true);
  });

  it('delays inside the human window', () => {
    for (let i = 0; i < 200; i++) {
      const r = battleReply({ seed: `d${i}`, streak: 3 }, ['idb:a'], undefined);
      if (!r) continue;
      expect(r.delayMs).toBeGreaterThanOrEqual(800);
      expect(r.delayMs).toBeLessThanOrEqual(2500);
    }
  });
});

describe('stickerStreak', () => {
  it('counts the trailing run only', () => {
    expect(stickerStreak(['text', 'sticker', 'sticker'])).toBe(2);
    expect(stickerStreak(['sticker', 'text'])).toBe(0);
    expect(stickerStreak([])).toBe(0);
    expect(stickerStreak(['sticker', 'sticker', 'sticker'])).toBe(3);
  });
});

/* --------------------------- projection layer --------------------------- */

describe('custom sticker projection', () => {
  const msg = (content: string): MessageVM => ({
    id: 1,
    convId: 'c',
    senderId: 'self',
    type: 'sticker',
    content,
    status: 'sent',
    createdAt: 0,
  });

  it('never shows the model an internal idb ref', () => {
    expect(renderMessageBody(msg('idb:0d9f-uuid'))).toBe('[表情]');
  });

  it('still names vocab stickers', () => {
    expect(renderMessageBody(msg('捂脸'))).toBe('[表情：捂脸]');
  });
});
