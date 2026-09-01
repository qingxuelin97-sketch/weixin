/**
 * M-J1 心智一致性 — one character, one brain.
 *
 * Every block here guards a wire that, if quietly cut, degrades a character
 * into surface-dependent fragments again: the group actor losing six layers,
 * the DM side-brain leaking graded facts, the call forgetting its own纪要,
 * the offline世界 producing chatter nobody remembers, drift acting without
 * speaking, and — the one that costs actual money — the LLM spend running
 * unbounded. Where behaviour is reachable it is tested as behaviour; where
 * the failure mode is "someone deletes the call site", the source is scanned
 * (the wiring.test.ts precedent: unreached code passes its own tests).
 */
import { NO_FRIEND_PERMS } from '../../src/lib/friend-perms';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import 'fake-indexeddb/auto';
import { repo } from '../../src/db/repo';
import {
  assembleSystemPrompt,
  PROMPT_LIMITS,
  TRIM_FLOORS,
  type AssembleInput,
} from '../../src/ai/prompt';
import {
  selectForInjection,
  profileLines,
  PROFILE_MIN_FACTS,
} from '../../src/ai/entity-graph';
import { selectFactsForInjection } from '../../src/ai/memory';
import {
  checkBudget,
  overBudget,
  budgetRetryAt,
  budgetStatus,
  schedulerBudgetGate,
  installCostGate,
  uninstallCostGate,
  ACTION_LLM_BOUND,
  DEFAULT_LLM_BUDGET,
  isBudgetError,
} from '../../src/ai/cost-gate';
import { SCHEDULED_ACTION_KINDS } from '../../src/db/schema';
import {
  enqueue,
  runDueActions,
  registerHandler,
  setBudgetGate,
  pendingActions,
  actionStatus,
} from '../../src/ai/scheduler';
import { LlmRouter, setLlmPreflight, type RoutingPolicy } from '../../src/llm/router';
import { LlmError, type Bubble, type CompletionResult, type GenerateOptions } from '../../src/llm/types';
import {
  runAgentDm,
  planNextDm,
  pickHop2Gossip,
  hop2Facts,
  HOP2_MIN_CONFIDENCE,
  HOP2_DECAY,
  type DmDeps,
  type DmPlan,
  type DmRosterEntry,
} from '../../src/ai/agent-dm';
import { getStance, hostileTone, detectStanceMention } from '../../src/ai/relationship';
import { driftToneLine, TONE_FLOOR, applyEvent, type Drift } from '../../src/ai/drift';
import {
  GOAL_TEMPLATES,
  agentEpoch,
  goalStateAt,
  sanitizeGoalTemplates,
  applyGoalOverrides,
  goalDirective,
  type GoalTemplate,
} from '../../src/ai/goals';
import {
  goalTemplatesFor,
  goalStateFor,
  ensureGoalTemplates,
  renameCurrentGoal,
  abandonCurrentGoal,
  latestTerminalEventFor,
} from '../../src/ai/goal-service';
import { simulate, LIMITS, LLM_COST, type SimInput } from '../../src/ai/simulate';
import { MEM_EXTRACT_MIN_NEW } from '../../src/ai/memory-service';
import {
  CallSession,
  buildCallSystem,
  recordCallOutcome,
} from '../../src/ai/call-script';
import { getConvState } from '../../src/ai/conv-state';
import { moodOf } from '../../src/lib/mood';
import { makePersona } from '../../src/data/persona-defaults';
import type { MemoryFactVM, MessageVM, ContactVM, ConversationVM, PersonaVM } from '../../src/data/types';

const root = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

const NOON = new Date(2025, 7, 6, 12, 0, 0).getTime();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const fact = (over: Partial<MemoryFactVM> & { id: string; fact: string }): MemoryFactVM => ({
  subjectId: 'ai_x',
  importance: 3,
  sensitivity: 'normal',
  evidenceMsgIds: [1],
  status: 'confirmed',
  isPinned: false,
  createdAt: NOON,
  ...over,
});

/* ==================================================================== */
/* 10 — 分层预算器                                                       */
/* ==================================================================== */

