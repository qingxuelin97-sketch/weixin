import { describe, it, expect } from 'vitest';
import { isActiveAt, nextHeartbeatAt } from '../../src/ai/heartbeat';
import { effectiveTier } from '../../src/ai/engine';
import type { PersonaVM } from '../../src/data/types';
import { makePersona } from '../../src/data/persona-defaults';

function persona(over: Partial<PersonaVM> = {}): PersonaVM {
  return makePersona({ contactId: 'ai_lin', core: '测试人设', proactivity: 0.5, ...over });
}

const at = (h: number) => new Date(2025, 7, 6, h, 0, 0).getTime();

describe('isActiveAt', () => {
  it('matches a normal daytime window', () => {
    const p = persona({ activeHours: [[9, 23]] });
    expect(isActiveAt(p, at(12))).toBe(true);
    expect(isActiveAt(p, at(3))).toBe(false);
    expect(isActiveAt(p, at(23))).toBe(false); // end is exclusive
  });

  it('handles a window wrapping past midnight (night owl)', () => {
    const p = persona({ activeHours: [[14, 26]] }); // 14:00–02:00
    expect(isActiveAt(p, at(20))).toBe(true);
    expect(isActiveAt(p, at(1))).toBe(true);
    expect(isActiveAt(p, at(10))).toBe(false);
  });
});

describe('nextHeartbeatAt', () => {
  it('is deterministic for the same persona and day (replay-safe)', () => {
    const p = persona();
    const from = at(10);
    expect(nextHeartbeatAt(p, from)).toBe(nextHeartbeatAt(p, from));
  });

  it('always lands inside an active window', () => {
    const p = persona({ activeHours: [[9, 23]] });
    for (const h of [0, 3, 7, 12, 18, 22]) {
      const t = nextHeartbeatAt(p, at(h));
      expect(isActiveAt(p, t)).toBe(true);
    }
  });

  it('schedules strictly in the future', () => {
    const from = at(10);
    expect(nextHeartbeatAt(persona(), from)).toBeGreaterThan(from);
  });

  it('gives a higher-proactivity persona a sooner heartbeat', () => {
    const from = at(10);
    const eager = nextHeartbeatAt(persona({ proactivity: 0.9 }), from);
    const shy = nextHeartbeatAt(persona({ proactivity: 0.1 }), from);
    expect(eager).toBeLessThan(shy);
  });

  it('differs between personas (no lockstep messaging)', () => {
    const from = at(10);
    const a = nextHeartbeatAt(persona({ contactId: 'ai_lin' }), from);
    const b = nextHeartbeatAt(persona({ contactId: 'ai_ada' }), from);
    expect(a).not.toBe(b);
  });
});

describe('effectiveTier', () => {
  it('is off whenever the persona does not permit NSFW', () => {
    expect(effectiveTier('full', false)).toBe('off');
    expect(effectiveTier('ambiguous', false)).toBe('off');
  });

  it('lets the global tier through when the persona permits', () => {
    expect(effectiveTier('full', true)).toBe('full');
    expect(effectiveTier('ambiguous', true)).toBe('ambiguous');
    expect(effectiveTier('off', true)).toBe('off');
  });
});
