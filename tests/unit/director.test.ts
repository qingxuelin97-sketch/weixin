import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { prefilter, parseDecision, findMentions, type GroupMember } from '../../src/ai/director';
import { prefilterKnobs } from '../../src/ai/group-config';
import type { MessageVM, PersonaVM } from '../../src/data/types';
import { makePersona } from '../../src/data/persona-defaults';

const NOW = new Date(2025, 7, 6, 12, 0, 0).getTime(); // noon — inside default windows
const min = 60_000;

function persona(over: Partial<PersonaVM> = {}): PersonaVM {
  return makePersona({ contactId: 'x', core: 'c', proactivity: 0.5, ...over });
}

function member(id: string, name: string, p?: Partial<PersonaVM>): GroupMember {
  return { contactId: id, name, persona: persona({ contactId: id, ...p }) };
}

let seq = 1;
function msg(senderId: string, content: string, createdAt = NOW - 10 * min): MessageVM {
  return { id: seq++, convId: 'g', senderId, type: 'text', content, status: 'sent', createdAt };
}

const lin = member('ai_lin', '林小雨');
const chen = member('ai_chen', '陈叔');
const ada = member('ai_ada', 'Ada');

describe('findMentions', () => {
  it('finds @-mentioned members by display name', () => {
    expect(findMentions('@林小雨 你在吗', [lin, chen]).map((m) => m.contactId)).toEqual(['ai_lin']);
  });
  it('returns none when there is no @', () => {
    expect(findMentions('大家好', [lin, chen])).toEqual([]);
  });
  it('can match several at once', () => {
    expect(findMentions('@林小雨 @陈叔 来', [lin, chen, ada])).toHaveLength(2);
  });
});

describe('prefilter', () => {
  it('sends an @-mentioned member straight to direct mode (skips the director)', () => {
    const r = prefilter([lin, chen, ada], [msg('self', '@林小雨 明天去吗')], NOW, 's');
    expect(r.mode).toBe('direct');
    expect(r.reason).toBe('mentioned');
    expect(r.speakers.map((s) => s.agentId)).toEqual(['ai_lin']);
  });

  it('goes silent when everyone is outside their active hours', () => {
    const night = new Date(2025, 7, 6, 4, 0, 0).getTime();
    const r = prefilter([lin, chen], [msg('self', '在吗')], night, 's');
    expect(r.mode).toBe('silence');
    expect(r.candidates).toEqual([]);
  });

  it('drops members who spoke within the cooldown window', () => {
    const recent = [msg('ai_lin', '我刚说过', NOW - 5_000), msg('self', '嗯嗯')];
    const r = prefilter([lin, chen, ada], recent, NOW, 's');
    expect(r.candidates.map((c) => c.contactId)).not.toContain('ai_lin');
  });

  it('forces a member to yield after a consecutive-message streak', () => {
    const recent = [
      msg('ai_chen', 'a', NOW - 9 * min),
      msg('ai_chen', 'b', NOW - 8 * min),
      msg('ai_chen', 'c', NOW - 7 * min),
    ];
    const r = prefilter([chen, lin, ada], recent, NOW, 's');
    expect(r.candidates.map((c) => c.contactId)).not.toContain('ai_chen');
  });

  it('skips members with no persona card instead of crashing', () => {
    const noPersona: GroupMember = { contactId: 'ai_ghost', name: '幽灵' };
    const r = prefilter([noPersona, lin, chen], [msg('self', '大家好')], NOW, 's');
    expect(r.candidates.map((c) => c.contactId)).not.toContain('ai_ghost');
    expect(r.mode).toBe('director'); // lin + chen remain → ambiguous
  });

  it('calls the director only when ≥2 candidates remain', () => {
    const r = prefilter([lin, chen, ada], [msg('self', '周末有空吗')], NOW, 's');
    expect(r.mode).toBe('director');
    expect(r.candidates).toHaveLength(3);
    expect(r.speakers).toEqual([]);
  });

  it('resolves a single candidate locally and deterministically', () => {
    const one = prefilter([lin], [msg('self', '在吗')], NOW, 'seed-A');
    const again = prefilter([lin], [msg('self', '在吗')], NOW, 'seed-A');
    expect(one.mode).toBe(again.mode);
    expect(['direct', 'silence']).toContain(one.mode);
    expect(one.reason.startsWith('single-candidate')).toBe(true);
  });

  it('returns silence for an empty group', () => {
    expect(prefilter([], [msg('self', 'hi')], NOW, 's').mode).toBe('silence');
  });
});

/**
 * The activity knob reaches the prefilter (M-I1, wired in I18).
 *
 * `groupCfg:<convId>.activity` shipped reading into the offline planner and the
 * prompt only — so a room set to 冷清 was exactly as chatty as 热闹 while you
 * were looking at it. The prefilter is where "how alive is this room" actually
 * decides things, and these tests pin the mapping in BOTH directions: a quiet
 * room holds people on cooldown longer and answers less readily, a lively one
 * does the reverse, and level 2 is byte-for-byte the pre-knob behaviour.
 */