describe('prompt 分层预算器 (J1-10)', () => {
  const CORE_MARK = '这个人设核心句绝不能被裁掉';
  const long = (tag: string, n: number, chars = 38) =>
    Array.from({ length: n }, (_, i) => `${tag}${i}`.padEnd(chars, '实'));

  function hugeInput(): AssembleInput {
    return {
      persona: {
        name: '测试者',
        core: CORE_MARK,
        speechStyle: '短句'.repeat(20),
        fewShots: long('шот', PROMPT_LIMITS.fewShots, 60),
        catchphrases: ['哎呀'],
      },
      relations: Object.fromEntries([
        ['user', '老朋友'],
        ...Array.from({ length: 10 }, (_, i) => [`朋友${i}`, '认识很久了'.repeat(6)]),
      ]),
      nsfwTier: 'off' as const,
      // Memory lines arrive unclipped by design (facts are capped upstream, a
      // conv summary is 80 chars, worldbook lines longer) — long lines here are
      // what actually pushes an assembled prompt past the ceiling.
      memory: {
        pinned: long('钉', 10, 80),
        topK: long('记', 20, 120),
        world: long('典', 12, 120),
      },
      scene: { kind: 'single' as const, now: new Date(NOON) },
    };
  }

  it('超预算时裁到预算内，基底与人设层永不被裁', () => {
    const input = hugeInput();
    const out = assembleSystemPrompt(input);
    expect(out.length).toBeLessThanOrEqual(PROMPT_LIMITS.totalWarn);
    // Non-vacuous: something really was cut to get there.
    expect(input.memory!.topK.some((l) => !out.includes(l))).toBe(true);
    // Base realism and the persona voice survive whatever the pressure.
    expect(out).toContain('扮演一个真实的人');
    expect(out).toContain(CORE_MARK);
    expect(out).toContain('说话风格');
  });

  it('裁剪有下限：记忆保底、few-shots 保三条、钉住的事实一条不丢', () => {
    const input = hugeInput();
    const out = assembleSystemPrompt(input);
    // Every pinned fact survives — they are the user's explicit word.
    for (const p of input.memory!.pinned) expect(out).toContain(`- ${p}`);
    // At least the floor of scored memory lines survives.
    const keptTopK = input.memory!.topK.filter((l) => out.includes(l)).length;
    expect(keptTopK).toBeGreaterThanOrEqual(TRIM_FLOORS.memoryTopK);
    // Few-shots floor: the first three are style backbone.
    const keptShots = input.persona.fewShots!.filter((s) => out.includes(s.slice(0, 20))).length;
    expect(keptShots).toBeGreaterThanOrEqual(TRIM_FLOORS.fewShots);
    // The user relation is pinned first and never dropped.
    expect(out).toContain('用户：老朋友');
  });

  it('裁剪顺序：记忆尾部先走，few-shots 尚在时记忆已经被裁', () => {
    const input = hugeInput();
    const out = assembleSystemPrompt(input);
    const droppedMemory = input.memory!.topK.some((l) => !out.includes(l));
    expect(droppedMemory).toBe(true);
    // few-shots only start losing entries AFTER memory+world hit their floors;
    // this input is not extreme enough to reach them past their own floor.
    const keptShots = input.persona.fewShots!.filter((s) => out.includes(s.slice(0, 20))).length;
    expect(keptShots).toBeGreaterThanOrEqual(TRIM_FLOORS.fewShots);
  });

  it('预算内的 prompt 一个字节都不动（前缀缓存）', () => {
    const small: AssembleInput = {
      persona: { name: '甲', core: '普通人' },
      nsfwTier: 'off',
      memory: { pinned: [], topK: ['他爱喝美式'], world: [] },
      scene: { kind: 'single', now: new Date(NOON) },
    };
    expect(assembleSystemPrompt(small)).toBe(assembleSystemPrompt(small));
    expect(assembleSystemPrompt(small)).toContain('他爱喝美式');
  });
});

/* ==================================================================== */
/* 9 — 实体档案聚合                                                      */
/* ==================================================================== */

