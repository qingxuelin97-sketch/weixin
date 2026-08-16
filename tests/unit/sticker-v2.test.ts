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
  stickerScale,
  USER_STICKER_MAX,
  AGENT_STICKER_SWAP_RATE,
} from '../../src/ai/sticker-taste';
import { makePersona, STICKER_RATE_BASELINE } from '../../src/data/persona-defaults';
import { stickerHabitLine } from '../../src/ai/prompt';
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

/* ------------------- 表情使用率联动 persona (M-I19) ------------------- */

/**
 * Before M-I19 every character in the app shared two module constants, so the
 * 话痨 who lives in her sticker drawer and the 高冷 one who has never sent a
 * sticker behaved identically. `stickerRate` is a persona field now, exactly
 * like `likeRate` / `commentRate` / `momentsPerDay`.
 */
describe('stickerScale', () => {
  it('maps the baseline to exactly 1 — an unset persona behaves as before', () => {
    expect(stickerScale(STICKER_RATE_BASELINE)).toBe(1);
    expect(stickerScale(undefined)).toBe(1);
  });

  it('reads a missing/garbage value as the baseline, never as zero', () => {
    // The makePersona trap (CLAUDE.md §3.5): `undefined` silently meaning
    // "never" is a feature that vanishes without an error.
    expect(stickerScale(NaN)).toBe(1);
    expect(stickerScale(-1)).toBe(1);
  });

  it('is monotonic and capped', () => {
    expect(stickerScale(0)).toBe(0);
    expect(stickerScale(0.7)).toBeGreaterThan(1);
    expect(stickerScale(1)).toBeLessThanOrEqual(2);
  });
});

describe('battleUrge follows the persona', () => {
  it('a sticker-happy persona out-battles a reserved one at every streak', () => {
    for (const streak of [1, 2, 3, 4, 5, 8]) {
      expect(battleUrge(streak, 0.9)).toBeGreaterThan(battleUrge(streak, 0.1));
    }
  });

  it('rate 0 means she never答图 — no floor to leak through', () => {
    for (const streak of [1, 2, 3, 4, 10]) expect(battleUrge(streak, 0)).toBe(0);
  });

  it('keeps the curve SHAPE: a streak still invites, a long war still decays', () => {
    for (const rate of [0.1, 0.35, 0.9]) {
      expect(battleUrge(2, rate)).toBeGreaterThanOrEqual(battleUrge(1, rate));
      expect(battleUrge(9, rate)).toBeLessThan(battleUrge(3, rate));
    }
  });

  it('leaves the default identical to the pre-M-I19 constants', () => {
    expect(battleUrge(1)).toBeCloseTo(0.35, 10);
    expect(battleUrge(3)).toBeCloseTo(0.65, 10);
  });
});

describe('两个不同 stickerRate 的人设在同一种子下发表情次数不同', () => {
  /** Count sticker replies over one fixed set of seeds. Deterministic. */
  const battlesWon = (rate: number): number => {
    let n = 0;
    for (let i = 0; i < 300; i++) {
      if (battleReply({ seed: `war:${i}`, streak: (i % 4) + 1, rate }, ['idb:a', 'idb:b'], 'idb:c')) {
        n++;
      }
    }
    return n;
  };

  const swaps = (rate: number): number => {
    let n = 0;
    for (let i = 0; i < 300; i++) {
      if (maybeAgentSticker(['idb:a', 'idb:b'], `turn:${i}`, rate)) n++;
    }
    return n;
  };

  it('斗图: the 话痨 answers far more often than the 高冷 one', () => {
    const chatty = battlesWon(0.9);
    const cold = battlesWon(0.1);
    expect(chatty).toBeGreaterThan(cold);
    // Not a rounding difference — a visibly different character.
    expect(chatty - cold).toBeGreaterThan(50);
  });

  it('斗图: the same rate on the same seeds is reproducible', () => {
    expect(battlesWon(0.9)).toBe(battlesWon(0.9));
    expect(battlesWon(0.1)).toBe(battlesWon(0.1));
  });

  it('自定义表情替换: the same ordering holds, and is reproducible', () => {
    expect(swaps(0.9)).toBeGreaterThan(swaps(0.1));
    expect(swaps(0.9)).toBe(swaps(0.9));
  });

  it('rate 0 sends nothing at all through either gate', () => {
    expect(battlesWon(0)).toBe(0);
    expect(swaps(0)).toBe(0);
  });
});

describe('makePersona backfills stickerRate', () => {
  it('fills the default so a pre-M-I19 row never reads as 从不发表情', () => {
    const p = makePersona({ contactId: 'x', core: 'c' });
    expect(p.stickerRate).toBe(STICKER_RATE_BASELINE);
  });

  it('keeps an explicit value', () => {
    expect(makePersona({ contactId: 'x', core: 'c', stickerRate: 0.9 }).stickerRate).toBe(0.9);
  });

  it('is carried into the prompt layer only at the two ends of the range', () => {
    // A middling character says nothing about stickers — the persona layer must
    // not be diluted by a line that carries no information, and the default
    // prompt stays byte-identical for prefix caching.
    expect(stickerHabitLine(STICKER_RATE_BASELINE)).toBe('');
    expect(stickerHabitLine(0.9)).toContain('爱发表情包');
    expect(stickerHabitLine(0.05)).toContain('几乎不发表情包');
    expect(stickerHabitLine(undefined)).toBe('');
  });
});
