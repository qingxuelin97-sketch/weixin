import { describe, it, expect, vi, afterEach } from 'vitest';
import { withDeadline } from '../../src/native/bridge';

/**
 * Constitution 3.5: a native "timeout" must be a REAL rejection. The old
 * failure mode was a setTimeout with an empty body racing an uncancellable
 * bridge promise — the race never settled and 测试连接 hung forever on device.
 * These tests pin the guard itself.
 */
describe('withDeadline', () => {
  afterEach(() => vi.useRealTimers());

  it('REJECTS (not hangs, not resolves) when the native promise never settles', async () => {
    vi.useFakeTimers();
    const never = new Promise<string>(() => {});
    const p = withDeadline(never, 'testCall', 1000);
    const settled = p.then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await vi.advanceTimersByTimeAsync(1001);
    await expect(settled).resolves.toContain('testCall timed out');
  });

  it('passes a timely result through and cancels its timer', async () => {
    vi.useFakeTimers();
    const p = withDeadline(Promise.resolve('ok'), 'x', 1000);
    await expect(p).resolves.toBe('ok');
    // Advancing past the deadline afterwards must not produce an unhandled
    // rejection from a zombie timer.
    await vi.advanceTimersByTimeAsync(2000);
  });

  it('propagates a native rejection unchanged', async () => {
    await expect(withDeadline(Promise.reject(new Error('bridge down')), 'y', 50)).rejects.toThrow(
      'bridge down',
    );
  });
});
