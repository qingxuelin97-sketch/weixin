import { describe, it, expect } from 'vitest';
import { assembleSystemPrompt, promptStats, PROMPT_LIMITS } from '../../src/ai/prompt';
import { makePersona, PERSONA_LIMITS } from '../../src/data/persona-defaults';

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

/* ==================== length gates (M-G0) ==================== */

/**
 * Until M-G0 there was no limit anywhere: no `maxLength` on the five persona
 * inputs, no clamp on the write path, and no truncation or statistics in the
 * assembler. The BOUNDED parts of a prompt add up to about 2.5k characters;
 * persona core, few-shots, NSFW samples, the relations map and a group roster
 * were all unbounded, so one pasted essay rode along on every single turn.
 */
describe('the prompt has a ceiling', () => {
  it('clips a pasted essay of a persona', () => {
    const essay = '很'.repeat(5000);
    const p = assembleSystemPrompt({
      persona: { ...persona, core: essay },
      nsfwTier: 'off',
      scene,
    });
    expect(p.length).toBeLessThan(PROMPT_LIMITS.core + 1500);
    expect(p).toContain('…');
  });

  it('caps how many few-shots, catchphrases and NSFW samples get through', () => {
    const p = assembleSystemPrompt({
      persona: {
        ...persona,
        fewShots: Array.from({ length: 40 }, (_, i) => `样例${i}`),
        catchphrases: Array.from({ length: 40 }, (_, i) => `口${i}`),
        nsfwStyleSamples: Array.from({ length: 40 }, (_, i) => `亲密${i}`),
      },
      nsfwTier: 'full',
      scene,
    });
    expect((p.match(/- 样例\d+/g) ?? []).length).toBe(PROMPT_LIMITS.fewShots);
    expect((p.match(/口\d+/g) ?? []).length).toBe(PROMPT_LIMITS.catchphrases);
    expect((p.match(/- 亲密\d+/g) ?? []).length).toBe(PROMPT_LIMITS.nsfwSamples);
  });

  it('caps the relations map but never drops the user', () => {
    const relations: Record<string, string> = { user: '男朋友' };
    for (let i = 0; i < 30; i++) relations[`朋友${i}`] = '大学同学';
    const p = assembleSystemPrompt({ persona, relations, nsfwTier: 'off', scene });
    // Whatever else is cut, who the user is to her is the one relation that
    // must survive — it is the whole premise of the conversation.
    expect(p).toContain('用户：男朋友');
    expect((p.match(/大学同学/g) ?? []).length).toBeLessThanOrEqual(PROMPT_LIMITS.relations);
  });

  it('caps a large group roster and says how many there really are', () => {
    const roster = Array.from({ length: 60 }, (_, i) => `成员${i}`);
    const p = assembleSystemPrompt({
      persona,
      nsfwTier: 'off',
      scene: { kind: 'group', now: scene.now, groupRoster: roster },
    });
    expect((p.match(/成员\d+/g) ?? []).length).toBe(PROMPT_LIMITS.roster);
    // The actor still needs to know it is a big room, not a 20-person one.
    expect(p).toContain('等 60 人');
  });

  it('reports its own size so growth is not invisible', () => {
    const small = assembleSystemPrompt({ persona, nsfwTier: 'off', scene });
    expect(promptStats(small).overBudget).toBe(false);
    expect(promptStats(small).chars).toBe(small.length);
    expect(promptStats('x'.repeat(PROMPT_LIMITS.totalWarn + 1)).overBudget).toBe(true);
  });

  it('a fully loaded persona still lands well under the warning line', () => {
    // The realistic worst case: every field at its cap, full tier, a big group,
    // a full relations map. This is the number that used to be unbounded.
    const relations: Record<string, string> = { user: '男朋友' };
    for (let i = 0; i < 30; i++) relations[`朋友${i}`] = '大'.repeat(200);
    const p = assembleSystemPrompt({
      persona: {
        name: '林小雨',
        core: '很'.repeat(5000),
        speechStyle: '短'.repeat(500),
        fewShots: Array.from({ length: 40 }, () => '样'.repeat(500)),
        catchphrases: Array.from({ length: 40 }, () => '口'.repeat(500)),
        nsfwStyleSamples: Array.from({ length: 40 }, () => '亲'.repeat(500)),
      },
      relations,
      nsfwTier: 'full',
      memory: {
        pinned: Array.from({ length: 10 }, (_, i) => `钉住的事${i}`),
        topK: Array.from({ length: 20 }, (_, i) => `记得的事${i}`),
      },
      scene: {
        kind: 'group',
        now: scene.now,
        groupRoster: Array.from({ length: 60 }, (_, i) => `成员${i}`),
      },
    });
    expect(promptStats(p).overBudget).toBe(false);
  });
});

/**
 * The store-side half of the same gate. `prompt.ts` truncating on the way out
 * protects the MODEL; this protects the DATABASE — and it is not redundant,
 * because the editor's `maxLength` only guards typing, not paste-then-save,
 * and not the two writers that bypass the editor entirely (SillyTavern import
 * and AI-authored cards, both landing in M-G6).
 */
describe('personas are clamped on the way into the store', () => {
  it('makePersona clamps, so no writer can bypass it', () => {
    const p = makePersona({
      contactId: 'ai_x',
      core: '很'.repeat(5000),
      fewShots: Array.from({ length: 40 }, () => '样'.repeat(500)),
      nsfwStyleSamples: Array.from({ length: 40 }, () => '亲'.repeat(500)),
    });
    expect(p.core.length).toBe(PERSONA_LIMITS.core);
    expect(p.fewShots.length).toBe(PERSONA_LIMITS.fewShots);
    expect(p.fewShots[0].length).toBe(PERSONA_LIMITS.fewShotChars);
    expect(p.nsfwStyleSamples!.length).toBe(PERSONA_LIMITS.nsfwSamples);
  });

  it('leaves an ordinary persona untouched', () => {
    const p = makePersona({ contactId: 'ai_y', core: '25岁插画师', catchphrases: ['哈哈'] });
    expect(p.core).toBe('25岁插画师');
    expect(p.catchphrases).toEqual(['哈哈']);
    // An absent optional stays absent rather than becoming an empty array —
    // `undefined` and `[]` mean different things to the NSFW layer.
    expect(p.nsfwStyleSamples).toBeUndefined();
  });
});
