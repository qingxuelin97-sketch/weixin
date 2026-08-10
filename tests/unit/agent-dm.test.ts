import { describe, it, expect } from 'vitest';
import {
  dmConvId,
  planNextDm,
  parseDmScript,
  dmTimestamps,
  makeDmConversation,
  gossipFacts,
  buildDmPrompt,
  runAgentDm,
  type DmRosterEntry,
  type DmDeps,
  type DmPlan,
} from '../../src/ai/agent-dm';
import { search } from '../../src/lib/search';
import { makePersona } from '../../src/data/persona-defaults';
import type { ContactVM, ConversationVM, MessageVM, MemoryFactVM } from '../../src/data/types';

const NOON = new Date(2025, 7, 6, 12, 0, 0).getTime();
const HOUR = 3_600_000;

const entry = (id: string): DmRosterEntry => ({
  contactId: id,
  persona: makePersona({ contactId: id, core: 'c', activeHours: [[9, 23]] }),
});
const contact = (id: string, name: string): ContactVM => ({
  id,
  type: 'ai',
  name,
  avatarColor: '#000',
  avatarText: name[0],
});

describe('dmConvId', () => {
  it('is order-independent', () => {
    expect(dmConvId('ai_lin', 'ai_ada')).toBe(dmConvId('ai_ada', 'ai_lin'));
  });
});

describe('planNextDm', () => {
  const roster = ['ai_lin', 'ai_ada', 'ai_chen'].map(entry);
  const groups = [{ convId: 'g1', memberIds: ['ai_lin', 'ai_ada'] }];

  it('is deterministic per hour bucket and seed', () => {
    expect(planNextDm(roster, groups, NOON, 's')).toEqual(planNextDm(roster, groups, NOON, 's'));
  });

  it('only pairs agents who share a group', () => {
    const plan = planNextDm(roster, groups, NOON, 's');
    expect([plan!.a, plan!.b].sort()).toEqual(['ai_ada', 'ai_lin']);
    expect(plan!.groupId).toBe('g1');
  });

  it('returns null when nobody shares a group — a DM with no outlet is a wasted call', () => {
    expect(planNextDm(roster, [], NOON, 's')).toBeNull();
    expect(planNextDm(roster, [{ convId: 'g1', memberIds: ['ai_lin'] }], NOON, 's')).toBeNull();
  });

  it('spaces sessions 8–20h out — the spacing IS the daily budget', () => {
    for (let i = 0; i < 20; i++) {
      const plan = planNextDm(roster, groups, NOON + i * HOUR, `s${i}`)!;
      expect(plan.fireAt - (NOON + i * HOUR)).toBeGreaterThanOrEqual(8 * HOUR);
      // 20h roll + up to 48h active-hours walk is the hard ceiling.
      expect(plan.fireAt - (NOON + i * HOUR)).toBeLessThanOrEqual(68 * HOUR);
    }
  });

  it('lands when both participants are awake', () => {
    const owl = {
      contactId: 'owl',
      persona: makePersona({ contactId: 'owl', core: 'c', activeHours: [[20, 23]] }),
    };
    const lark = {
      contactId: 'lark',
      persona: makePersona({ contactId: 'lark', core: 'c', activeHours: [[20, 22]] }),
    };
    const plan = planNextDm([owl, lark], [{ convId: 'g', memberIds: ['owl', 'lark'] }], NOON, 's')!;
    const h = new Date(plan.fireAt).getHours();
    expect(h).toBeGreaterThanOrEqual(20);
    expect(h).toBeLessThan(22);
  });
});

