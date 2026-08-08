import { describe, it, expect } from 'vitest';
import { moodOf } from '../../src/lib/mood';
import { relationsForPrompt, assembleSystemPrompt } from '../../src/ai/prompt';

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
