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
import { totalUnread } from '../../src/lib/unread';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { makePersona } from '../../src/data/persona-defaults';
import { moodOf } from '../../src/lib/mood';
import { lifelineAt, lifelineDirective, personaEpoch } from '../../src/ai/lifeline';
import type {
  ContactVM,
  ConversationVM,
  MessageVM,
  MemoryFactVM,
  MomentVM,
} from '../../src/data/types';

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

  it('gives a trio its own stable id — never the pair inside it', () => {
    const trio = dmConvId('ai_chen', 'ai_lin', 'ai_ada');
    expect(trio).toBe(dmConvId('ai_ada', 'ai_chen', 'ai_lin'));
    expect(trio).not.toBe(dmConvId('ai_lin', 'ai_ada'));
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

  it('admits C only when the session actually has three participants', () => {
    const raw = '{"speaker":"A","text":"a"}\n{"speaker":"B","text":"b"}\n{"speaker":"C","text":"c"}';
    expect(parseDmScript(raw, 3)!.lines.map((l) => l.who)).toEqual(['a', 'b', 'c']);
    // A trio gets a slightly longer ceiling, still bounded.
    const many = Array.from(
      { length: 20 },
      (_, i) => `{"speaker":"${'ABC'[i % 3]}","text":"L${i}"}`,
    ).join('\n');
    expect(parseDmScript(many, 3)!.lines).toHaveLength(10);
    expect(parseDmScript(many)!.lines).toHaveLength(8);
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
  const cast = [
    { id: 'ai_lin', name: '小雨' },
    { id: 'ai_ada', name: 'Ada' },
  ];
  const exists = (id: string) => id === 'ai_lin' || id === 'ai_ada';

  it('writes one fact per participant with speaker/listener framing', () => {
    const facts = gossipFacts(cast, { about: 'user', fact: '他在准备面试' }, exists, NOON);
    expect(facts).toHaveLength(2);
    expect(facts.find((f) => f.subjectId === 'ai_lin')!.fact).toBe('和Ada聊到：他在准备面试');
    expect(facts.find((f) => f.subjectId === 'ai_ada')!.fact).toBe('听小雨说：他在准备面试');
  });

  it('drops gossip about anything outside the permitted vocabulary', () => {
    expect(gossipFacts(cast, { about: 'ai_ghost', fact: 'x' }, exists, NOON)).toEqual([]);
    // "C" is a hallucinated third party in a two-person exchange.
    expect(gossipFacts(cast, { about: 'C', fact: 'x' }, exists, NOON)).toEqual([]);
  });

  it('drops gossip when a participant no longer exists', () => {
    expect(gossipFacts(cast, { about: 'user', fact: 'x' }, () => false, NOON)).toEqual([]);
  });
});

describe('DM prompt', () => {
  it('is unconditionally SFW and carries both personas and their relations', () => {
    const a = makePersona({ contactId: 'ai_lin', core: '插画师', relations: { ai_ada: '大学同学' } });
    const b = makePersona({ contactId: 'ai_ada', core: '程序员', nsfwPermit: true });
    const sys = buildDmPrompt(
      [
        { name: '小雨', persona: a },
        { name: 'Ada', persona: b },
      ],
      '最近的展',
      NOON,
    )[0].content;
    expect(sys).toContain('全年龄向');
    expect(sys).toContain('插画师');
    expect(sys).toContain('程序员');
    expect(sys).toContain('大学同学');
    expect(sys).toContain('最近的展');
    // nsfwPermit on a participant must have no effect here.
    expect(sys).not.toContain('nsfw');
  });

  it('换脑 (M-J1)：主讲人走完整装配线，带基底/心情/生活线/目标层', () => {
    const a = makePersona({ contactId: 'ai_lin', core: '插画师', relations: { user: '老朋友' } });
    const b = makePersona({ contactId: 'ai_ada', core: '程序员' });
    const sys = buildDmPrompt(
      [
        { name: '小雨', persona: a },
        { name: 'Ada', persona: b },
      ],
      '最近的展',
      NOON,
    )[0].content;
    // The same base-realism header the chat engines use — the DM is no longer
    // a three-line side-brain.
    expect(sys).toContain('扮演一个真实的人');
    expect(sys).toContain('# 你的人设');
    // Mood rides the scene layer; the lifeline directive is always non-empty.
    expect(sys).toContain(moodOf('ai_lin', NOON).line);
    expect(sys).toContain(lifelineDirective(lifelineAt({ contactId: 'ai_lin' }, NOON, personaEpoch('ai_lin'))));
    // The user relation enters the relations layer.
    expect(sys).toContain('老朋友');
    // And the writing-room framing survives.
    expect(sys).toContain('编剧视角');
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

/**
 * 可见范围 × 八卦 (M-I18).
 *
 * `deps.getMoments` reads with the default viewer ('self') because a DM has no
 * single viewer, so the audience check lives inside runDmSession and must hold
 * for EVERY participant. This matters beyond the DM itself: hidden DMs are
 * where hearsay is minted, and hearsay spills into group chat — so a post one
 * speaker cannot see, quoted here, comes back to the user as 「她怎么知道这条」.
 *
 * Seeded across many fireAt values because the topic is a seeded pick among
 * candidates: with the filter removed the restricted post wins some of those
 * draws, and one draw is all it takes to leak.
 */
describe('SAFETY: a DM never quotes a post a participant cannot see', () => {
  const SECRET = '只给小雨看的那条';
  const OPEN = '大家都能看的那条';
  type Moments = Awaited<ReturnType<DmDeps['getMoments']>>;

  const moment = (
    id: string,
    authorId: string,
    text: string,
    visibility?: MomentVM['visibility'],
  ): Moments[number] => ({ id, authorId, text, createdAt: NOON, visibility }) as Moments[number];

  async function collectPrompts(moments: Moments): Promise<string> {
    let seen = '';
    for (let i = 0; i < 24; i++) {
      const deps: DmDeps = {
        getPersona: (id) => makePersona({ contactId: id, core: 'c' }),
        getContact: (id) => contact(id, id === 'ai_lin' ? '小雨' : 'Ada'),
        getConversation: async () => undefined,
        addConversation: async () => {},
        appendMessage: async (m) => ({ ...m, id: 1 }) as MessageVM,
        putMemory: async () => {},
        getMemoryFacts: async () => [],
        getGroupMessages: async () => [],
        getMoments: async () => moments,
        complete: async (messages) => {
          seen += JSON.stringify(messages);
          return '{"speaker":"A","text":"嗯"}\n{"speaker":"B","text":"嗯"}';
        },
        enqueueGroupSpill: async () => {},
        now: () => NOON + 9 * HOUR,
        getGlobalTier: async () => 'off',
      };
      await runAgentDm(
        { a: 'ai_lin', b: 'ai_ada', groupId: 'g1', fireAt: NOON + 9 * HOUR + i * 60_000 },
        deps,
      );
    }
    return seen;
  }

  it('drops a post excluding the other speaker, and keeps a public one', async () => {
    // Ada authored both; the first one shuts 小雨 out. Both are hers, so the
    // author-side check ("ids includes authorId") passes for both — only the
    // audience check can tell them apart.
    const prompts = await collectPrompts([
      moment('m1', 'ai_ada', SECRET, { mode: 'exclude', ids: ['ai_lin'] }),
      moment('m2', 'ai_ada', OPEN, undefined),
    ]);
    // The real assertion.
    expect(prompts).not.toContain(SECRET);
    // …and the control: without this, the test would also pass if moments
    // never reached the prompt at all, which would make it worthless.
    expect(prompts).toContain(OPEN);
  });

  it('drops a 私密 post outright — even its own author does not gossip it', async () => {
    const prompts = await collectPrompts([
      moment('m1', 'ai_ada', SECRET, { mode: 'private', ids: [] }),
      moment('m2', 'ai_ada', OPEN, undefined),
    ]);
    expect(prompts).not.toContain(SECRET);
    expect(prompts).toContain(OPEN);
  });
});

describe('SAFETY: hidden DM conversations never reach search', () => {
  it('excludes both the conversation and its messages, even when the caller forgets to pre-filter', () => {
    const dm: ConversationVM = makeDmConversation(
      [contact('ai_lin', '小雨'), contact('ai_ada', 'Ada')],
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

/**
 * SAFETY, the other user-visible surface: the UNREAD BADGE.
 *
 * Search had a test; the red number on 微信 did not. It is the worse leak of
 * the two — search needs a query that happens to hit the DM, while the badge is
 * on screen permanently. "微信 3" over two readable unread threads tells the
 * user there is a conversation they cannot open, and there is no explaining
 * that away afterwards.
 *
 * `runAgentDm` writes into the hidden thread through the ordinary
 * `appendMessage` path, and `bumpUnread` does not know the thread is hidden —
 * so a hidden conversation carrying unread is the NORMAL state, not a corrupt
 * one. Drop the `isHidden` half of lib/unread.ts and this goes red.
 */
describe('SAFETY: a hidden DM never reaches the unread badge', () => {
  const visible = (over: Partial<ConversationVM> = {}): ConversationVM => ({
    id: 'conv_a',
    type: 'single',
    title: '林小雨',
    avatarColor: '#000',
    avatarText: '林',
    isPinned: false,
    isMuted: false,
    unreadCount: 3,
    mentionMe: false,
    lastMsgPreview: '',
    lastMsgAt: NOON,
    ...over,
  });

  it('unread on a hidden thread adds nothing to the total', () => {
    const dm: ConversationVM = {
      ...makeDmConversation([contact('ai_lin', '小雨'), contact('ai_ada', 'Ada')], NOON),
      // Deliberately NOT muted: muting would suppress the count for the other
      // reason and make this assertion pass without the isHidden rule.
      isMuted: false,
      unreadCount: 99,
    };
    expect(dm.isHidden).toBe(true);
    expect(totalUnread([visible(), dm])).toBe(3);
    expect(totalUnread([dm])).toBe(0);
  });

  it('muted threads are still excluded, and ordinary ones still counted', () => {
    expect(totalUnread([visible(), visible({ id: 'c2', isMuted: true, unreadCount: 7 })])).toBe(3);
    expect(totalUnread([visible(), visible({ id: 'c2', unreadCount: 7 })])).toBe(10);
    expect(totalUnread([])).toBe(0);
  });

  it('every surface that shows a total reads the one rule', () => {
    // Three components computed this inline, and one of them spelled only half
    // the rule out. A fourth surface copying the wrong half is the failure this
    // guard exists to catch — see CLAUDE.md's 「写了没接线」 sibling trap.
    for (const f of [
      'src/app/TabScaffold.tsx',
      'src/features/chat/ChatPage.tsx',
      'src/features/chat-list/ChatListPage.tsx',
    ]) {
      const src = readFileSync(resolve(__dirname, '../..', f), 'utf8');
      expect(src.includes("from '../lib/unread'") || src.includes("from '../../lib/unread'")).toBe(
        true,
      );
      expect(
        /reduce\(\([^)]*\)\s*=>\s*[^)]*unreadCount/.test(src),
        `${f} 又在本地重算未读总数了——规则只有 lib/unread.ts 一份`,
      ).toBe(false);
    }
  });
});