describe('parseDmScript', () => {
  it('parses a clean exchange with gossip', () => {
    const raw = [
      '{"speaker":"A","text":"你最近咋样"}',
      '{"speaker":"B","text":"忙死了"}',
      '{"gossip":{"about":"user","fact":"他最近在准备面试"}}',
    ].join('\n');
    const s = parseDmScript(raw)!;
    expect(s.lines).toHaveLength(2);
    expect(s.lines[0]).toEqual({ who: 'a', text: '你最近咋样' });
    expect(s.gossip).toEqual({ about: 'user', fact: '他最近在准备面试' });
  });

  it('tolerates junk lines and markdown fences', () => {
    const raw = '```json\n{"speaker":"A","text":"嗯"}\n随便一行\n{"speaker":"B","text":"哦"}\n```';
    expect(parseDmScript(raw)!.lines).toHaveLength(2);
  });

  it('voids the session on fewer than 2 usable lines — no half-materialized chats', () => {
    expect(parseDmScript('{"speaker":"A","text":"独白"}')).toBeNull();
    expect(parseDmScript('完全不是 JSON')).toBeNull();
    expect(parseDmScript('')).toBeNull();
  });

  it('caps at 8 lines and 60-char gossip', () => {
    const raw =
      Array.from({ length: 12 }, (_, i) => `{"speaker":"${i % 2 ? 'B' : 'A'}","text":"L${i}"}`).join(
        '\n',
      ) + `\n{"gossip":{"about":"user","fact":"${'长'.repeat(100)}"}}`;
    const s = parseDmScript(raw)!;
    expect(s.lines).toHaveLength(8);
    expect(s.gossip!.fact).toHaveLength(60);
  });

  it('ignores unknown speakers rather than guessing', () => {
    const raw = '{"speaker":"C","text":"我是谁"}\n{"speaker":"A","text":"a"}\n{"speaker":"B","text":"b"}';
    const s = parseDmScript(raw)!;
    expect(s.lines.every((l) => l.who === 'a' || l.who === 'b')).toBe(true);
    expect(s.lines).toHaveLength(2);
  });
});

describe('dmTimestamps', () => {
  it('never stamps behind the conversation tail (rowid order == time order)', () => {
    const ts = dmTimestamps(4, NOON, NOON + HOUR, 's');
    expect(ts[0]).toBeGreaterThan(NOON + HOUR);
    for (let i = 1; i < ts.length; i++) expect(ts[i]).toBeGreaterThan(ts[i - 1]);
  });

  it('paces lines 30–90s apart', () => {
    const ts = dmTimestamps(5, NOON, undefined, 's');
    for (let i = 1; i < ts.length; i++) {
      const gap = ts[i] - ts[i - 1];
      expect(gap).toBeGreaterThanOrEqual(30_000);
      expect(gap).toBeLessThanOrEqual(90_000);
    }
  });
});

describe('gossipFacts', () => {
  const plan = { a: 'ai_lin', b: 'ai_ada' };
  const exists = (id: string) => id === 'ai_lin' || id === 'ai_ada';

  it('writes one fact per participant with speaker/listener framing', () => {
    const facts = gossipFacts(plan, '小雨', 'Ada', { about: 'user', fact: '他在准备面试' }, exists, NOON);
    expect(facts).toHaveLength(2);
    expect(facts.find((f) => f.subjectId === 'ai_lin')!.fact).toBe('和Ada聊到：他在准备面试');
    expect(facts.find((f) => f.subjectId === 'ai_ada')!.fact).toBe('听小雨说：他在准备面试');
  });

  it('drops gossip about anything outside the permitted vocabulary', () => {
    expect(gossipFacts(plan, '小雨', 'Ada', { about: 'ai_ghost', fact: 'x' }, exists, NOON)).toEqual([]);
  });

  it('drops gossip when a participant no longer exists', () => {
    expect(gossipFacts(plan, '小雨', 'Ada', { about: 'user', fact: 'x' }, () => false, NOON)).toEqual([]);
  });
});

describe('DM prompt', () => {
  it('is unconditionally SFW and carries both personas and their relations', () => {
    const a = makePersona({ contactId: 'ai_lin', core: '插画师', relations: { ai_ada: '大学同学' } });
    const b = makePersona({ contactId: 'ai_ada', core: '程序员', nsfwPermit: true });
    const sys = buildDmPrompt('小雨', a, 'Ada', b, '最近的展')[0].content;
    expect(sys).toContain('全年龄向');
    expect(sys).toContain('插画师');
    expect(sys).toContain('程序员');
    expect(sys).toContain('大学同学');
    expect(sys).toContain('最近的展');
    // nsfwPermit on a participant must have no effect here.
    expect(sys).not.toContain('nsfw');
  });
});

