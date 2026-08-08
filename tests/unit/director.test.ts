import { describe, it, expect } from 'vitest';
import { prefilter, parseDecision, findMentions, type GroupMember } from '../../src/ai/director';
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