describe('the activity knob shapes the prefilter', () => {
  const spokeRecently = [msg('ai_lin', '我刚说过', NOW - 60_000), msg('self', '嗯嗯')];

  it('level 2 reproduces the module defaults exactly', () => {
    const k = prefilterKnobs({ activity: 2 });
    expect(k.cooldownMs).toBe(45_000);
    expect(k.maxStreak).toBe(3);
    // …and passing them changes nothing about the outcome.
    const withKnobs = prefilter([lin, chen, ada], spokeRecently, NOW, 's', k);
    const without = prefilter([lin, chen, ada], spokeRecently, NOW, 's');
    expect(withKnobs.candidates.map((c) => c.contactId)).toEqual(
      without.candidates.map((c) => c.contactId),
    );
    expect(withKnobs.mode).toBe(without.mode);
  });

  it('a quiet room keeps a recent speaker on cooldown that a lively one lets back in', () => {
    // 60s ago: past the default 45s cooldown, inside 冷清's, outside 热闹's.
    const quiet = prefilter([lin, chen, ada], spokeRecently, NOW, 's', prefilterKnobs({ activity: 0 }));
    const lively = prefilter([lin, chen, ada], spokeRecently, NOW, 's', prefilterKnobs({ activity: 3 }));
    expect(quiet.candidates.map((c) => c.contactId)).not.toContain('ai_lin');
    expect(lively.candidates.map((c) => c.contactId)).toContain('ai_lin');
  });

  it('a quiet room forces the floor to change hands sooner', () => {
    const recent = [
      msg('ai_chen', 'a', NOW - 9 * min),
      msg('ai_chen', 'b', NOW - 8 * min),
    ];
    const quiet = prefilter([chen, lin], recent, NOW, 's', prefilterKnobs({ activity: 0 }));
    const lively = prefilter([chen, lin], recent, NOW, 's', prefilterKnobs({ activity: 3 }));
    expect(quiet.candidates.map((c) => c.contactId)).not.toContain('ai_chen');
    expect(lively.candidates.map((c) => c.contactId)).toContain('ai_chen');
  });

  it('the lone-candidate roll follows the knob, and stays seeded', () => {
    // Same seed, same members, same clock — only the knob differs. A 冷清 room
    // declines where a 热闹 one speaks; both are replayable (rule #4).
    const shy = prefilter([lin], [msg('self', '在吗')], NOW, 'seed-0', prefilterKnobs({ activity: 0 }));
    const loud = prefilter([lin], [msg('self', '在吗')], NOW, 'seed-0', prefilterKnobs({ activity: 3 }));
    expect(shy.mode).toBe('silence');
    expect(loud.mode).toBe('direct');
    expect(prefilter([lin], [msg('self', '在吗')], NOW, 'seed-0', prefilterKnobs({ activity: 0 })).mode)
      .toBe(shy.mode);
  });

  it('the knobs are monotonic across the four levels', () => {
    const ks = [0, 1, 2, 3].map((a) => prefilterKnobs({ activity: a as 0 | 1 | 2 | 3 }));
    for (let i = 1; i < ks.length; i++) {
      expect(ks[i].cooldownMs).toBeLessThan(ks[i - 1].cooldownMs);
      expect(ks[i].maxStreak).toBeGreaterThanOrEqual(ks[i - 1].maxStreak);
      expect(ks[i].speakBias).toBeGreaterThan(ks[i - 1].speakBias);
    }
    // Quiet is quiet, not dead: a 冷清 room still answers sometimes.
    expect(ks[0].speakBias).toBeGreaterThan(0);
  });

  it('the group engine actually passes them (写了没接线 = 没做)', () => {
    const src = readFileSync(resolve(__dirname, '../../src/ai/group-engine.ts'), 'utf8');
    // Non-empty options at the call site, derived from the room's own row.
    expect(src).toMatch(/prefilter\([^)]*prefilterKnobs\(cfg\)\)/);
    expect(src).toContain('getGroupCfg(convId)');
  });
});

describe('parseDecision', () => {
  const cands = [lin, chen, ada];

  it('parses a well-formed decision and sorts by priority', () => {
    const d = parseDecision(
      JSON.stringify({
        silence: false,
        topicState: '聊爬山',
        speakers: [
          { agentId: 'ai_ada', priority: 2, intent: 'follow' },
          { agentId: 'ai_lin', priority: 1, intent: 'reply' },
        ],
      }),
      cands,
    );
    expect(d.silence).toBe(false);
    expect(d.speakers.map((s) => s.agentId)).toEqual(['ai_lin', 'ai_ada']);
  });

  it('honors an explicit silence decision', () => {
    const d = parseDecision(JSON.stringify({ silence: true }), cands);
    expect(d.silence).toBe(true);
    expect(d.speakers).toEqual([]);
  });

  it('drops hallucinated members not in the candidate list', () => {
    const d = parseDecision(
      JSON.stringify({ speakers: [{ agentId: 'ai_nobody' }, { agentId: 'ai_lin' }] }),
      cands,
    );
    expect(d.speakers.map((s) => s.agentId)).toEqual(['ai_lin']);
  });

  it('caps the cast at 3 speakers', () => {
    const d = parseDecision(
      JSON.stringify({
        speakers: [
          { agentId: 'ai_lin' },
          { agentId: 'ai_chen' },
          { agentId: 'ai_ada' },
          { agentId: 'ai_lin' },
        ],
      }),
      cands,
    );
    expect(d.speakers.length).toBeLessThanOrEqual(3);
  });

  it('degrades to one speaker on unparseable JSON rather than going silent', () => {
    const d = parseDecision('这不是 JSON{{{', cands);
    expect(d.silence).toBe(false);
    expect(d.speakers).toHaveLength(1);
  });

  it('degrades when the model returns an empty cast', () => {
    const d = parseDecision(JSON.stringify({ speakers: [] }), cands);
    expect(d.speakers).toHaveLength(1);
  });

  it('tolerates code fences around the JSON', () => {
    const d = parseDecision('```json\n{"speakers":[{"agentId":"ai_chen"}]}\n```', cands);
    expect(d.speakers.map((s) => s.agentId)).toEqual(['ai_chen']);
  });

  it('is silent when there are no candidates at all', () => {
    expect(parseDecision('garbage', []).silence).toBe(true);
  });
});
