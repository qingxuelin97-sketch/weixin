/**
 * A minute-granular "now" for timestamp rendering.
 *
 * ChatList and ChatPage used to freeze `NOW` to a 2025 constant for screenshot
 * stability — which made every LIVE message (stamped Date.now(), a year past the
 * constant) hit the negative-diff branch and render as a weekday ("星期六")
 * instead of a time. Screenshot stability now comes from Playwright's clock API
 * (tests set a fixed browser time), so components can use the real clock.
 *
 * Ticks on the minute boundary — timestamps have minute granularity, so
 * re-rendering more often is waste, and less often shows stale "刚刚".
 */
import { useEffect, useState } from 'react';

export function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    // First tick lands on the next minute boundary, then every minute.
    let interval: ReturnType<typeof setInterval> | undefined;
    const align = setTimeout(() => {
      setNow(Date.now());
      interval = setInterval(() => setNow(Date.now()), 60_000);
    }, 60_000 - (Date.now() % 60_000));
    return () => {
      clearTimeout(align);
      if (interval) clearInterval(interval);
    };
  }, []);
  return now;
}
