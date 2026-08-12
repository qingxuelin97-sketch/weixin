import { describe, it, expect } from 'vitest';
import {
  planGift,
  planGroupGift,
  generosityOf,
  conflictRecently,
  userNeedsCheeringUp,
  amountFor,
  GIFT_COOLDOWN_MS,
  GIFT_LIVENESS_MS,
  type GiftContext,
  type GiftMessage,
} from '../../src/ai/money-motive';
import { makePersona } from '../../src/data/persona-defaults';
import type { Occasion } from '../../src/ai/occasions';

/**
 * She sends money too (M-H1).
 *
 * Every red packet in this codebase was `senderId: 'self'` — money only ever
 * flowed toward her. The point of these tests is the other half of that fix:
 * the gates. A persona who sends money whenever she can is not generous, and
 * the failure is expensive in a way the rest of the app's failures are not —
 * a wrong bubble is embarrassing, a wrong gift is a wrong gift.
 */

const T0 = new Date(2026, 4, 10, 14, 0).getTime(); // a Sunday afternoon, awake
const HOUR = 3_600_000;
const DAY = 86_400_000;

const persona = (over: Partial<ReturnType<typeof makePersona>> = {}) =>
  makePersona({ contactId: 'ai_lin', core: '林小雨', generosity: 0.5, ...over });

const said = (text: string, at: number, who = 'self'): GiftMessage => ({
  senderId: who,
  type: 'text',
  content: text,
  createdAt: at,
});

const ctx = (over: Partial<GiftContext> = {}): GiftContext => ({
  persona: persona(),
  now: T0,
  affinity: 60,
  occasions: [],
  recent: [said('在干嘛', T0 - HOUR)],
  ...over,
});

const birthday: Occasion = { label: '5月10日生日', inDays: 0, kind: 'birthday' };
const festival: Occasion = { label: '520', inDays: 0, kind: 'festival' };

/**
 * The first day within `days` on which she actually acts.
 *
 * Every reason is behind a seeded roll that fails most days — that IS the
 * feature — so a test that asserts "this signal produces this gift" has to ask
 * "when she does act on it, what does she do", not "does she act today". The
 * relative timing of the conversation is preserved as the window slides.
 */
function firstPlan(mk: (now: number) => GiftContext, days = 40) {
  for (let d = 0; d < days; d++) {
    const p = planGift(mk(T0 + d * DAY));
    if (p) return p;
  }
  return null;
}

describe('generosity survives personas written before the field existed', () => {
  it('reads a missing value as the default, not as zero', () => {
    // `undefined` compared against a threshold is silently false — the trap
    // that turns a new persona field into "she never does that", with no error.
    expect(generosityOf({ generosity: undefined as unknown as number })).toBe(0.35);
    expect(generosityOf({ generosity: 0 })).toBe(0);
    expect(generosityOf({ generosity: 5 })).toBe(1);
  });
});

describe('the gates', () => {
  it('says no on an ordinary day', () => {
    // No date, no fight, no bad day: the only candidate is `treat`, whose odds
    // are ~6%. Across a year of ordinary days that is a handful of surprises.
    let gifts = 0;
    for (let d = 0; d < 60; d++) {
      const now = T0 + d * DAY;
      if (planGift(ctx({ now, recent: [said('在干嘛', now - HOUR)] }))) gifts++;
    }
    expect(gifts).toBeLessThan(12);
    // …but it is not a hard no. A friend who has NEVER once done it is its own
    // kind of tell.
    expect(gifts).toBeGreaterThan(0);
  });

  it('never sends to someone she barely knows', () => {
    expect(planGift(ctx({ affinity: 5, occasions: [birthday] }))).toBeNull();
  });

  it('never sends into a conversation that has gone quiet', () => {
    const stale = T0 - GIFT_LIVENESS_MS - HOUR;
    expect(planGift(ctx({ occasions: [birthday], recent: [said('嗯', stale)] }))).toBeNull();
  });

  it('respects the cooldown for ordinary reasons', () => {
    // Inside the cooldown, no number of days (i.e. no number of dice rolls)
    // produces a festival packet; outside it, one eventually does.
    const inside = firstPlan((now) => ctx({ now, occasions: [festival], lastGiftAt: now - DAY, recent: [said('在干嘛', now - HOUR)] }));
    expect(inside?.reason).not.toBe('festival');
    const outside = firstPlan((now) =>
      ctx({
        now,
        occasions: [festival],
        lastGiftAt: now - GIFT_COOLDOWN_MS - DAY,
        recent: [said('在干嘛', now - HOUR)],
      }),
    );
    expect(outside?.reason).toBe('festival');
  });

  it('lets a birthday jump the cooldown but not the same day twice', () => {
    // A birthday comes once a year; making it wait five days for an unrelated
    // packet would be the queue overruling the point.
    expect(planGift(ctx({ occasions: [birthday], lastGiftAt: T0 - 3 * DAY }))?.reason).toBe(
      'birthday',
    );
    expect(planGift(ctx({ occasions: [birthday], lastGiftAt: T0 - HOUR }))).toBeNull();
  });

  it('a persona with generosity 0 never sends anything', () => {
    expect(
      planGift(ctx({ persona: persona({ generosity: 0 }), occasions: [birthday] })),
    ).toBeNull();
  });

  it('re-running the same day cannot re-roll a no into a yes', () => {
    // The foreground pass runs on every return to the app. Seeding on
    // (contact, day, reason) is what stops five glances at the phone from
    // becoming five chances at a gift.
    const base = ctx({ occasions: [festival] });
    const shape = (p: ReturnType<typeof planGift>) =>
      p && { reason: p.reason, kind: p.kind, amountFen: p.amountFen, note: p.note };
    // Only `fireAt` may move (it is relative to the call); the decision itself
    // is a function of the day, not of when you happened to glance at the app.
    expect(shape(planGift(base))).toEqual(shape(planGift({ ...base, now: T0 + 3 * HOUR })));
  });
});

