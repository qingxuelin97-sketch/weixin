import { describe, it, expect } from 'vitest';
import {
  validateGeneratedPersona,
  sanitizeHours,
  generatePersona,
} from '../../src/ai/persona-generate';
import { extractJson, runChain, MAX_REPAIRS } from '../../src/ai/generate-chain';

/**
 * AI-written persona cards (M-H2).
 *
 * A PersonaVM has two dozen fields and only two of them are things anyone
 * wants to type. The rest is behaviour — and behaviour is exactly what the
 * user cannot guess at before meeting the character, which is why every
 * hand-made agent in this app behaves identically.
 *
 * Every test below is about the CHECKING half, because each failure here is
 * silent: an impossible activeHours window does not throw, it just means she
 * is asleep forever and never speaks again.
 */

const good = {
  name: '林小满',
  signature: '在画画',
  gender: 'female',
  core: '二十六岁的自由插画师，住在成都，白天接稿晚上熬夜赶图。嘴上凶，别人真有事又第一个冲上去。怕辣但每周都要吃一次火锅，然后边吃边喊。',
  speechStyle: '短句，爱用语气词，偶尔阴阳怪气',
  fewShots: ['刚交稿，人没了', '你猜我今天吃了啥', '别问，问就是在画', '睡了睡了'],
  catchphrases: ['离谱', '真的假的'],
  greeting: '在吗，跟你说个事',
  relationUser: '认识三年的朋友，无话不谈',
  activeHours: [[10, 26]],
  proactivity: 0.7,
  typingCpm: 420,
  heartbeatBaseMin: 120,
  momentsPerDay: 0.6,
  likeRate: 0.7,
  commentRate: 0.4,
  affinityInit: 55,
  generosity: 0.6,
  grabSpeed: 'fast',
  temperature: 0.95,
  imageTags: ['插画', '不存在的标签'],
};

const opts = { contactId: 'ai_x', knownTags: ['插画', '猫'], takenNames: ['阿哲'] };

describe('a good card comes through complete', () => {
  const out = validateGeneratedPersona(good, opts);

  it('accepts it', () => {
    expect(out.ok).toBe(true);
    expect(out.value?.name).toBe('林小满');
  });

  it('keeps the numbers the model chose', () => {
    // The whole point is that a generated character is not another set of
    // defaults: a 高冷 card and a 话痨 card must differ in these.
    const p = out.value!.persona;
    expect(p.proactivity).toBeCloseTo(0.7);
    expect(p.heartbeatBaseMin).toBe(120);
    expect(p.grabSpeed).toBe('fast');
    expect(p.generosity).toBeCloseTo(0.6);
  });

  it('goes through makePersona, so nothing is left undefined', () => {
    const p = out.value!.persona;
    // `undefined` here is read downstream as "never posts" / "never likes" —
    // no error, the feature just silently does not exist for this agent.
    for (const k of ['momentsPerDay', 'likeRate', 'commentRate', 'affinityInit', 'generosity']) {
      expect(typeof (p as unknown as Record<string, unknown>)[k]).toBe('number');
    }
    expect(Array.isArray(p.imageTags)).toBe(true);
  });

  it('drops image tags the library has never heard of', () => {
    // Keeping them would make her unable to find any photo, which surfaces as
    // "she never sends pictures" rather than as an error.
    expect(out.value!.persona.imageTags).toEqual(['插画']);
  });
});

describe('the failures that would be silent', () => {
  it('rejects a name that is already taken', () => {
    const r = validateGeneratedPersona({ ...good, name: '阿哲' }, opts);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'name_taken')).toBe(true);
  });

  it('rejects a core too thin to be a person', () => {
    const r = validateGeneratedPersona({ ...good, core: '一个女孩子，很可爱。' }, opts);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.code === 'core_thin')).toBe(true);
  });

  it('rejects a card with no sample lines', () => {
    const r = validateGeneratedPersona({ ...good, fewShots: ['嗯'] }, opts);
    expect(r.ok).toBe(false);
  });

  it('rejects junk outright, with a message the model can act on', () => {
    const r = validateGeneratedPersona({ hello: 'world' }, opts);
    expect(r.ok).toBe(false);
    expect(r.issues[0].message).toContain('字段');
  });
});

describe('活动时段 that would silence an agent forever', () => {
  it('drops a window that can never match an hour', () => {
    // [22, 8] matches nothing: `isActiveAt` walks forward looking for a match
    // and finds none, so the agent is asleep for good.
    expect(sanitizeHours([[22, 8]])).toEqual([[9, 23]]);
    expect(sanitizeHours([[5, 5]])).toEqual([[9, 23]]);
    expect(sanitizeHours([])).toEqual([[9, 23]]);
  });

  it('keeps a legitimate overnight window', () => {
    // [14, 26] is 14:00 → 02:00, which the engine understands.
    expect(sanitizeHours([[14, 26]])).toEqual([[14, 26]]);
  });

  it('drops nonsense without dropping the good ones beside it', () => {
    expect(sanitizeHours([[9, 12], [30, 40]])).toEqual([[9, 12]]);
  });
});

describe('the self-repair loop', () => {
  it('hands the model its own specific failures and accepts the fix', async () => {
    const replies = [
      // Long enough to pass the schema, too thin to be a person.
      JSON.stringify({ ...good, core: '一个女孩子，很可爱，喜欢画画。' }),
      JSON.stringify(good),
    ];
    const seen: string[] = [];
    const out = await generatePersona(
      '爱吃辣的川妹子',
      {
        complete: async (messages) => {
          seen.push(messages[messages.length - 1].content);
          return replies.shift() ?? '{}';
        },
      },
      opts,
    );
    expect(out.ok).toBe(true);
    // The repair round must quote the actual problem — "invalid, try again"
    // gets the same answer back.
    expect(seen[1]).toContain('core 太短');
  });

  it('gives up with a plain error rather than storing something broken', async () => {
    const out = await generatePersona(
      'x',
      { complete: async () => 'not json at all' },
      opts,
    );
    expect(out.ok).toBe(false);
    expect(out.attempts).toHaveLength(MAX_REPAIRS + 1);
    expect(out.error).toContain('角色卡');
  });
});

describe('the shared chain (extracted from story-generate)', () => {
  it('digs JSON out of whatever prose the model wrapped it in', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('好的，这是结果：{"a":2} 希望有帮助')).toEqual({ a: 2 });
    expect(extractJson('这是数组：[1,2,3]')).toEqual([1, 2, 3]);
    expect(extractJson('完全不是 JSON')).toBeNull();
  });

  it('skips the outline step when a spec does not ask for one', async () => {
    // A card is small and structured; a prose plan for it would double the
    // cost to rephrase the same sentence.
    let calls = 0;
    await runChain(
      'x',
      {
        label: 't',
        jsonSystem: 's',
        validate: () => ({ ok: true, value: 1, issues: [] }),
      },
      {
        complete: async () => {
          calls++;
          return '{}';
        },
      },
    );
    expect(calls).toBe(1);
  });

  it('reports progress so a long chain is not a frozen screen', async () => {
    const notes: string[] = [];
    await runChain(
      'x',
      {
        label: '群蓝图',
        outlineSystem: 'o',
        jsonSystem: 's',
        validate: () => ({ ok: true, value: 1, issues: [] }),
      },
      { complete: async () => '{}', onProgress: (n) => notes.push(n) },
    );
    expect(notes[0]).toContain('构思');
    expect(notes.some((n) => n.includes('生成'))).toBe(true);
  });
});
