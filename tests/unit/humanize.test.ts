import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { humanizePersona, validateHumanizePatch, HUMANIZE_LEVEL_LABELS } from '../../src/ai/humanize';
import { humanizeSystem, describePersona, fieldsFor } from '../../src/ai/humanize-prompt';
import { applyPersonaPatch } from '../../src/data/persona-patch';
import { makePersona } from '../../src/data/persona-defaults';

/**
 * 一键提示词拟人化 (M-I2).
 *
 * The catastrophic failure mode is silent: a rewrite path that routes through
 * makePersona (defaults backfill) or validateGeneratedPersona (relations
 * rebuild) destroys user data while producing a perfectly plausible persona.
 * These tests hold the patch discipline and the level contracts.
 */

const persona = makePersona({
  contactId: 'ai_x',
  core: '川妹子插画师，嘴硬心软',
  speechStyle: '短句',
  fewShots: ['在画了在画了', '你吃了吗'],
  catchphrases: ['要得'],
  nsfwStyleSamples: ['样本'],
  modelChat: 'prov:m',
  relations: { user: '损友' },
});

describe('the patch discipline', () => {
  it('humanize.ts never imports the two destructive validators (source guard)', () => {
    const src = readFileSync(resolve(__dirname, '../../src/ai/humanize.ts'), 'utf8');
    // Both names appear in the WHY-comment; what must never appear is an
    // import binding or a call.
    expect(/import\s*\{[^}]*makePersona[^}]*\}/.test(src)).toBe(false);
    expect(/import\s*\{[^}]*validateGeneratedPersona[^}]*\}/.test(src)).toBe(false);
    expect(src.includes("from './persona-generate'")).toBe(false);
    expect(/validateGeneratedPersona\s*\(/.test(src)).toBe(false);
    // And it must go through the one sanctioned applier at the UI edge.
    const page = readFileSync(
      resolve(__dirname, '../../src/features/settings/PersonaEditPage.tsx'),
      'utf8',
    );
    expect(page).toContain('applyPersonaPatch');
    expect(page).toContain('humanizePersona');
  });

  it('the group batch entry is wired with the distinctiveness constraint', () => {
    const info = readFileSync(
      resolve(__dirname, '../../src/features/chat/ChatInfoPage.tsx'),
      'utf8',
    );
    expect(info).toContain('humanizePersona');
    expect(info).toContain('siblingCatchphrases');
    expect(info).toContain('applyPersonaPatch');
    // ST import offers the rewrite while the card is still under review.
    const edit = readFileSync(
      resolve(__dirname, '../../src/features/settings/PersonaEditPage.tsx'),
      'utf8',
    );
    expect(edit).toContain('顺手拟人化');
  });

  it('locked fields in the model output are dropped, not applied', () => {
    const out = validateHumanizePatch(
      {
        speechStyle: '新风格',
        catchphrases: ['巴适'],
        fewShots: ['a', 'b', 'c'],
        relations: { hacked: 'x' },
        nsfwStyleSamples: [],
        modelChat: 'evil:model',
      },
      'light',
    );
    expect(out.ok).toBe(true);
    const applied = applyPersonaPatch(persona, out.value!).persona;
    expect(applied.relations).toEqual({ user: '损友' });
    expect(applied.nsfwStyleSamples).toEqual(['样本']);
    expect(applied.modelChat).toBe('prov:m');
    expect(applied.speechStyle).toBe('新风格');
  });

  it('light level cannot touch core even if the model writes one', () => {
    const out = validateHumanizePatch(
      { core: '全新的人', speechStyle: 's', catchphrases: ['x'], fewShots: ['a', 'b', 'c'] },
      'light',
    );
    expect(out.ok).toBe(true);
    expect(out.value!.core).toBeUndefined();
    // Medium may.
    const mid = validateHumanizePatch({ core: '有来历的人' }, 'medium');
    expect(mid.ok).toBe(true);
    expect(mid.value!.core).toBe('有来历的人');
  });

  it('an empty or garbage patch is a repairable issue, not a success', () => {
    expect(validateHumanizePatch('not an object', 'light').ok).toBe(false);
    expect(validateHumanizePatch({}, 'light').ok).toBe(false);
    expect(validateHumanizePatch({ fewShots: ['只有一条'] }, 'light').ok).toBe(false);
  });

  it('batch distinctiveness: a sibling-taken catchphrase is rejected', () => {
    const out = validateHumanizePatch(
      { speechStyle: 's', catchphrases: ['要得', '新词'], fewShots: ['a', 'b', 'c'] },
      'light',
      { siblingCatchphrases: ['要得'] },
    );
    expect(out.ok).toBe(false);
    expect(out.issues.some((i) => i.code === 'dup_voice')).toBe(true);
    // The repair message names the clash, or the fix round is guesswork.
    expect(out.issues.find((i) => i.code === 'dup_voice')!.message).toContain('要得');
  });
});