describe('reasons, in priority order', () => {
  it('a birthday outranks everything else on the same day', () => {
    const p = planGift(
      ctx({ occasions: [birthday, festival], recent: [said('好累啊', T0 - HOUR)] }),
    );
    expect(p?.reason).toBe('birthday');
    expect(p?.kind).toBe('rp');
  });

  it('an apology follows a fight — but not while it is still happening', () => {
    const justNow = [said('滚', T0 - 5 * 60_000)];
    expect(conflictRecently(justNow, T0)).toBe(false);
    // Money sent mid-argument is not an apology, it is a way of ending the
    // conversation.
    expect(planGift(ctx({ recent: justNow }))?.reason).not.toBe('apology');

    expect(
      conflictRecently([said('烦死了别说了', T0 - 3 * HOUR), said('...', T0 - 2 * HOUR, 'ai_lin')], T0),
    ).toBe(true);
    const p = firstPlan((now) =>
      ctx({
        now,
        recent: [said('烦死了别说了', now - 3 * HOUR), said('...', now - 2 * HOUR, 'ai_lin')],
      }),
    );
    expect(p?.reason).toBe('apology');
    // A transfer, not a packet: the amount is visible and it carries a note.
    expect(p?.kind).toBe('transfer');
  });

  it('a bad day gets something small and soon', () => {
    expect(userNeedsCheeringUp([said('今天加班到现在，好累', T0 - 2 * HOUR)], T0)).toBe(true);
    let firedAt = 0;
    const p = firstPlan((now) => {
      firedAt = now;
      return ctx({ now, recent: [said('今天加班到现在，好累', now - 2 * HOUR)] });
    });
    expect(p?.reason).toBe('comfort');
    // Within the hour or so, not tomorrow morning — a reaction, not a plan.
    expect(p!.fireAt - firedAt).toBeLessThan(HOUR);
    expect(p!.amountFen).toBeLessThanOrEqual(3_000);
  });

  it('reads yesterday’s bad day as over', () => {
    expect(userNeedsCheeringUp([said('好累', T0 - 20 * HOUR)], T0)).toBe(false);
  });
});

describe('the amounts are amounts a person would pick', () => {
  it('every rung is a round or lucky number', () => {
    // 5.20 (我爱你) / 13.14 (一生一世) / 66.66 / 88.88 / 33.44 (生生世世) are the
    // amounts people actually send; ¥37.42 is what a random number generator
    // sends. Whitelisted rather than pattern-matched, because "looks lucky" is
    // culture, not arithmetic — a new rung should have to be argued for here.
    const LUCKY = new Set([
      520, 666, 888, 1_000, 1_500, 1_666, 1_800, 2_000, 2_500, 3_000, 3_344, 5_200, 6_666, 8_888,
      13_140,
    ]);
    const seen = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const rng = () => (i % 7) / 7;
      for (const r of ['birthday', 'apology', 'comfort', 'festival', 'treat'] as const) {
        seen.add(amountFor(r, i / 40, rng));
      }
    }
    for (const fen of seen) {
      expect(Number.isInteger(fen)).toBe(true); // rule #3: money is integer fen
      expect(LUCKY.has(fen), `${fen} 分不是人会发的数字`).toBe(true);
    }
  });

  it('a stingy persona picks lower rungs than a lavish one', () => {
    const rng = () => 0.9; // no jitter either way
    expect(amountFor('birthday', 0.1, rng)).toBeLessThan(amountFor('birthday', 0.95, rng));
  });
});

describe('group packets', () => {
  const members = [
    { contactId: 'ai_lin', persona: persona() },
    { contactId: 'ai_ada', persona: persona({ contactId: 'ai_ada' }) },
  ];

  it('only ever fire on a festival', () => {
    expect(
      planGroupGift({ now: T0, convId: 'g1', members, occasions: [], lastMsgAt: T0 - HOUR }),
    ).toBeNull();
    // An apology or a "you seem sad" packet in front of eight people is a
    // different, worse gesture — so those reasons never reach a group at all.
    expect(
      planGroupGift({
        now: T0,
        convId: 'g1',
        members,
        occasions: [{ label: '认识 100 天', inDays: 0, kind: 'anniversary' }],
        lastMsgAt: T0 - HOUR,
      }),
    ).toBeNull();
  });

  it('produce ONE packet with a share for everyone, not one packet each', () => {
    // Twelve packets on New Year's Day is a stress test, not a group chat.
    const p = planGroupGift({
      now: T0,
      convId: 'g1',
      members,
      occasions: [festival],
      lastMsgAt: T0 - HOUR,
    });
    if (p) {
      expect(p.count).toBe(members.length + 1); // +1: the user gets a share too
      expect(p.amountFen % p.count).toBe(0);
      expect(members.some((m) => m.contactId === p.contactId)).toBe(true);
    }
  });

  it('stay quiet in a group nobody is using', () => {
    expect(
      planGroupGift({
        now: T0,
        convId: 'g1',
        members,
        occasions: [festival],
        lastMsgAt: T0 - GIFT_LIVENESS_MS - DAY,
      }),
    ).toBeNull();
  });
});
