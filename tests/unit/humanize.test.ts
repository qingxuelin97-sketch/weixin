import { describe, it, expect } from 'vitest';
import { moodOf } from '../../src/lib/mood';
import { relationsForPrompt, assembleSystemPrompt } from '../../src/ai/prompt';
import { pickOpener, shouldNudge } from '../../src/ai/heartbeat';
import { makePersona } from '../../src/data/persona-defaults';

const NOON = new Date(2025, 7, 6, 12, 0, 0).getTime();
const DAY = 86_400_000;

describe('moodOf', () => {
  it('is stable for the whole day', () => {
    expect(moodOf('ai_lin', NOON)).toEqual(moodOf('ai_lin', NOON + 5 * 3_600_000));
  });

  it('can change across days and differs across contacts somewhere', () => {
    // Statistical, not per-roll: over 30 days someone's mood must vary,
    // and two contacts can't share every mood for a month.
    const days = Array.from({ length: 30 }, (_, i) => NOON + i * DAY);
    const lin = days.map((d) => moodOf('ai_lin', d).key);
    const ada = days.map((d) => moodOf('ai_ada', d).key);
    expect(new Set(lin).size).toBeGreaterThan(1);
    expect(lin.join()).not.toBe(ada.join());
  });

  it('always yields a usable prompt line', () => {
    for (let i = 0; i < 30; i++) {
      expect(moodOf('x', NOON + i * DAY).line.length).toBeGreaterThan(3);
    }
  });
});

describe('relationsForPrompt', () => {
  const nameOf = (id: string) => (id === 'ai_ada' ? 'Ada' : undefined);

  it('translates contact ids into display names', () => {
    expect(relationsForPrompt({ ai_ada: '大学同学' }, nameOf)).toEqual({ Ada: '大学同学' });
  });

  it("keeps the 'user' key untouched", () => {
    expect(relationsForPrompt({ user: '好友' }, nameOf)).toEqual({ user: '好友' });
  });

  it('drops ids it cannot resolve instead of leaking them', () => {
    const out = relationsForPrompt({ ai_ghost: '幽灵' }, nameOf);
    expect(out).toEqual({});
    expect(JSON.stringify(out)).not.toContain('ai_ghost');
  });

  it('drops blank descriptions', () => {
    expect(relationsForPrompt({ ai_ada: '  ' }, nameOf)).toEqual({});
  });
});

describe('assembleSystemPrompt — humanization layers', () => {
  const base = {
    persona: { name: '林小雨', core: '插画师' },
    nsfwTier: 'off' as const,
    scene: { kind: 'single' as const, now: new Date(NOON) },
  };

  it('carries the anti-AI-voice hard rules', () => {
    const p = assembleSystemPrompt(base);
    expect(p).toContain('禁止列表');
    expect(p).toContain('客服式收尾');
    expect(p).toContain('回复长短跟着对方走');
  });

  it('renders the relations block with translated names', () => {
    const p = assembleSystemPrompt({
      ...base,
      relations: relationsForPrompt({ user: '好友', ai_ada: '大学同学' }, () => 'Ada'),
    });
    expect(p).toContain('# 关系');
    expect(p).toContain('用户：好友');
    expect(p).toContain('Ada：大学同学');
    expect(p).not.toContain('ai_ada');
  });

  it('injects the mood line into the scene layer', () => {
    const p = assembleSystemPrompt({
      ...base,
      scene: { ...base.scene, moodLine: moodOf('ai_lin', NOON).line },
    });
    expect(p).toContain(moodOf('ai_lin', NOON).line);
  });

  it('omits the relations block when there are none', () => {
    expect(assembleSystemPrompt(base)).not.toContain('# 关系');
  });
});

describe('pickOpener (主动性素材)', () => {
  const facts = [
    { fact: '他下周要面试', status: 'confirmed' },
    { fact: '待定的事', status: 'pending' },
  ];

  it('is deterministic per seed', () => {
    expect(pickOpener(facts, '晒图', 's1')).toEqual(pickOpener(facts, '晒图', 's1'));
  });

  it('only ever follows up on confirmed facts', () => {
    for (let i = 0; i < 60; i++) {
      const o = pickOpener(facts, undefined, `s${i}`);
      if (o.kind === 'memory') expect(o.directive).toContain('他下周要面试');
      expect(o.directive).not.toContain('待定的事');
    }
  });

  it('uses all three sources across seeds — never a fixed priority', () => {
    const kinds = new Set(
      Array.from({ length: 100 }, (_, i) => pickOpener(facts, '刚发的朋友圈', `s${i}`).kind),
    );
    expect(kinds).toEqual(new Set(['memory', 'moment', 'greeting']));
  });

  it('falls back to a plain greeting with no material at all', () => {
    expect(pickOpener([], undefined, 's').kind).toBe('greeting');
  });
});

describe('shouldNudge (未回追问)', () => {
  const HOUR = 3_600_000;
  const p = makePersona({ contactId: 'a', core: 'c', proactivity: 1 });
  const aiMsg = (ageMs: number) => ({ senderId: 'a', createdAt: NOON - ageMs, id: 7 });

  it('never nudges when the user spoke last — there is nothing to chase', () => {
    expect(shouldNudge({ senderId: 'self', createdAt: NOON - 10 * HOUR, id: 7 }, p, NOON)).toBe(false);
  });

  it('waits at least 6 hours and gives up after 48', () => {
    expect(shouldNudge(aiMsg(5 * HOUR), p, NOON)).toBe(false);
    expect(shouldNudge(aiMsg(49 * HOUR), p, NOON)).toBe(false);
  });

  it('is deterministic per ignored message — re-checking cannot flip the answer', () => {
    const m = aiMsg(10 * HOUR);
    expect(shouldNudge(m, p, NOON)).toBe(shouldNudge(m, p, NOON));
  });

  it('a zero-proactivity persona never chases', () => {
    const shy = makePersona({ contactId: 'a', core: 'c', proactivity: 0 });
    for (let id = 0; id < 50; id++) {
      expect(shouldNudge({ senderId: 'a', createdAt: NOON - 10 * HOUR, id }, shy, NOON)).toBe(false);
    }
  });

  it('handles an empty conversation', () => {
    expect(shouldNudge(undefined, p, NOON)).toBe(false);
  });
});