describe('the prompt craft', () => {
  it('levels expose exactly their field sets', () => {
    expect(fieldsFor('light')).not.toContain('core');
    expect(fieldsFor('medium')).toContain('core');
    for (const level of ['light', 'medium', 'heavy'] as const) {
      const sys = humanizeSystem(level);
      for (const f of fieldsFor(level)) expect(sys).toContain(`"${f}"`);
      expect(HUMANIZE_LEVEL_LABELS[level]).toBeTruthy();
    }
  });

  it('the negative list and texture instructions are present at every level', () => {
    for (const level of ['light', 'medium', 'heavy'] as const) {
      const sys = humanizeSystem(level);
      expect(sys).toContain('禁止泛泛而谈');
      expect(sys).toContain('口头禅');
    }
    // Flaws only from medium up: light is a voice pass, not a character pass.
    expect(humanizeSystem('light')).not.toContain('自相矛盾');
    expect(humanizeSystem('medium')).toContain('缺陷与自相矛盾');
  });

  it('heavy embeds the extracted invariants and the sibling constraint lands verbatim', () => {
    const sys = humanizeSystem('heavy', { invariants: '- 名字：小雨\n- 职业：插画师', siblings: ['要得'] });
    expect(sys).toContain('硬事实不变量');
    expect(sys).toContain('插画师');
    expect(sys).toContain('要得');
  });

  it('describePersona is deterministic and complete', () => {
    const a = describePersona(persona, '小雨');
    expect(a).toBe(describePersona(persona, '小雨'));
    expect(a).toContain('川妹子');
    expect(a).toContain('在画了在画了');
  });
});

describe('the chain', () => {
  it('heavy runs the extract step first and feeds it into the rewrite', async () => {
    const calls: string[] = [];
    const out = await humanizePersona(persona, '小雨', 'heavy', {
      complete: async (messages) => {
        calls.push(messages[0].content.slice(0, 12));
        // First call is the fact-extraction step (its system opens with the
        // extract instruction); the rewrite's system ALSO mentions 硬事实, so
        // discriminate by call order, not by keyword.
        if (calls.length === 1) return '- 名字：小雨\n- 职业：插画师';
        // The rewrite must have received the invariants.
        expect(messages[0].content).toContain('插画师');
        return JSON.stringify({
          core: '重写后的核心',
          speechStyle: 's',
          catchphrases: ['巴适得板'],
          fewShots: ['a', 'b', 'c'],
        });
      },
    });
    expect(out.ok).toBe(true);
    expect(calls.length).toBe(2);
    expect(out.value!.core).toBe('重写后的核心');
  });

  it('a bad first output gets a repair round, not a save', async () => {
    let n = 0;
    const out = await humanizePersona(persona, '小雨', 'light', {
      complete: async () => {
        n++;
        return n === 1
          ? JSON.stringify({ fewShots: ['只有一条'] })
          : JSON.stringify({ speechStyle: 's', catchphrases: ['x'], fewShots: ['a', 'b', 'c'] });
      },
    });
    expect(out.ok).toBe(true);
    expect(n).toBe(2);
    expect(out.attempts.length).toBe(1);
  });
});
