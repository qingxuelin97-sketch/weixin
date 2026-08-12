import { describe, it, expect } from 'vitest';
import {
  daysBetween,
  festivalsNear,
  birthdayNear,
  anniversaryToday,
  occasionsFor,
  occasionDirective,
} from '../../src/ai/occasions';

/**
 * Time sense (M-H1).
 *
 * She has had a mood and a life since M-E but no sense of the DATE, and
 * knowing what day it is turns out to be the cheapest "this is a person"
 * signal available: no model call, no timer, no new scheduled kind.
 *
 * The tests that matter here are the ones about RESTRAINT. Getting her to
 * mention an occasion is trivial; getting her not to open every December
 * conversation with a greeting card is the actual design.
 */

/** Local midnight, so these assertions are timezone-independent. */
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();

describe('day arithmetic counts days, not hours', () => {
  it('treats 23:59 and 00:01 as different days', () => {
    expect(daysBetween(at(2026, 3, 1, 23), at(2026, 3, 2, 0))).toBe(1);
  });

  it('treats two times on the same day as zero apart', () => {
    // The naive `(b - a) / DAY` version returns 0.4 here and rounds to 0 by
    // luck; at 09:00 → 22:00 it returns 0.54 and rounds to 1, which would make
    // "认识 100 天" fire on the wrong day depending on the hour you opened the app.
    expect(daysBetween(at(2026, 3, 1, 9), at(2026, 3, 1, 22))).toBe(0);
  });
});

describe('festivals', () => {
  it('finds today and the next couple of days', () => {
    const eve = festivalsNear(at(2025, 12, 24));
    expect(eve.map((o) => o.label)).toContain('平安夜');
    expect(eve.find((o) => o.label === '圣诞节')?.inDays).toBe(1);
  });

  it('says nothing on an ordinary day', () => {
    expect(festivalsNear(at(2026, 3, 17))).toHaveLength(0);
  });
});

describe('birthdays come from memory, not from a field nobody fills in', () => {
  const facts = (...t: string[]) => t.map((fact) => ({ fact }));

  it('reads a date out of a remembered sentence', () => {
    const b = birthdayNear(facts('他生日是 5 月 20 日'), at(2026, 5, 19));
    expect(b?.inDays).toBe(1);
    expect(b?.kind).toBe('birthday');
  });

  it('accepts 号 as well as 日, because people write both', () => {
    expect(birthdayNear(facts('生日 3月2号'), at(2026, 3, 2))?.inDays).toBe(0);
  });

  it('rolls over the year end rather than missing January', () => {
    // Late December looking at a January birthday: the naive "this year only"
    // version reports a negative distance and drops it.
    expect(birthdayNear(facts('生日是1月2日'), at(2025, 12, 31))?.inDays).toBe(2);
  });

  it('ignores a birthday that is still months away', () => {
    expect(birthdayNear(facts('生日是 5 月 20 日'), at(2026, 1, 1))).toBeNull();
  });

  it('ignores nonsense dates and unrelated facts', () => {
    expect(birthdayNear(facts('生日是 13 月 40 日'), at(2026, 1, 1))).toBeNull();
    expect(birthdayNear(facts('他喜欢 5 月 20 日的天气'), at(2026, 5, 20))).toBeNull();
  });
});

describe('anniversaries are only ever round numbers', () => {
  it('fires on a milestone', () => {
    expect(anniversaryToday(at(2026, 1, 1), at(2026, 4, 11))?.label).toBe('认识 100 天');
  });

  it('says nothing on day 87', () => {
    // "认识 87 天了" is a thing a database says. Saying it is worse than
    // saying nothing, because it reveals the counter behind her.
    expect(anniversaryToday(at(2026, 1, 1), at(2026, 3, 29))).toBeNull();
  });

  it('says nothing at all when the conversation has no history', () => {
    expect(anniversaryToday(undefined, at(2026, 1, 1))).toBeNull();
  });
});

describe('restraint', () => {
  it('never surfaces more than two occasions', () => {
    const out = occasionsFor({
      now: at(2025, 12, 31),
      facts: [{ fact: '生日是 1 月 1 日' }],
      firstMsgAt: at(2025, 12, 1),
    });
    expect(out.length).toBeLessThanOrEqual(2);
  });

  it('puts a personal date ahead of a calendar one on the same day', () => {
    const out = occasionsFor({
      now: at(2026, 2, 14),
      facts: [{ fact: '生日是 2 月 14 日' }],
    });
    // A shared holiday matters less than this person's own day.
    expect(out[0].kind).toBe('birthday');
  });

  it('produces nothing at all on an ordinary day', () => {
    const out = occasionsFor({ now: at(2026, 3, 17), facts: [], firstMsgAt: at(2026, 3, 1) });
    expect(out).toHaveLength(0);
    // Silence is the default: every line here competes with the persona.
    expect(occasionDirective(out)).toBe('');
  });

  it('phrases it as awareness, not as an instruction to announce', () => {
    const line = occasionDirective(occasionsFor({ now: at(2025, 12, 25), facts: [] }));
    expect(line).toContain('圣诞节');
    expect(line).toContain('由你决定');
    expect(line).toContain('别写成祝福语');
  });
});
