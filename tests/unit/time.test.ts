import { describe, it, expect } from 'vitest';
import { listTimestamp, chatTimestamp, shouldShowTimeBar } from '../../src/lib/time';

const now = new Date('2025-08-06T20:00:00').getTime();
const min = 60_000;
const hr = 60 * min;
const day = 24 * hr;

describe('listTimestamp', () => {
  it('shows HH:mm for today', () => {
    expect(listTimestamp(now - 30 * min, now)).toBe('19:30');
  });
  it('shows 昨天 for yesterday', () => {
    expect(listTimestamp(now - day, now)).toBe('昨天');
  });
  it('shows weekday within a week', () => {
    const threeDaysAgo = now - 3 * day; // 2025-08-03 is a Sunday
    expect(listTimestamp(threeDaysAgo, now)).toMatch(/星期/);
  });
  it('shows M/D beyond a week', () => {
    expect(listTimestamp(now - 10 * day, now)).toBe('7/27');
  });
});

describe('chatTimestamp', () => {
  it('shows 昨天 HH:mm', () => {
    expect(chatTimestamp(now - day, now)).toBe('昨天 20:00');
  });
});

describe('shouldShowTimeBar', () => {
  it('always shows for the first message', () => {
    expect(shouldShowTimeBar(null, now)).toBe(true);
  });
  it('hides when gap <= 5 min', () => {
    expect(shouldShowTimeBar(now, now + 4 * min)).toBe(false);
  });
  it('shows when gap > 5 min', () => {
    expect(shouldShowTimeBar(now, now + 6 * min)).toBe(true);
  });
});