describe('实体档案聚合 (J1-9)', () => {
  const sister = (i: number) =>
    fact({ id: `s${i}`, fact: `妹妹${['在成都上大学', '属兔', '下个月生日', '爱吃辣'][i]}`, aboutId: '妹妹' });

  it('同实体 ≥3 条压成一行档案（名字：要点；要点）', () => {
    const facts = [sister(0), sister(1), sister(2), fact({ id: 'o1', fact: '他上周加班到很晚' })];
    const sel = selectForInjection(facts, NOON + HOUR);
    const profile = sel.topK.find((l) => l.startsWith('妹妹：'));
    expect(profile).toBeTruthy();
    expect(profile).toContain('；');
    expect(profile).toContain('在成都上大学');
    // The flat copies are gone — one dossier, not three scattered lines.
    expect(sel.topK.filter((l) => l.includes('妹妹'))).toHaveLength(1);
    // The unrelated fact stays a plain line.
    expect(sel.topK).toContain('他上周加班到很晚');
    // Every folded fact is still credited for touchFacts.
    for (const id of ['s0', 's1', 's2', 'o1']) expect(sel.ids).toContain(id);
  });

  it('不足 3 条保持平铺；档案行数少于原行数（字符预算只降不升）', () => {
    const two = [sister(0), sister(1)];
    const sel = selectForInjection(two, NOON + HOUR);
    expect(sel.topK.some((l) => l.startsWith('妹妹：'))).toBe(false);
    const four = [sister(0), sister(1), sister(2), sister(3)];
    const folded = profileLines(four);
    expect(folded.lines).toHaveLength(1);
    expect(folded.lines[0].length).toBeLessThan(four.map((f) => f.fact).join('').length + 4);
    expect(PROFILE_MIN_FACTS).toBe(3);
  });

  it('groupByEntity 终于有第二个消费者（prompt 侧）', () => {
    expect(read('src/ai/entity-graph.ts')).toMatch(/profileLines[\s\S]{0,400}groupByEntity\(/);
  });
});

/* ==================================================================== */
/* 11 — 全局成本闸                                                       */
/* ==================================================================== */

describe('全局成本闸 (J1-11)', () => {
  beforeEach(async () => {
    await repo.putSetting('llmSpend', null);
    await repo.putSetting('llmBudget', null);
  });
  afterEach(async () => {
    setLlmPreflight(null);
    setBudgetGate(null);
    await repo.putSetting('llmSpend', null);
    await repo.putSetting('llmBudget', null);
  });

  it('打满预算后第 N+1 次被拒（特定 LlmError，不入账）', async () => {
    await repo.putSetting('llmBudget', { hour: 3, day: 100 });
    for (let i = 0; i < 3; i++) await checkBudget(NOON + i);
    await expect(checkBudget(NOON + 10)).rejects.toMatchObject({ kind: 'budget' });
    // The rejection did not advance the counter — still exactly 3 spent.
    expect((await budgetStatus(NOON + 20)).hourUsed).toBe(3);
    // …and the hour rolling over clears the hourly gate.
    await expect(checkBudget(NOON + HOUR)).resolves.toBeUndefined();
  });

  it('router 在派发前询问闸门：mock 记录器打满预算，第 N+1 次拒发', async () => {
    await repo.putSetting('llmBudget', { hour: 2, day: 100 });
    let dispatched = 0;
    const policy: RoutingPolicy = {
      plan: () => ({
        provider: {
          id: 'stub',
          kind: 'custom',
          complete: async (_o: GenerateOptions): Promise<CompletionResult> => {
            dispatched++;
            return { text: '嗯', finishReason: 'stop', raw: null };
          },
          generate: async function* (): AsyncIterable<Bubble> {},
          listModels: async () => [],
        } as never,
        model: 'm',
        fallbacks: [],
      }),
    };
    const router = new LlmRouter(policy);
    installCostGate();
    const req = { role: 'chat', nsfwTier: 'off' } as const;
    const opts = { messages: [{ role: 'user' as const, content: 'hi' }] };
    await router.complete(req, opts, {}, 'c1');
    await router.complete(req, opts, {}, 'c1');
    await expect(router.complete(req, opts, {}, 'c1')).rejects.toMatchObject({ kind: 'budget' });
    expect(dispatched).toBe(2); // the rejected call never left the process
    uninstallCostGate();
  });

  it('generate 不把预算错误吞成人设拒答——引擎要拿到真 kind', async () => {
    const policy: RoutingPolicy = {
      plan: () => ({
        provider: {
          id: 'stub',
          kind: 'custom',
          complete: async () => ({ text: '嗯', finishReason: 'stop', raw: null }),
          generate: async function* (): AsyncIterable<Bubble> {},
          listModels: async () => [],
        } as never,
        model: 'm',
        fallbacks: [],
      }),
    };
    const router = new LlmRouter(policy);
    setLlmPreflight(async () => {
      throw new LlmError('budget', '预算没了');
    });
    const iterate = async () => {
      const out: Bubble[] = [];
      for await (const b of router.generate(
        { role: 'chat', nsfwTier: 'off' },
        { messages: [] },
        { personaRefusal: () => [{ type: 'text', content: '信号不太好' }] },
        'c2',
      )) {
        out.push(b);
      }
      return out;
    };
    await expect(iterate()).rejects.toSatisfy((e: unknown) => isBudgetError(e));
  });

  it('调度器：超预算的 LLM 动作保留 pending 顺延，免费动作照常跑', async () => {
    await repo.putSetting('llmBudget', { hour: 1, day: 100 });
    await checkBudget(NOON); // spend the whole hour
    expect(await overBudget(NOON)).toBe(true);

    const ran: string[] = [];
    registerHandler('heartbeat', async () => void ran.push('heartbeat'));
    registerHandler('recall', async () => void ran.push('recall'));
    await enqueue({ kind: 'heartbeat', fireAt: NOON - 1000, payload: {}, now: NOON, id: 'j1_hb' });
    await enqueue({ kind: 'recall', fireAt: NOON - 1000, payload: {}, now: NOON, id: 'j1_rc' });

    setBudgetGate(schedulerBudgetGate);
    await runDueActions(NOON);
    expect(ran).toEqual(['recall']); // the free kind ran, the paid one did not
    expect(await actionStatus('j1_hb')).toBe('pending'); // deferred, not dropped
    const row = (await pendingActions()).find((a) => a.id === 'j1_hb');
    expect(row!.fireAt).toBe(await budgetRetryAt(NOON));
    expect(row!.fireAt).toBeGreaterThan(NOON);

    // Budget clears → the same row fires on the next due pass.
    await repo.putSetting('llmSpend', null);
    await runDueActions(row!.fireAt + 1);
    expect(ran).toEqual(['recall', 'heartbeat']);
  });

  it('每个队列 kind 都表了态（编译器逼的，这里再钉一遍清单）', () => {
    expect(Object.keys(ACTION_LLM_BOUND).sort()).toEqual([...SCHEDULED_ACTION_KINDS].sort());
    expect(DEFAULT_LLM_BUDGET).toEqual({ hour: 60, day: 600 });
  });

  it('引擎与运行时真的接了线（写了没接线 = 没做）', () => {
    const runtime = read('src/app/useSchedulerRuntime.ts');
    expect(runtime).toContain('installCostGate()');
    expect(runtime).toContain('setBudgetGate(schedulerBudgetGate)');
    const engine = read('src/ai/engine.ts');
    expect(engine).toContain('isBudgetError(');
    expect(engine).toContain('personaTiredBubbles(');
    expect(read('src/features/settings/UsagePage.tsx')).toContain('budgetStatus(');
  });
});

/* ==================================================================== */
/* 2 — AI↔AI 私信换脑 + 敏感度泄漏通道                                   */
/* ==================================================================== */

function dmHarness(over: Partial<DmDeps> = {}) {
  const appended: Array<Omit<MessageVM, 'id'>> = [];
  const memories: MemoryFactVM[] = [];
  const prompts: string[] = [];
  const convs: ConversationVM[] = [];
  const contact = (id: string): ContactVM => ({
    id,
    type: 'ai',
    name: id === 'ai_lin' ? '小雨' : id === 'ai_ada' ? 'Ada' : id,
    avatarColor: '#000',
    avatarText: 'x',
  });
  const deps: DmDeps = {
    getPersona: (id) => makePersona({ contactId: id, core: '普通人' }),
    getContact: contact,
    getConversation: async (id) => convs.find((c) => c.id === id),
    addConversation: async (c) => void convs.push(c),
    appendMessage: async (m) => {
      appended.push(m);
      return { ...m, id: appended.length } as MessageVM;
    },
    putMemory: async (f) => void memories.push(f),
    getMemoryFacts: async () => [],
    getGroupMessages: async () => [],
    getFriendPerms: async () => NO_FRIEND_PERMS,
    getMoments: async () => [],
    complete: async (messages) => {
      prompts.push(messages.map((m) => m.content).join('\n'));
      return '{"speaker":"A","text":"嗨"}\n{"speaker":"B","text":"嗯"}';
    },
    enqueueGroupSpill: async () => {},
    now: () => NOON,
    getGlobalTier: async () => 'full',
    ...over,
  };
  return { deps, appended, memories, prompts };
}

describe('AI↔AI 私信换脑 (J1-2)', () => {
  it('full 档敏感度与 archived 的事实【必须】进不了 DM prompt（转红守卫）', async () => {
    const SECRET = '一段全开档才有的私密事实绝不能进私聊话题';
    const DEAD = '一条已经归档的旧事实也不能再被拿出来聊';
    const facts: MemoryFactVM[] = [
      fact({ id: 'n1', fact: SECRET, sensitivity: 'nsfw', importance: 5, isPinned: true }),
      fact({ id: 'a1', fact: DEAD, status: 'archived', importance: 5 }),
    ];
    const { deps, prompts } = dmHarness({ getMemoryFacts: async () => facts });
    const plan: DmPlan = { a: 'ai_lin', b: 'ai_ada', groupId: 'g1', fireAt: NOON };
    expect(await runAgentDm(plan, deps)).toBe(true);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toContain(SECRET);
    expect(prompts[0]).not.toContain(DEAD);
  });

  it('白名单本身：dm surface 对 sensitive/nsfw 一律说不，正常事实可入', () => {
    const rows = [
      fact({ id: 'x1', fact: '他爱喝美式' }),
      fact({ id: 'x2', fact: '私密的', sensitivity: 'nsfw', importance: 5 }),
      fact({ id: 'x3', fact: '暧昧的', sensitivity: 'sensitive', importance: 5 }),
    ];
    const sel = selectFactsForInjection(rows, NOON, { surface: 'dm', tier: 'full' });
    expect([...sel.pinned, ...sel.topK]).toEqual(['他爱喝美式']);
  });

  it("mayInjectFact('dm') 终于有调用方——agent-dm 的记忆读取走白名单", () => {
    const src = read('src/ai/agent-dm.ts');
    expect(src).toContain("surface: 'dm'");
    expect(src).toContain('selectFactsForInjection(');
    // The raw slice(0, 2) read this replaced must not come back.
    expect(src).not.toMatch(/facts\.slice\(0,\s*2\)\.map\(\(f\)\s*=>\s*f\.fact\)/);
  });

  it('DM 的 system 带完整装配线（基底 + 场合框架）', async () => {
    const { deps, prompts } = dmHarness();
    await runAgentDm({ a: 'ai_lin', b: 'ai_ada', groupId: 'g1', fireAt: NOON }, deps);
    expect(prompts[0]).toContain('扮演一个真实的人'); // BASE_REALISM rides in
    expect(prompts[0]).toContain('# 现在的场合');
    expect(prompts[0]).toContain('编剧视角');
  });
});

/* ==================================================================== */
/* 7 — 八卦 hop-2 + 无群兜底                                             */
/* ==================================================================== */

describe('八卦 hop-2 与无群兜底 (J1-7)', () => {
  const roster: DmRosterEntry[] = ['ai_lin', 'ai_ada'].map((id) => ({
    contactId: id,
    persona: makePersona({ contactId: id, core: 'c', activeHours: [[0, 24]] }),
  }));

  it('无共同群时从 rel_edges 好友对里兜底；连边也没有才 null', () => {
    expect(planNextDm(roster, [], NOON, 's')).toBeNull();
    const plan = planNextDm(roster, [], NOON, 's', [{ a: 'ai_lin', b: 'ai_ada' }]);
    expect(plan).not.toBeNull();
    expect(new Set([plan!.a, plan!.b])).toEqual(new Set(['ai_lin', 'ai_ada']));
    expect(plan!.groupId).toBeUndefined();
    expect(plan!.c).toBeUndefined(); // no shared room → never a trio
  });

  it('有共同群时兜底通道不参与（群配对优先）', () => {
    const plan = planNextDm(
      roster,
      [{ convId: 'g1', memberIds: ['ai_lin', 'ai_ada'] }],
      NOON,
      's',
      [{ a: 'ai_lin', b: 'ai_zzz' }],
    );
    expect(plan!.groupId).toBe('g1');
  });

  it('听说的事只再传一跳：hop2 产物的置信度低于再传门槛', () => {
    const heard = fact({
      id: 'h1',
      fact: '听陈叔说：user 想换工作了',
      source: 'hearsay',
      confidence: 0.4,
    });
    // Somewhere within a handful of seeds the seeded gate opens.
    let picked: ReturnType<typeof pickHop2Gossip> = null;
    for (let i = 0; i < 40 && !picked; i++) picked = pickHop2Gossip([heard], `seed${i}`);
    expect(picked).not.toBeNull();
    expect(picked!.core).toBe('user 想换工作了');
    expect(picked!.sourceName).toBe('陈叔');

    const second = hop2Facts(
      { id: 'ai_lin', name: '小雨' },
      [{ id: 'ai_ada', name: 'Ada' }],
      picked!,
      NOON,
    );
    expect(second).toHaveLength(1);
    expect(second[0].fact).toBe('听小雨说：user 想换工作了');
    expect(second[0].confidence).toBeCloseTo(0.4 * HOP2_DECAY, 5);
    expect(second[0].confidence!).toBeLessThan(HOP2_MIN_CONFIDENCE);
    // …and therefore a third hop can never be picked, whatever the seed.
    for (let i = 0; i < 60; i++) expect(pickHop2Gossip(second, `s${i}`)).toBeNull();
  });

  it('非道听途说 / 已归档的记忆不参与再传', () => {
    const rows = [
      fact({ id: 'c1', fact: '听某人说：一件事', source: 'chat', confidence: 0.9 }),
      fact({ id: 'c2', fact: '听某人说：另一件事', source: 'hearsay', confidence: 0.4, status: 'archived' }),
    ];
    for (let i = 0; i < 60; i++) expect(pickHop2Gossip(rows, `s${i}`)).toBeNull();
  });

  it('runAgentDm 真的接了 hop-2：转述成话题，听者拿到降置信度的二手记忆', async () => {
    const heard = fact({
      id: 'h_live',
      subjectId: 'ai_lin',
      fact: '听陈叔说：user 想搬去大理',
      source: 'hearsay',
      confidence: 0.4,
    });
    // The in-session gate is seeded on (dmId, fireAt); scan fireAt until the
    // dice open — deterministic once found, and finding none within 40 tries
    // means the wiring is gone (the red this guard exists for).
    let hit: { prompt: string; memories: MemoryFactVM[] } | null = null;
    for (let i = 0; i < 40 && !hit; i++) {
      const { deps, prompts, memories } = dmHarness({
        getMemoryFacts: async (id) => (id === 'ai_lin' ? [heard] : []),
      });
      await runAgentDm({ a: 'ai_lin', b: 'ai_ada', groupId: 'g1', fireAt: NOON + i * HOUR }, deps);
      if (prompts[0]?.includes('user 想搬去大理')) hit = { prompt: prompts[0], memories };
    }
    expect(hit).not.toBeNull();
    expect(hit!.prompt).toContain('陈叔'); // the retelling names its source
    const second = hit!.memories.find((m) => m.subjectId === 'ai_ada' && m.fact.includes('想搬去大理'));
    expect(second).toBeTruthy();
    expect(second!.fact.startsWith('听小雨说：')).toBe(true);
    expect(second!.confidence!).toBeLessThan(HOP2_MIN_CONFIDENCE); // 仅一跳
  });

  it('无群会话绝不外溢（enqueueGroupSpill 不可能被调）', async () => {
    const spills: string[] = [];
    const { deps } = dmHarness({
      enqueueGroupSpill: async (groupId) => void spills.push(groupId),
    });
    // Whatever the spill dice say, a plan with no group has nowhere to spill.
    for (let i = 0; i < 6; i++) {
      await runAgentDm({ a: 'ai_lin', b: 'ai_ada', fireAt: NOON + i * HOUR }, deps);
    }
    expect(spills).toEqual([]);
  });
});

/* ==================================================================== */
/* 6 — stance 写入方 1→4                                                 */
/* ==================================================================== */

describe('stance 写入方 (J1-6)', () => {
  it('语气判定：负面词命中，日常话不命中', () => {
    expect(hostileTone('他真的好烦，气死我了')).toBe(true);
    expect(hostileTone('就这？谁信啊')).toBe(true);
    expect(hostileTone('今天天气不错，吃了火锅')).toBe(false);
  });

  it('第三者点名 + 负面语气才计账；名字不足两字不匹配', () => {
    const peers = [
      { contactId: 'ai_ada', name: 'Ada' },
      { contactId: 'ai_chen', name: '陈叔' },
    ];
    expect(detectStanceMention('陈叔真的好烦，老是放鸽子', peers)?.contactId).toBe('ai_chen');
    expect(detectStanceMention('今天和陈叔吃了饭，挺开心', peers)).toBeNull();
    expect(detectStanceMention('好烦啊今天', peers)).toBeNull();
  });

  it('DM 八卦落库时同步讲述者对 about 对象的 stance（写入方 4）', async () => {
    const { deps } = dmHarness({
      complete: async () =>
        '{"speaker":"A","text":"嗨"}\n{"speaker":"B","text":"嗯"}\n' +
        '{"gossip":{"about":"B","fact":"Ada 老是放鸽子，真的很烦"}}',
    });
    await runAgentDm({ a: 'ai_lin', b: 'ai_ada', groupId: 'g1', fireAt: NOON }, deps);
    // recordStance writes through the real repo (fake-indexeddb) — read it back.
    expect(await getStance('ai_lin', 'ai_ada', NOON)).toBeLessThan(0);
  });

  it('四个写入方都在源码里活着（单聊搭车 / 朋友圈落库 / DM 八卦 / 群导演）', () => {
    expect(read('src/ai/engine.ts')).toContain('detectStanceMention(');
    expect(read('src/ai/moments-service.ts')).toContain('recordStance(');
    expect(read('src/ai/agent-dm.ts')).toContain('recordStance(');
    expect(read('src/ai/group-engine.ts')).toContain('recordTease('); // writer #1, unchanged
  });
});

/* ==================================================================== */
/* 5 — drift 进 prompt                                                   */
/* ==================================================================== */

describe('drift 进 prompt (J1-5)', () => {
  it('温度线按漂移方向措辞，且不点破机制', () => {
    const warm: Drift = { d: { proactivity: TONE_FLOOR + 0.01 }, at: NOON, why: [] };
    const cold: Drift = { d: { proactivity: -(TONE_FLOOR + 0.01) }, at: NOON, why: [] };
    expect(driftToneLine(warm)).toContain('走得更近');
    expect(driftToneLine(cold)).toContain('心凉');
    expect(driftToneLine(warm)).not.toMatch(/drift|漂移|数值/);
    expect(driftToneLine(undefined)).toBe('');
    expect(driftToneLine({ d: {}, at: 0, why: [] })).toBe('');
  });

  it('事件累积出的漂移能自然把温度线点亮（同一套 applyEvent）', () => {
    let d: Drift = { d: {}, at: 0, why: [] };
    for (let i = 0; i < 12; i++) d = applyEvent(d, 'user_warm', NOON + i * HOUR);
    expect(driftToneLine(d)).toContain('走得更近');
  });

  it('两个引擎都改用漂移后的人设并接了温度线（双轨消灭）', () => {
    for (const f of ['src/ai/engine.ts', 'src/ai/group-engine.ts']) {
      const src = read(f);
      expect(src, `${f} 该用 applyDrift/driftedPersona 组 prompt`).toMatch(/applyDrift\(/);
      expect(src, `${f} 该接 driftToneLine`).toContain('driftToneLine(');
    }
  });
});

/* ==================================================================== */
/* 1 — 群聊 prompt 六层 + stickerRate 断路修复                            */
/* ==================================================================== */

describe('群演员补脑 (J1-1)', () => {
  it('六层全部接进群演员（源码守卫，缺一转红）', () => {
    const src = read('src/ai/group-engine.ts');
    for (const call of [
      'goalDirective(',
      'occasionDirective(',
      'threadAwareness(',
      'arcAwareness(',
      'voiceDirective(',
      'photoDirective(',
    ]) {
      expect(src, `group-engine 丢了 ${call} 层`).toContain(call);
    }
    // Layer order convention: everything appends AFTER the assemble call.
    expect(src.indexOf('assembleSystemPrompt(')).toBeLessThan(src.indexOf('goalDirective('));
  });

  it('群演员走 toPersonaView——注释里吹过的 stickerRate 继承这次是真的', () => {
    const src = read('src/ai/group-engine.ts');
    expect(src).toContain('toPersonaView(persona, member.name)');
    // The hand-rolled inline PersonaView (the broken wire) must not return.
    expect(src).not.toMatch(/persona:\s*\{\s*\n\s*name:\s*member\.name,\s*\n\s*core:/);
  });

  it('stickerRate 真的进 prompt：爱斗图的人设带斗图行', () => {
    const sys = assembleSystemPrompt({
      persona: { name: '斗图侠', core: 'c', stickerRate: 0.9 },
      nsfwTier: 'off',
      scene: { kind: 'group', now: new Date(NOON), groupRoster: ['甲', '乙'] },
    });
    expect(sys).toContain('斗图');
  });

  it('群播放侧解析 photo 气泡（prompt 提供的能力，播放端必须接得住）', () => {
    expect(read('src/ai/group-engine.ts')).toContain('resolvePhotoBubble(');
  });
});

/* ==================================================================== */
/* 3 — 通话同脑                                                          */
/* ==================================================================== */

/** A time at which this contact's goal is ACTIVE (pure scan, deterministic). */
function activeGoalTime(contactId: string): number {
  const epoch = agentEpoch(contactId);
  for (let d = 0; d < 500; d++) {
    const t = NOON + d * DAY;
    if (goalStateAt(contactId, t, epoch).status === 'active') return t;
  }
  throw new Error('no active goal window found');
}

describe('通话同脑 (J1-3)', () => {
  it('buildCallSystem 带 mood / lifeline / goal 层', async () => {
    const id = 'ai_callbrain';
    const t = activeGoalTime(id);
    const sys = await buildCallSystem({
      peer: { id, type: 'ai', name: '小雨', avatarColor: '#000', avatarText: '雨' },
      persona: makePersona({ contactId: id, core: 'c' }),
      tier: 'off',
      recent: [],
      now: t,
      convId: 'c_call',
    });
    expect(sys).toContain(moodOf(id, t).line);
    expect(sys).toContain('【你最近的状态】');
    expect(sys).toContain('【你手头的一个长期目标】');
    expect(sys).toContain('# 当前场景补充'); // the call block still殿后
    expect(read('src/ai/call-script.ts')).toContain('occasionDirective(');
  });

  it('recordCallOutcome 落 conv-state + memory_facts + conv_summaries', async () => {
    const convId = 'c_call_j1';
    const contactId = 'ai_callmem';
    await recordCallOutcome(convId, contactId, '说好周五一起去看展', ['周五看展'], NOON, 'off');
    expect((await getConvState(convId)).promises).toContain('周五看展');
    const mem = await repo.getMemory(contactId);
    expect(mem).toHaveLength(1);
    expect(mem[0].importance).toBe(3);
    expect(mem[0].evidenceMsgIds).toEqual([]);
    expect(mem[0].fact).toContain('说好周五一起去看展');
    expect((await repo.getConvSummary(convId))?.summary).toContain('刚通了电话');
  });

  it('full 档通话的纪要打上 nsfw 敏感度（进不了群/朋友圈注入）', async () => {
    const contactId = 'ai_callgrade';
    await recordCallOutcome('c_call_j2', contactId, '一段私密约定', [], NOON, 'full');
    const mem = await repo.getMemory(contactId);
    expect(mem[0].sensitivity).toBe('nsfw');
    const sel = selectFactsForInjection(mem, NOON + 1, { surface: 'group', tier: 'full' });
    expect([...sel.pinned, ...sel.topK]).toEqual([]);
  });

  function callHarness(contactId: string, convId: string) {
    const counters = { summaries: 0 };
    const fakeRouter = {
      complete: async () => {
        counters.summaries++;
        return { text: '说好周五见', finishReason: 'stop', raw: null };
      },
      generate: async function* (): AsyncIterable<Bubble> {
        yield { type: 'text', content: '喂，说好周五见' };
      },
    } as unknown as LlmRouter;
    const sess = new CallSession({
      convId,
      peer: { id: contactId, type: 'ai', name: '小雨', avatarColor: '#000', avatarText: '雨' },
      persona: makePersona({ contactId, core: 'c' }),
      globalTier: 'off',
      direction: 'out',
      recent: [],
      now: () => NOON,
      onLine: () => {},
      router: fakeRouter,
      tts: {
        available: async () => false,
        ensure: async () => null,
        play: async () => false,
        stop: () => {},
      },
      pace: () => 0,
    });
    return { sess, counters };
  }

  it('卸载路径只调 end() 也落纪要——这正是 M-J1 修的洞', async () => {
    const { sess } = callHarness('ai_callunmount', 'c_call_um');
    await sess.start();
    expect(sess.turns.length).toBeGreaterThan(0);
    sess.end(); // CallPage cleanup does exactly this, nothing more
    // end() fires the (async) finalize itself; poll for the landing. A timeout
    // here means end() stopped owning the纪要 — the exact regression.
    await expect
      .poll(async () => (await repo.getMemory('ai_callunmount')).length, { timeout: 2000 })
      .toBe(1);
    expect((await getConvState('c_call_um')).promises.length).toBeGreaterThan(0);
  });

  it('挂断分支与 end() 殊途同归：finalize 幂等不双写', async () => {
    const { sess, counters } = callHarness('ai_callfin', 'c_call_fin');
    await sess.start();
    sess.end(); // the unmount path
    sess.end(); // double hang-up
    await sess.finalize(); // …and the explicit hang-up branch joins the same promise
    await sess.finalize();
    expect(counters.summaries).toBe(1); // one summarize call, ever
    expect((await repo.getMemory('ai_callfin')).length).toBe(1); // one memory row
    expect((await getConvState('c_call_fin')).promises.length).toBeGreaterThan(0);
  });
});

/* ==================================================================== */
/* 4 — 离线回填产记忆                                                    */
/* ==================================================================== */

describe('离线回填产记忆 (J1-4)', () => {
  const persona = (id: string): PersonaVM =>
    makePersona({ contactId: id, core: 'c', activeHours: [[0, 24]], proactivity: 0.9 });

  function busyGroupInput(): SimInput {
    return {
      singles: [],
      groups: [
        {
          convId: 'g_busy',
          memberIds: ['ai_a', 'ai_b', 'ai_c', 'ai_d'].map((id) => persona(id).contactId),
          lastMsgAt: 0,
          activity: 2,
        },
      ],
    };
  }

  it('72h 种子回放包含 mem_extract（窗口截到 24h 后群聊仍够热闹）', () => {
    const plan = simulate(NOON - 72 * HOUR, NOON, busyGroupInput(), 'j1');
    const mems = plan.events.filter((e) => e.kind === 'mem_extract');
    expect(mems).toHaveLength(1);
    // Group memory subject IS the conversation (ChatPage convention).
    expect(mems[0].contactId).toBe('g_busy');
    expect(mems[0].convId).toBe('g_busy');
    // Scheduled at the window tail — after every planned line it remembers.
    for (const e of plan.events) expect(mems[0].at).toBeGreaterThanOrEqual(e.at);
  });

  it('llmCalls 预算把 mem_extract 算了账（总成本仍 ≤ 上限）', () => {
    const plan = simulate(NOON - 72 * HOUR, NOON, busyGroupInput(), 'j1');
    const cost = plan.events.reduce((n, e) => n + LLM_COST[e.kind], 0);
    expect(LLM_COST.mem_extract).toBe(1);
    expect(cost).toBeLessThanOrEqual(LIMITS.llmCalls);
    // …and it did not ride for free: with the extraction present, at least one
    // chatter line was traded away for it.
    expect(plan.events.some((e) => e.kind === 'mem_extract')).toBe(true);
    expect(plan.events.filter((e) => e.kind === 'group_msg').length).toBeLessThanOrEqual(
      LIMITS.llmCalls - 1,
    );
  });

  it(`不够 ${MEM_EXTRACT_MIN_NEW} 条的会话不排抽取`, () => {
    const quiet: SimInput = {
      singles: [
        { contactId: 'ai_solo', convId: 'c_solo', persona: persona('ai_solo'), lastMsgAt: 0 },
      ],
      groups: [],
    };
    const plan = simulate(NOON - 6 * HOUR, NOON, quiet, 'j1');
    // A single chat caps at 2 messages per absence — never enough to extract.
    expect(plan.events.filter((e) => e.kind === 'mem_extract')).toEqual([]);
  });
});

/* ==================================================================== */
/* 8 — goals 活化                                                        */
/* ==================================================================== */

describe('goals 活化 (J1-8)', () => {
  const goodTemplates: GoalTemplate[] = [
    {
      domain: 'skill',
      title: '把攀岩练到 V4',
      milestones: ['办了岩馆卡', '第一次完攀 V2', '开始摸 V3 线路'],
      setbacks: ['手指拉伤歇了两周'],
      typicalDays: 90,
      abandonRate: 0.3,
    },
    {
      domain: 'study',
      title: '啃完那本大部头',
      milestones: ['读完第一章', '过半了', '只剩附录'],
      setbacks: ['出差一周没翻页'],
      typicalDays: 60,
      abandonRate: 0.2,
    },
    {
      domain: 'health',
      title: '晨跑打卡一百天',
      milestones: ['坚持到第十天', '过半程', '只差最后十天'],
      setbacks: ['下雨断了三天'],
      typicalDays: 100,
      abandonRate: 0.4,
    },
  ];

  it('值域校验：坏值一票否决，好值放行（转红守卫）', () => {
    expect(sanitizeGoalTemplates(goodTemplates)).toHaveLength(3);
    expect(sanitizeGoalTemplates(null)).toBeNull();
    expect(sanitizeGoalTemplates([])).toBeNull();
    // Too few survivors → the whole set is refused (不许空目标).
    expect(sanitizeGoalTemplates(goodTemplates.slice(0, 2))).toBeNull();
    const bad = (patch: Partial<GoalTemplate>) =>
      sanitizeGoalTemplates([{ ...goodTemplates[0], ...patch }, ...goodTemplates.slice(1)]);
    expect(bad({ typicalDays: 3 })).toBeNull(); // a 3-day "long-term" goal
    expect(bad({ typicalDays: 4000 })).toBeNull();
    expect(bad({ abandonRate: 0.95 })).toBeNull(); // a life of pure giving-up
    expect(bad({ domain: 'world_domination' as never })).toBeNull();
    expect(bad({ milestones: ['只有一条'] })).toBeNull();
    expect(bad({ setbacks: [] })).toBeNull();
    expect(bad({ title: '' })).toBeNull();
  });

  it('纯函数推进吃自定义模板：标题来自生成集，epoch/推进逻辑原封不动', () => {
    const id = 'ai_goalgen';
    const t = NOON + 30 * DAY;
    const custom = goalStateAt(id, t, agentEpoch(id), goodTemplates);
    expect(goodTemplates.some((g) => g.title === custom.title)).toBe(true);
    // Same inputs, same life — replayable forever.
    expect(goalStateAt(id, t, agentEpoch(id), goodTemplates)).toEqual(custom);
  });

  it('goalTemplatesFor：存了合法集用它，垃圾行退回内建模板（不许空目标）', async () => {
    const id = 'ai_goalstore';
    await repo.putSetting(`goalTpl:${id}`, goodTemplates);
    expect((await goalTemplatesFor(id)).map((t) => t.title)).toContain('把攀岩练到 V4');
    await repo.putSetting(`goalTpl:${id}`, { junk: true });
    expect(await goalTemplatesFor(id)).toEqual(GOAL_TEMPLATES);
  });

  it('ensureGoalTemplates：一次调用产 title+milestones，失败不落库', async () => {
    const id = 'ai_goalchain';
    let calls = 0;
    const ok = await ensureGoalTemplates(
      id,
      { core: '爱攀岩的插画师' },
      {
        complete: async () => {
          calls++;
          return JSON.stringify(goodTemplates);
        },
      },
    );
    expect(ok).toBe(true);
    expect(calls).toBe(1);
    expect((await goalTemplatesFor(id)).map((t) => t.title)).toContain('晨跑打卡一百天');
    // Second ensure is free — the set is stored for life.
    await ensureGoalTemplates(id, { core: 'x' }, { complete: async () => '不该被调' });
    expect((await goalTemplatesFor(id))[0].title).toBe('把攀岩练到 V4');

    const bad = await ensureGoalTemplates(
      'ai_goalfail',
      { core: 'c' },
      { complete: async () => '{"not":"an array"}' },
    );
    expect(bad).toBe(false);
    expect(await goalTemplatesFor('ai_goalfail')).toEqual(GOAL_TEMPLATES);
  });

  it('改标题 / 放弃：覆盖层生效，且放弃后份额外的分享通道闭嘴', async () => {
    const id = 'ai_goaledit';
    const t = activeGoalTime(id);
    await renameCurrentGoal(id, t, '我给它起的新名字');
    let state = await goalStateFor(id, t);
    expect(state.title).toBe('我给它起的新名字');
    // The prompt line follows the rename — one brain, every surface.
    expect(goalDirective(state, t)).toContain('我给它起的新名字');

    await abandonCurrentGoal(id, t);
    state = await goalStateFor(id, t + 1);
    expect(state.status).toBe('abandoned');
    expect(state.endedAt).toBe(t);
    // The seeded share channel must not announce a life she already closed.
    expect(await latestTerminalEventFor(id, t + HOUR)).toBeNull();
  });

  it('applyGoalOverrides 是纯函数：不改传入对象，未来里程碑被遮住', () => {
    const id = 'ai_goalpure';
    const t = activeGoalTime(id);
    const base = goalStateAt(id, t, agentEpoch(id));
    const out = applyGoalOverrides(base, { abandoned: { [base.cycle]: t } }, t + 1);
    expect(base.status).toBe('active'); // untouched
    expect(out.status).toBe('abandoned');
    for (const m of out.milestones) {
      if (m.at > t) expect(m.reached).toBe(false);
    }
  });

  it('StatusPage 有编辑入口，engine/moments/drift 读的是同一个服务', () => {
    const page = read('src/features/contacts/StatusPage.tsx');
    expect(page).toContain('renameCurrentGoal(');
    expect(page).toContain('abandonCurrentGoal(');
    expect(page).toContain('ensureGoalTemplates(');
    expect(read('src/ai/engine.ts')).toContain('goalStateFor(');
    expect(read('src/ai/moments-engine.ts')).toContain('goalStateFor(');
    expect(read('src/ai/drift.ts')).toContain('goalTemplatesFor(');
  });
});
