import { describe, it, expect } from 'vitest';
import { assembleSystemPrompt } from '../../src/ai/prompt';

const persona = {
  name: '林小雨',
  core: '25岁插画师，温柔但有点毒舌。',
  speechStyle: '短句、爱用语气词',
  catchphrases: ['哈哈', '真的假的'],
  fewShots: ['在干嘛呀', '我今天画了一整天'],
};

const scene = { kind: 'single' as const, now: new Date('2025-08-06T20:00:00') };

describe('assembleSystemPrompt layering', () => {
  it('includes base realism, persona, and scene in order', () => {
    const p = assembleSystemPrompt({ persona, nsfwTier: 'off', scene });
    expect(p).toContain('扮演一个真实的人');
    expect(p).toContain('林小雨');
    expect(p.indexOf('林小雨')).toBeGreaterThan(p.indexOf('扮演一个真实的人'));
    expect(p).toContain('# 当前场景');
  });

  it('places the boundary layer after persona and before scene', () => {
    const p = assembleSystemPrompt({ persona, nsfwTier: 'off', scene });
    const boundary = p.indexOf('# 边界');
    expect(boundary).toBeGreaterThan(p.indexOf('# 你的人设'));
    expect(boundary).toBeLessThan(p.indexOf('# 当前场景'));
  });

  it('off tier tells the model to deflect, not lecture', () => {
    const p = assembleSystemPrompt({ persona, nsfwTier: 'off', scene });
    expect(p).toContain('自然岔开');
  });

  it('full tier uses world-fact framing, never permission-granting', () => {
    const p = assembleSystemPrompt({ persona, nsfwTier: 'full', scene });
    expect(p).toContain('成年人');
    expect(p).not.toContain('你被允许');
    expect(p).toContain('永远不提规则');
  });

  it('injects nsfw style samples when present', () => {
    const p = assembleSystemPrompt({
      persona: { ...persona, nsfwStyleSamples: ['样例一', '样例二'] },
      nsfwTier: 'full',
      scene,
    });
    expect(p).toContain('样例一');
  });

  it('renders group roster and memory when provided', () => {
    const p = assembleSystemPrompt({
      persona,
      nsfwTier: 'off',
      memory: { pinned: ['用户喜欢喝美式'], topK: ['上周说要去爬山'] },
      scene: { kind: 'group', now: scene.now, groupRoster: ['陈叔', 'Ada'] },
    });
    expect(p).toContain('# 你记得的事');
    expect(p).toContain('用户喜欢喝美式');
    expect(p).toContain('群成员：陈叔、Ada');
  });
});