describe('runAgentDm (scripted end-to-end, no real API)', () => {
  function makeDeps(completeText: string) {
    const appended: Array<Omit<MessageVM, 'id'>> = [];
    const memories: MemoryFactVM[] = [];
    const convs: ConversationVM[] = [];
    const spills: Array<{ groupId: string; speakerId: string; hint: string }> = [];
    const deps: DmDeps = {
      getPersona: (id) => makePersona({ contactId: id, core: 'c' }),
      getContact: (id) => contact(id, id === 'ai_lin' ? '小雨' : 'Ada'),
      getConversation: async (id) => convs.find((c) => c.id === id),
      addConversation: async (c) => void convs.push(c),
      appendMessage: async (m) => {
        appended.push(m);
        return { ...m, id: appended.length } as MessageVM;
      },
      putMemory: async (f) => void memories.push(f),
      getMemoryFacts: async () => [],
      getGroupMessages: async () => [],
      getMoments: async () => [],
      complete: async () => completeText,
      enqueueGroupSpill: async (groupId, speakerId, hint) =>
        void spills.push({ groupId, speakerId, hint }),
      now: () => NOON + 9 * HOUR,
      getGlobalTier: async () => 'off',
    };
    return { deps, appended, memories, convs, spills };
  }
  const plan: DmPlan = { a: 'ai_lin', b: 'ai_ada', groupId: 'g1', fireAt: NOON + 9 * HOUR };

  it('materializes a hidden conversation with correctly attributed lines', async () => {
    const { deps, appended, memories, convs } = makeDeps(
      '{"speaker":"A","text":"哈喽"}\n{"speaker":"B","text":"来了"}\n{"gossip":{"about":"user","fact":"他换了工作"}}',
    );
    expect(await runAgentDm(plan, deps)).toBe(true);
    expect(convs[0].isHidden).toBe(true);
    expect(appended.map((m) => m.senderId)).toEqual(['ai_lin', 'ai_ada']);
    expect(memories).toHaveLength(2);
    expect(memories.map((m) => m.subjectId).sort()).toEqual(['ai_ada', 'ai_lin']);
  });

  it('voids everything on malformed model output — nothing is written', async () => {
    const { deps, appended, memories, convs } = makeDeps('抱歉，我不能这样输出');
    expect(await runAgentDm(plan, deps)).toBe(false);
    expect(appended).toEqual([]);
    expect(memories).toEqual([]);
    expect(convs).toEqual([]);
  });

  it('survives a throwing provider without writing anything', async () => {
    const { deps, appended } = makeDeps('');
    deps.complete = async () => {
      throw new Error('network');
    };
    expect(await runAgentDm(plan, deps)).toBe(false);
    expect(appended).toEqual([]);
  });
});

describe('SAFETY: hidden DM conversations never reach search', () => {
  it('excludes both the conversation and its messages, even when the caller forgets to pre-filter', () => {
    const dm: ConversationVM = makeDmConversation(
      contact('ai_lin', '小雨'),
      contact('ai_ada', 'Ada'),
      NOON,
    );
    const hits = search(
      {
        contacts: [],
        conversations: [dm],
        // The caller passes the raw store map, hidden conv included.
        messages: {
          [dm.id]: [
            {
              id: 1,
              convId: dm.id,
              senderId: 'ai_lin',
              type: 'text',
              content: '这句私聊绝不能被搜到',
              status: 'sent',
              createdAt: NOON,
            },
          ],
        },
        moments: [],
      },
      '私聊',
    );
    expect(hits).toEqual([]);
    // And the title must not match either.
    expect(search({ contacts: [], conversations: [dm], messages: {}, moments: [] }, '小雨')).toEqual(
      [],
    );
  });
});
