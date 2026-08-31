import { describe, it, expect, vi, beforeEach } from 'vitest';
import { splitPromptSections, systemOf, turnsOf } from '../../src/ai/prompt-lab';
import { assembleSystemPrompt } from '../../src/ai/prompt';
import type { LlmExchange } from '../../src/lib/llm-recorder';

const T0 = new Date(2025, 7, 6, 12, 0, 0);

function assembled(): string {
  return assembleSystemPrompt({
    persona: {
      name: '林小雨',
      core: '爱吃辣的川妹子，做插画，嘴硬心软',
      speechStyle: '短句，爱用语气词',
      catchphrases: ['嘛', '好嘛'],
      fewShots: ['在忙，等下回你', '哈哈哈哈笑死'],
    },
    relations: { user: '认识三年的朋友' },
    nsfwTier: 'off',
    memory: { pinned: ['她妹妹在成都上大学'], topK: ['上周说想去爬山'], world: ['她住的城市常年下雨'] },
    scene: { kind: 'single', now: T0 },
  });
}

describe('splitPromptSections — 分层还原实际 prompt (M-I11)', () => {
  it('recovers the constitutional layers, in order, from a real assembly', () => {
    const sections = splitPromptSections(assembled());
    const titles = sections.map((s) => s.title);
    expect(titles[0]).toBe('基底规则');
    // The six-layer order is constitutional; the parser must reflect it, not
    // reorder or merge. (If this goes red after an assembler change, the
    // ASSEMBLER changed layer order — that needs review, not a parser fix.)
    expect(titles).toEqual(['基底规则', '你的人设', '关系', '边界', '你记得的事', '当前场景']);
  });

  it('char counts cover the whole prompt (nothing silently dropped)', () => {
    const system = assembled();
    const sections = splitPromptSections(system);
    const sum = sections.reduce((n, s) => n + s.chars, 0);
    // Separators are the only thing not attributed to a section.
    expect(sum).toBe(system.length - (sections.length - 1) * 2);
  });

  it('titles engine-appended layers by their 【tag】 or first line', () => {
    const system = `${assembled()}\n\n【生活线】这周在赶一个插画稿。\n\n最近你自己的几条消息开头都是"嘛"，换个开头。`;
    const titles = splitPromptSections(system).map((s) => s.title);
    expect(titles).toContain('生活线');
    expect(titles.at(-1)).toMatch(/^最近你自己的几条消息/);
  });

  it('handles a prompt with no headings at all', () => {
    const sections = splitPromptSections('单独一段没有标题的话');
    expect(sections).toEqual([
      { title: '基底规则', text: '单独一段没有标题的话', chars: 10 },
    ]);
  });
});

describe('systemOf / turnsOf', () => {
  const entry: LlmExchange = {
    at: 0,
    providerId: 'p',
    providerKind: 'custom',
    model: 'm',
    latencyMs: 1,
    request: [
      { role: 'system', content: 'SYS' },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' },
    ],
  };

  it('splits system from conversation turns', () => {
    expect(systemOf(entry)).toBe('SYS');
    expect(turnsOf(entry).map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('tolerates a request with no system message', () => {
    const bare = { ...entry, request: [{ role: 'user', content: 'hi' }] };
    expect(systemOf(bare)).toBeUndefined();
    expect(turnsOf(bare)).toHaveLength(1);
  });
});

describe('errlog restore order (M-I11 bug fix)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns newest-first when restoring from localStorage after a restart', async () => {
    // Storage holds append order (oldest first) — exactly what persist() writes.
    const stored = JSON.stringify([
      { at: 1, scope: 'old', message: 'first' },
      { at: 2, scope: 'new', message: 'second' },
    ]);
    const store = new Map<string, string>([['aiwx_errlog', stored]]);
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    });
    try {
      // Fresh module = empty in-memory buffer = the restore path.
      const { getErrors } = await import('../../src/lib/errlog');
      const errors = getErrors();
      expect(errors.map((e) => e.scope)).toEqual(['new', 'old']);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
