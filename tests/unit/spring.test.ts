import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { springSamples, springDuration, SPRINGS } from '../../src/lib/spring';

/**
 * Spring physics (M-H3).
 *
 * Every animation in this app was a cubic-bezier, which is why nothing felt
 * like iOS: a bezier is a fixed path in a fixed time, so a sheet flicked hard
 * and a sheet nudged gently settle identically, and nothing ever overshoots.
 *
 * The constraint that decides the implementation is the SCREENSHOT GATE:
 * Playwright fast-forwards CSS animations, transitions and WAAPI to their end
 * state, and knows nothing about a requestAnimationFrame loop. So the spring
 * is integrated up front into keyframes rather than ticked — the physics is
 * real, the playback is declarative, and the gate can still freeze it.
 */

describe('the spring settles', () => {
  it('starts where it was told and ends exactly on target', () => {
    const s = springSamples(0, 100, SPRINGS.page);
    expect(s[0].value).toBe(0);
    // Exactly, not nearly: an animation that stops 0.4px short leaves a
    // visible seam against a static layout.
    expect(s[s.length - 1].value).toBe(100);
    expect(s[s.length - 1].offset).toBe(1);
  });

  it('produces offsets that WAAPI will accept', () => {
    const s = springSamples(0, 100, SPRINGS.sheet);
    expect(s[0].offset).toBe(0);
    for (let i = 1; i < s.length; i++) {
      expect(s[i].offset).toBeGreaterThan(s[i - 1].offset);
      expect(s[i].offset).toBeLessThanOrEqual(1);
    }
  });

  it('overshoots when it is meant to, and not when it is not', () => {
    const bouncy = springSamples(0, 100, SPRINGS.sheet);
    expect(Math.max(...bouncy.map((x) => x.value))).toBeGreaterThan(100);
    // A cancelled gesture springing back past zero reads as the app
    // disagreeing with you.
    const settle = springSamples(0, 100, SPRINGS.settle);
    expect(Math.max(...settle.map((x) => x.value))).toBeLessThanOrEqual(100.5);
  });

  it('takes the gesture’s velocity, which is the whole point', () => {
    const slow = springSamples(0, 100, { ...SPRINGS.page, velocity: 0 });
    const flicked = springSamples(0, 100, { ...SPRINGS.page, velocity: 1500 });
    // Handed real speed, it arrives sooner — a flick should not take as long
    // as a nudge.
    expect(springDuration(flicked)).toBeLessThan(springDuration(slow));
  });

  it('cannot run forever, whatever it is handed', () => {
    const absurd = springSamples(0, 100, { stiffness: 1, damping: 0.01, maxMs: 600 });
    expect(springDuration(absurd)).toBeLessThanOrEqual(600 + 17);
  });

  it('is deterministic — the same input twice is the same animation', () => {
    // Screenshot goldens depend on this: a spring that samples differently
    // between runs is a flaky test waiting to happen.
    expect(springSamples(0, 42, SPRINGS.pop)).toEqual(springSamples(0, 42, SPRINGS.pop));
  });
});

describe('the rule the screenshot gate depends on', () => {
  const read = (p: string) => readFileSync(resolve(__dirname, '../..', p), 'utf8');

  it('no animation code drives itself with requestAnimationFrame', () => {
    // Playwright's `animations: "disabled"` freezes CSS and WAAPI. A rAF loop
    // is invisible to it, so 22 goldens would start sampling whatever frame
    // they happened to catch — the gate would flicker and stop being trusted.
    for (const f of ['src/lib/spring.ts', 'src/app/PageStack.tsx', 'src/app/useEdgeBack.ts']) {
      expect(read(f)).not.toMatch(/requestAnimationFrame\s*\(/);
    }
  });

  it('the transition container keeps a stable key per slot', () => {
    const src = read('src/app/PageStack.tsx');
    // Keying by location would remount the outgoing tree — which re-runs every
    // cleanup, and this app's chat cleanup parks the composer draft. The
    // symptom was a typed message vanishing when you went back.
    expect(src).toContain('key={`slot-${i}`}');
  });
});
