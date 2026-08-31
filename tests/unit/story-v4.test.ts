import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { repo } from '../../src/db/repo';
import { idbGetAll, idbDelete } from '../../src/db/idb';
import {
  validateScript,
  outEdgesOf,
  strandedNodes,
  reachableFrom,
  type Script,
} from '../../src/ai/story-script';
import {
  makeSave,
  planBeat,
  applyTrigger,
  applyChoiceOption,
  openChoice,
  hasPendingChoice,
  rollbackTo,
  restoreSlot,
  planSlotRestore,
  planRollback,
  writeSlot,
  putSave,
  getSave,
  saveScript,
  type StorySaveRow,
} from '../../src/ai/story-gm';
import { legacyOf, carriedVars, ngPlusOpening } from '../../src/ai/story-runs';
import { eligibleStages, actorPoolOf } from '../../src/features/story/CastingSheet';
import {
  applyChoice,
  chainNextBeat,
  runStoryBeat,
  tickMsFor,
  hasLiveTick,
  scheduleNextBeat,
  STORY_TICK_MS,
  STORY_TICK_ACTIVE_MS,
  type StoryHooks,
} from '../../src/ai/story-service';
import { applyStoryStamp, resetStoryStamps, storyStampFor } from '../../src/ai/story-stamp';
import { layoutScript } from '../../src/ai/story-layout';
import type { ConversationVM, MessageVM } from '../../src/data/types';

/**
 * 剧情 V4 (M-J9): choice 节点 / 单聊剧情 / NG+ / 两个真 bug / 节奏自适应。
 *
 * 计划点名的红测都在这里：
 *  - 带 choice 的剧本校验（goto 存在、1-4 个选项、环检测算入 choice 边）；
 *  - 选择后推进正确、未选时 tick 不前进（且链停排）；
 *  - 单聊可开演、群逻辑不回归；
 *  - storySeq 接读者——零水位快照也能按幕裁剪，且绝不误伤上一周目；
 *  - 两幕存档 → 读档 → 水位与幕号一致（旧实现读档多回退一幕）。
 */

const T0 = 1_758_000_000_000;

/** entry 就是 choice 节点的最小剧本：暂停、选择、两个结局。 */
const CHOICE_SCRIPT: Script = {
  scriptId: 'v4choice',
  title: '岔路口',
  nsfwLevel: 0,
  cast: [{ charId: 'a', role: '演员' }],
  vars: { picked: 0 },
  entry: 'open',
  nodes: [
    {
      id: 'open',
      goal: '走到岔路口',
      onEnter: { narrate: '路在这里分成了两条。' },
      directives: [{ charId: 'a', instruction: '看着岔路感叹一句' }],
      triggers: [],
      choice: {
        prompt: '走哪条？',
        options: [
          { label: '左边', setVars: { picked: 1 }, goto: 'left' },
          { label: '右边', setVars: { picked: 2 }, goto: 'right' },
        ],
      },
    },
    { id: 'left', goal: '左路的结局', directives: [], triggers: [], ending: true },
    { id: 'right', goal: '右路的结局', directives: [], triggers: [], ending: true },
  ],
};

const mkSave = (script: Script, over: Partial<StorySaveRow> = {}): StorySaveRow => ({
  ...makeSave({
    script,
    convId: 'g_v4',
    bindings: Object.fromEntries(script.cast.map((c, i) => [c.charId, `ai_${i}`])),
    globalTier: 'off',
    now: T0,
    run: 1,
  }),
  ...over,
});

async function wipe(store: string) {
  for (const row of await idbGetAll<{ id: string | number }>(store)) {
    await idbDelete(store, row.id);
  }
}

/* ==================== 1. choice：schema 与图分析 ==================== */

describe('choice 节点校验', () => {
  it('带 choice 的剧本通过校验（choice 即出口，不算 dead_end）', () => {
    const r = validateScript(CHOICE_SCRIPT);
    expect(r.issues.map((i) => i.message).join(' | ')).toBe('');
    expect(r.ok).toBe(true);
  });

  it('goto 指向不存在的节点 → dangling_edge', () => {
    const bad = {
      ...CHOICE_SCRIPT,
      nodes: CHOICE_SCRIPT.nodes.map((n) =>
        n.id === 'open'
          ? {
              ...n,
              choice: {
                prompt: '走哪条？',
                options: [{ label: '幽灵路', goto: 'nowhere' }],
              },
            }
          : n,
      ),
    };
    expect(validateScript(bad).issues.map((i) => i.code)).toContain('dangling_edge');
  });

  it('选项超过 4 个 → schema 打回', () => {
    const five = Array.from({ length: 5 }, (_, i) => ({ label: `选项${i}`, goto: 'left' }));
    const bad = {
      ...CHOICE_SCRIPT,
      nodes: CHOICE_SCRIPT.nodes.map((n) =>
        n.id === 'open' ? { ...n, choice: { prompt: '？', options: five } } : n,
      ),
    };
    const r = validateScript(bad);
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.code)).toContain('schema');
  });

  it('结局节点带 choice → choice_conflict（选项永远不会出现）', () => {
    const bad = {
      ...CHOICE_SCRIPT,
      nodes: CHOICE_SCRIPT.nodes.map((n) =>
        n.id === 'left'
          ? { ...n, choice: { prompt: '？', options: [{ label: 'x', goto: 'right' }] } }
          : n,
      ),
    };
    expect(validateScript(bad).issues.map((i) => i.code)).toContain('choice_conflict');
  });

  it('choice 边算进可达性——只能靠选项到达的节点不是孤岛', () => {
    // left/right 只有 choice 边指向它们；去掉 choice 边它们就 unreachable。
    expect([...reachableFrom(CHOICE_SCRIPT)].sort()).toEqual(['left', 'open', 'right']);
    expect(validateScript(CHOICE_SCRIPT).issues.map((i) => i.code)).not.toContain('unreachable');
  });

  it('choice 边算进逃逸分析——环的唯一出口是选项时不算 stranded', () => {
    // a ⇄ b 互指成环，唯一的出路是 b 的 choice → end。
    const looped: Script = {
      scriptId: 'v4loop',
      title: '环',
      nsfwLevel: 0,
      cast: [{ charId: 'a', role: 'x' }],
      vars: {},
      entry: 'a',
      nodes: [
        { id: 'a', goal: 'A', directives: [], triggers: [{ when: 'expr:true', to: 'b' }] },
        {
          id: 'b',
          goal: 'B',
          directives: [],
          triggers: [{ when: 'expr:false', to: 'a' }],
          choice: { prompt: '出去吗？', options: [{ label: '出去', goto: 'end' }] },
        },
        { id: 'end', goal: '终', directives: [], triggers: [], ending: true },
      ],
    };
    expect(strandedNodes(looped)).toEqual([]);
    expect(validateScript(looped).ok).toBe(true);
    // 把 choice 摘掉，环就没有出口了——同一张图必须转红。
    const sealed: Script = {
      ...looped,
      nodes: looped.nodes.map((n) => (n.id === 'b' ? { ...n, choice: undefined } : n)),
    };
    expect(strandedNodes(sealed)).toEqual(['a', 'b']);
  });

  it('outEdgesOf 是唯一的出边清单：trigger + timeout + choice', () => {
    const n = {
      id: 'n',
      goal: 'g',
      directives: [],
      triggers: [{ when: 'expr:true', to: 't1' }],
      timeout: { turns: 3, to: 't2' },
      choice: { prompt: '?', options: [{ label: 'x', goto: 't3' }] },
    };
    expect(outEdgesOf(n as Script['nodes'][number]).sort()).toEqual(['t1', 't2', 't3']);
  });

  it('分支图把 choice 画成边（布局与校验同源）', () => {
    const l = layoutScript(CHOICE_SCRIPT);
    const kinds = l.edges.filter((e) => e.from === 'open').map((e) => e.kind);
    expect(kinds).toEqual(['choice', 'choice']);
    // 只能靠 choice 到达的节点不再被排进「孤岛列」。
    expect(l.nodes.find((n) => n.id === 'left')!.col).toBe(1);
  });
});

/* ==================== 2. choice：运行时暂停与推进 ==================== */

describe('choice 运行时：暂停、点选、重排', () => {
  beforeEach(async () => {
    await wipe('scheduled_actions');
    await wipe('messages');
    resetStoryStamps();
    await saveScript(CHOICE_SCRIPT, 'import', T0);
  });

  /** 记录一切 append 与 playBeat 的 hooks，append 走真 stamp 管道。 */
  function recordingHooks(appended: Array<Record<string, unknown>>, played: string[]): StoryHooks {
    return {
      appendMessage: async (m) => {
        const stamped = applyStoryStamp(m);
        appended.push(stamped as unknown as Record<string, unknown>);
        await repo.addMessage(stamped as Parameters<typeof repo.addMessage>[0]);
      },
      playBeat: async (convId) => {
        played.push(convId);
      },
      contactById: () => undefined,
      now: () => T0 + 10,
    };
  }

  it('GM 推进到 choice：灰条落地、pendingChoice 入库、不演不推进', async () => {
    await putSave(mkSave(CHOICE_SCRIPT, { id: 'save_choice_open' }));
    const appended: Array<Record<string, unknown>> = [];
    const played: string[] = [];
    const r = await runStoryBeat('save_choice_open', recordingHooks(appended, played));
    expect(r.finished).toBe(false);

    // 旁白 + 抉择 prompt 两条灰条，都带本幕戳（回滚会把问题一起收走、重新提问）。
    expect(appended.map((m) => m.content)).toEqual(['路在这里分成了两条。', '【剧情抉择】走哪条？']);
    for (const m of appended) {
      expect(m.storyScriptId).toBe('v4choice');
      expect(m.storySeq).toBe(0);
    }
    // 演员一句没演——choice 的暂停是确定性的、零 LLM 调用的。
    expect(played).toEqual([]);
    // 戳已收口。
    expect(storyStampFor('g_v4')).toBeUndefined();

    const save = (await getSave('save_choice_open'))!;
    expect(hasPendingChoice(save)).toBe(true);
    expect(save.pendingChoice!.prompt).toBe('走哪条？');
    expect(save.pendingChoice!.options.map((o) => o.label)).toEqual(['左边', '右边']);
    expect(save.seq).toBe(0);
  });

  it('未选时 tick 不前进：再来一拍什么都不发生，链也不排后继', async () => {
    await putSave(mkSave(CHOICE_SCRIPT, { id: 'save_choice_wait' }));
    const appended: Array<Record<string, unknown>> = [];
    const played: string[] = [];
    await runStoryBeat('save_choice_wait', recordingHooks(appended, played));
    const before = appended.length;

    // 等待期又落下一拍（链先于工作排的那个后继）——不演、不重复提问、不计轮。
    const r = await runStoryBeat('save_choice_wait', recordingHooks(appended, played));
    expect(r.finished).toBe(false);
    expect(appended.length).toBe(before);
    expect(played).toEqual([]);
    const save = (await getSave('save_choice_wait'))!;
    expect(save.seq).toBe(0);
    expect(save.turnsInNode).toBe(0);

    // 链侧：choice 等待 → tickMsFor 为 null → 不排任何后继。
    await chainNextBeat({ saveId: 'save_choice_wait', convId: 'g_v4', tick: 1 }, T0 + 20);
    const actions = await idbGetAll<{ kind: string }>('scheduled_actions');
    expect(actions.filter((a) => a.kind === 'story_tick')).toHaveLength(0);
  });

  it('点选 → 落 vars → goto → 清等待 → 重排 tick，「选择」灰条带戳', async () => {
    await putSave(mkSave(CHOICE_SCRIPT, { id: 'save_choice_pick' }));
    const appended: Array<Record<string, unknown>> = [];
    const played: string[] = [];
    const hooks = recordingHooks(appended, played);
    await runStoryBeat('save_choice_pick', hooks);

    const next = await applyChoice('save_choice_pick', 1, T0 + 60_000, hooks);
    expect(next).toBeDefined();
    expect(next!.nodeId).toBe('right');
    expect(next!.vars.picked).toBe(2);
    expect(next!.seq).toBe(1);
    expect(hasPendingChoice(next!)).toBe(false);
    // 持久化了，不只是内存里的。
    expect(hasPendingChoice((await getSave('save_choice_pick'))!)).toBe(false);

    // 「选择」灰条属于做决定的那一幕（seq 0），回滚到第 0 幕会连它一起收走。
    const line = appended.at(-1)!;
    expect(line.content).toBe('【选择】右边');
    expect(line.storySeq).toBe(0);

    // 快照记录了点选前的水位：回滚回来会回到未选状态、重新提问。
    expect(next!.history.at(-1)!.seq).toBe(0);

    // tick 链重开（等待期没有在途 tick，本测开头清过表）。
    const ticks = (await idbGetAll<{ kind: string; payloadJson: string; fireAt: number }>(
      'scheduled_actions',
    )).filter((a) => a.kind === 'story_tick');
    expect(ticks).toHaveLength(1);
    // 用户刚点过按钮 = 在场，走 15s 档。
    expect(ticks[0].fireAt).toBe(T0 + 60_000 + STORY_TICK_ACTIVE_MS);
  });

  it('等待窗口里还挂着旧 tick 时，点选不会开出第二条链', async () => {
    const save = mkSave(CHOICE_SCRIPT, { id: 'save_choice_race' });
    await putSave(save);
    const appended: Array<Record<string, unknown>> = [];
    const hooks = recordingHooks(appended, []);
    await runStoryBeat('save_choice_race', hooks);
    // 链先于工作排的那个后继还在队列里：
    await scheduleNextBeat(save, T0, 7);
    expect(await hasLiveTick('save_choice_race')).toBe(true);

    await applyChoice('save_choice_race', 0, T0 + 5_000, hooks);
    const ticks = (await idbGetAll<{ kind: string }>('scheduled_actions')).filter(
      (a) => a.kind === 'story_tick',
    );
    // 只有原来那一个——不开双链（双链=并行演两台戏，永不收敛）。
    expect(ticks).toHaveLength(1);
  });

  it('越界与重复点选都是 no-op', async () => {
    await putSave(mkSave(CHOICE_SCRIPT, { id: 'save_choice_oob' }));
    const appended: Array<Record<string, unknown>> = [];
    const hooks = recordingHooks(appended, []);
    await runStoryBeat('save_choice_oob', hooks);
    expect(await applyChoice('save_choice_oob', 9, T0 + 1, hooks)).toBeUndefined();
    expect(hasPendingChoice((await getSave('save_choice_oob'))!)).toBe(true);
    // 正常点一次之后，等待清空，再点直接 undefined。
    await applyChoice('save_choice_oob', 0, T0 + 2, hooks);
    expect(await applyChoice('save_choice_oob', 0, T0 + 3, hooks)).toBeUndefined();
  });

  it('applyChoiceOption 是纯函数层：结构上就是一次 applyTrigger', () => {
    let save = mkSave(CHOICE_SCRIPT);
    save = openChoice(save, CHOICE_SCRIPT.nodes[0], T0);
    const stepped = applyChoiceOption(save, 0, T0 + 1, 42)!;
    expect(stepped.save.nodeId).toBe('left');
    expect(stepped.save.vars.picked).toBe(1);
    expect(stepped.save.pendingChoice).toBeUndefined();
    expect(stepped.save.history.at(-1)!.msgCursor).toBe(42);
    // 没有等待、越界索引 → null，绝不瞎走。
    expect(applyChoiceOption(mkSave(CHOICE_SCRIPT), 0, T0, 0)).toBeNull();
    expect(applyChoiceOption(save, 5, T0, 0)).toBeNull();
  });

  it('回滚清掉 pendingChoice——等待属于被回滚掉的时刻', async () => {
    let save = mkSave(CHOICE_SCRIPT, { id: 'save_choice_rb' });
    save = applyTrigger(save, { when: 'expr:true', to: 'open' }, T0 + 1, 0).save;
    save = openChoice(save, CHOICE_SCRIPT.nodes[0], T0 + 2);
    await putSave(save);
    const r = await rollbackTo(save, 0, T0 + 3);
    expect(hasPendingChoice(r.save)).toBe(false);
  });
});

/* ==================== 3. 单聊剧情 ==================== */

describe('单聊剧情：舞台放开 single，群逻辑不回归', () => {
  const conv = (over: Partial<ConversationVM>): ConversationVM =>
    ({
      id: 'c',
      type: 'single',
      title: 't',
      avatarColor: '',
      avatarText: '',
      isPinned: false,
      isMuted: false,
      unreadCount: 0,
      mentionMe: false,
      lastMsgPreview: '',
      lastMsgAt: 0,
      ...over,
    }) as ConversationVM;

  const personaFor = (id: string) => (id.startsWith('ai_') ? { contactId: id } : undefined);

  it('peer 有 persona 的单聊可开演；隐藏行与无 persona 的进不来', () => {
    const rows = [
      conv({ id: 's1', type: 'single', peerId: 'ai_lin' }),
      conv({ id: 's2', type: 'single', peerId: 'human_x' }),
      // 隐藏 DM 正是 single 型——V4 放开 single 后，这条过滤是唯一防线。
      conv({ id: 's3', type: 'single', peerId: 'ai_ada', isHidden: true }),
      conv({ id: 'g1', type: 'group', memberIds: ['ai_a', 'ai_b'] }),
      conv({ id: 'g2', type: 'group', memberIds: ['ai_a'] }),
      conv({ id: 'g3', type: 'group', memberIds: ['ai_a', 'ai_b'], isHidden: true }),
    ];
    expect(eligibleStages(rows, personaFor).map((c) => c.id)).toEqual(['s1', 'g1']);
  });

  it('单聊的演员池 = peer + 我自己；群仍是 persona 成员', () => {
    expect(actorPoolOf(conv({ type: 'single', peerId: 'ai_lin' }), personaFor)).toEqual([
      'ai_lin',
      'self',
    ]);
    expect(
      actorPoolOf(conv({ type: 'group', memberIds: ['ai_a', 'human_x', 'ai_b'] }), personaFor),
    ).toEqual(['ai_a', 'ai_b']);
    expect(actorPoolOf(null, personaFor)).toEqual([]);
  });

  it('绑给 self 的角色不产出指令——用户的秘密绝不进任何 AI 的 prompt', () => {
    const script: Script = {
      scriptId: 'v4duet',
      title: '双人',
      nsfwLevel: 0,
      cast: [
        { charId: 'a', role: '甲', secret: '甲的秘密' },
        { charId: 'b', role: '乙', secret: '乙的秘密（用户演）' },
      ],
      vars: {},
      entry: 'n1',
      nodes: [
        {
          id: 'n1',
          goal: '开场',
          directives: [
            { charId: 'a', instruction: '甲的动作' },
            { charId: 'b', instruction: '乙的动作' },
          ],
          triggers: [],
          timeout: { turns: 3, to: 'end' },
        },
        { id: 'end', goal: '终', directives: [], triggers: [], ending: true },
      ],
    };
    const save = mkSave(script, { bindings: { a: 'ai_lin', b: 'self' } });
    const plan = planBeat(script, save)!;
    expect(Object.keys(plan.directives)).toEqual(['ai_lin']);
    expect(JSON.stringify(plan.directives)).not.toContain('乙的秘密');
  });

  it('种子里有为单聊写的双人本：两个角色、choice、pace 与 legacy 三合一', async () => {
    const { BUILTIN_SCRIPTS } = await import('../../src/ai/story-builtin');
    const duet = BUILTIN_SCRIPTS.find((s) => s.scriptId === 'builtin_last_train');
    expect(duet, '种子双人本《末班车》丢了').toBeDefined();
    expect(duet!.cast).toHaveLength(2);
    expect(duet!.nodes.some((n) => n.choice)).toBe(true);
    expect(duet!.nodes.some((n) => n.pace === 'fast')).toBe(true);
    expect(duet!.nodes.some((n) => n.pace === 'slow')).toBe(true);
    expect(duet!.legacy?.carry).toContain('met_before');
    expect(validateScript(duet!).ok).toBe(true);
  });

  it('接线：单聊 beat 走 sendProactiveMessage(story)，judge 的 tier 参与者用 peerId', () => {
    const runtime = readFileSync(
      resolve(__dirname, '../../src/app/useSchedulerRuntime.ts'),
      'utf8',
    );
    expect(
      /c\.type === 'single'[\s\S]{0,600}?sendProactiveMessage\([\s\S]{0,200}?story:/.test(runtime),
      '单聊 beat 必须经 sendProactiveMessage 的 story 通道下场——群导演不管单聊',
    ).toBe(true);
    expect(
      runtime.includes("c.type === 'single' && c.peerId ? [c.peerId]"),
      'judgeTriggers 的参与者集合：单聊没有 memberIds，空集会把 tier 判成 off（铁律 6）',
    ).toBe(true);
    // 引擎侧：story 分支存在，且跳过一次性台账（nudge/goal/线头）。
    const engine = readFileSync(resolve(__dirname, '../../src/ai/engine.ts'), 'utf8');
    expect(engine).toMatch(/opts\.story/);
    expect(engine).toMatch(/!opts\.nudge && !opts\.story/);
  });
});

/* ==================== 4. NG+ ==================== */

describe('NG+：结局遗产与白名单继承', () => {
  const script: Script = {
    ...CHOICE_SCRIPT,
    scriptId: 'v4ng',
    legacy: { carry: ['picked'] },
  };

  it('legacyOf 取最近完结的那轮；中止与进行中的都不算', () => {
    const saves: StorySaveRow[] = [
      mkSave(script, { id: 'r1', run: 1, isActive: false, endingId: 'left', endedAt: T0 + 1, vars: { picked: 1 } }),
      mkSave(script, { id: 'r2', run: 2, isActive: false, endingId: 'right', endedAt: T0 + 9, vars: { picked: 2 } }),
      mkSave(script, { id: 'r3', run: 3, isActive: false }), // 中止：没有 endingId
      mkSave(script, { id: 'r4', run: 4, isActive: true, endingId: 'left' }),
      { ...mkSave(script, { id: 'rx', isActive: false, endingId: 'left', endedAt: T0 + 99 }), scriptId: 'other' },
    ];
    const legacy = legacyOf(saves, 'v4ng')!;
    expect(legacy.saveId).toBe('r2');
    expect(legacy.run).toBe(2);
    expect(legacy.endingId).toBe('right');
    expect(legacy.vars.picked).toBe(2);
    expect(legacyOf(saves, 'nothing')).toBeUndefined();
  });

  it('carriedVars 只放行白名单；没声明 legacy 就什么都不带', () => {
    const finalVars = { picked: 2, secret_out: true, trust: 99 };
    expect(carriedVars(script, finalVars)).toEqual({ picked: 2 });
    expect(carriedVars(CHOICE_SCRIPT, finalVars)).toEqual({});
    // 白名单里但终局没有的键：不无中生有。
    expect(carriedVars(script, {})).toEqual({});
  });

  it('makeSave(inherit) 合并 vars 并记 ngPlus；不继承的开局两者都没有', () => {
    const ng = makeSave({
      script,
      convId: 'g_v4',
      bindings: { a: 'ai_0' },
      globalTier: 'off',
      now: T0,
      run: 2,
      inherit: { fromRun: 1, endingId: 'right', vars: { picked: 2 } },
    });
    expect(ng.vars).toEqual({ picked: 2 });
    expect(ng.ngPlus).toEqual({ fromRun: 1, endingId: 'right' });
    const plain = makeSave({ script, convId: 'g_v4', bindings: { a: 'ai_0' }, globalTier: 'off', now: T0 });
    expect(plain.vars).toEqual({ picked: 0 });
    expect(plain.ngPlus).toBeUndefined();
  });

  it('ngPlusOpening 报出上周目的结局，且不剧透节点 id 以外的路线', () => {
    const line = ngPlusOpening(script, { fromRun: 1, endingId: 'right' }, 2);
    expect(line).toContain('第 2 周目');
    expect(line).toContain('右路的结局');
    // 结局节点被删了也不炸——退回 id。
    expect(ngPlusOpening(script, { fromRun: 1, endingId: 'gone' }, 2)).toContain('gone');
  });

  it('NG+ 的第一拍注入开场灰条，且只注入一次', async () => {
    await wipe('messages');
    resetStoryStamps();
    const ngScript: Script = {
      ...script,
      scriptId: 'v4ng_run',
      entry: 'stage',
      nodes: [
        {
          id: 'stage',
          goal: '开场',
          directives: [],
          triggers: [{ when: 'expr:vars.picked >= 1', to: 'left' }],
          timeout: { turns: 9, to: 'right' },
        },
        ...script.nodes.filter((n) => n.ending),
      ],
    };
    expect((await saveScript(ngScript, 'import', T0)).ok).toBe(true);
    const save = makeSave({
      script: ngScript,
      convId: 'g_v4',
      bindings: { a: 'ai_0' },
      globalTier: 'off',
      now: T0,
      run: 2,
      inherit: { fromRun: 1, endingId: 'right', vars: { picked: 1 } },
    });
    await putSave({ ...save, id: 'save_ng_first' });
    const appended: Array<Record<string, unknown>> = [];
    const goals: string[] = [];
    const hooks: StoryHooks = {
      appendMessage: async (m) => {
        appended.push(m as unknown as Record<string, unknown>);
        await repo.addMessage(m as Parameters<typeof repo.addMessage>[0]);
      },
      playBeat: async (_c, _d, goal) => {
        goals.push(goal);
      },
      contactById: () => undefined,
      now: () => T0 + 5,
    };
    await runStoryBeat('save_ng_first', hooks);
    const openings = appended.filter((m) => String(m.content).includes('周目'));
    expect(openings).toHaveLength(1);
    expect(String(openings[0].content)).toContain('右路的结局');
    // 首拍的 goal 带既视感提示（不给旧剧情本体）。
    expect(goals[0]).toContain('既视感');

    // 继承的 picked=1 让 expr 触发器当场生效——seq 已推进到 1。
    const after = (await getSave('save_ng_first'))!;
    expect(after.seq).toBe(1);
    // 第二拍（seq>0）不再注入开场。
    await runStoryBeat('save_ng_first', hooks);
    expect(appended.filter((m) => String(m.content).includes('周目'))).toHaveLength(1);
  });

  it('接线：详情页开局走 legacyOf + carriedVars（白名单闸门在启动路径上）', () => {
    const page = readFileSync(
      resolve(__dirname, '../../src/features/story/ScriptDetailPage.tsx'),
      'utf8',
    );
    expect(page).toContain('legacyOf(');
    expect(page).toContain('carriedVars(');
    expect(page, 'NG+ 必须把继承传进 makeSave').toMatch(/makeSave\(\{[\s\S]{0,400}?inherit/);
  });
});

/* ==================== 5a. storySeq 接读者：按幕裁剪 ==================== */

describe('storySeq 终于有读者：零水位快照也能按幕裁剪', () => {
  beforeEach(async () => {
    await wipe('messages');
    await wipe('memory_facts');
    await wipe('moments');
  });

  const SEQ_SCRIPT: Script = { ...CHOICE_SCRIPT, scriptId: 'v4seq' };

  async function stamped(convId: string, content: string, seq: number, at: number, scriptId = 'v4seq') {
    return repo.addMessage({
      convId,
      senderId: 'ai_0',
      type: 'text',
      content,
      status: 'sent',
      createdAt: at,
      storyScriptId: scriptId,
      storySeq: seq,
    } as Parameters<typeof repo.addMessage>[0]);
  }

  it('回滚到第 N 幕删 storySeq>N 的本剧本消息；上一周目、别的剧本、普通聊天全都不动', async () => {
    // 上一周目的旧行：同剧本同会话，但 createdAt 早于本 run 开演。
    const prevRun = await stamped('g_v4', '上一周目的台词', 5, T0 - 1000);
    const act1 = await stamped('g_v4', '第一幕台词', 1, T0 + 100);
    const act2 = await stamped('g_v4', '第二幕台词', 2, T0 + 200);
    const plain = await repo.addMessage({
      convId: 'g_v4',
      senderId: 'self',
      type: 'text',
      content: '幕间闲聊',
      status: 'sent',
      createdAt: T0 + 250,
    });
    const other = await stamped('g_v4', '别的剧本', 9, T0 + 300, 'unrelated');

    // 零水位快照（pre-I7 形状）：msgCursor 0 —— 旧实现在这里完全裁不了消息。
    let save = mkSave(SEQ_SCRIPT, { id: 'save_seqtrim' });
    save = applyTrigger(save, { when: 'expr:true', to: 'left' }, T0 + 150, 0).save;
    save = applyTrigger(save, { when: 'expr:true', to: 'right' }, T0 + 260, 0).save;
    await putSave(save);

    const r = await rollbackTo(save, 1, T0 + 500);
    expect(r.save.seq).toBe(1);
    // 只有第二幕的台词被收走——这就是「按幕裁剪」。
    expect(r.messagesRemoved).toEqual([act2.id]);
    const left = (await repo.getMessages('g_v4', { limit: 50 })).map((m) => m.id);
    expect(left).toEqual([prevRun.id, act1.id, plain.id, other.id]);
    // 幸存行时间戳原样（rowid 序==时间序，宪法不变量）。
    const rows = await repo.getMessages('g_v4', { limit: 50 });
    expect(rows.find((m) => m.id === act1.id)!.createdAt).toBe(T0 + 100);
  });

  it('planRollback 的 trimsMessages 跟着真实裁剪走：零水位但有幕戳可裁 → true', async () => {
    const a2 = await stamped('g_v4', '第二幕', 2, T0 + 200);
    let save = mkSave(SEQ_SCRIPT, { id: 'save_seqplan' });
    save = applyTrigger(save, { when: 'expr:true', to: 'left' }, T0 + 150, 0).save;
    save = applyTrigger(save, { when: 'expr:true', to: 'right' }, T0 + 260, 0).save;
    const plan = await planRollback(save, 1);
    expect(plan.messageCount).toBe(1);
    expect(plan.trimsMessages).toBe(true);
    // 预览==执行。
    const r = await rollbackTo(save, 1, T0 + 500);
    expect(r.messagesRemoved).toEqual([a2.id]);
  });
});

/* ==================== 5b. restoreSlot 用槽自己的水位 ==================== */

describe('读档回到槽自己的位置：两幕存档 → 读档 → 水位与幕号一致', () => {
  beforeEach(async () => {
    await wipe('messages');
    await wipe('memory_facts');
    await wipe('moments');
  });

  async function line(convId: string, content: string, at: number): Promise<MessageVM> {
    return repo.addMessage({
      convId,
      senderId: 'ai_0',
      type: 'text',
      content,
      status: 'sent',
      createdAt: at,
    });
  }

  it('存完档没再推进也能原地读档——旧实现在这里多回退一幕', async () => {
    // 走两幕：seq 0 → 1 → 2，history 里只有 seq 0 / seq 1 的快照。
    let save = mkSave(CHOICE_SCRIPT, { id: 'save_slot_here' });
    save = applyTrigger(save, { when: 'expr:true', to: 'open' }, T0 + 1, 0).save;
    save = applyTrigger(save, { when: 'expr:true', to: 'left' }, T0 + 2, 0).save;
    expect(save.seq).toBe(2);
    expect(save.history.map((h) => h.seq)).toEqual([0, 1]);

    const m1 = await line('g_v4', '第二幕的台词', T0 + 10);
    const { save: withSlot, slot } = writeSlot(save, '就停在这', m1.id, T0 + 20);
    await putSave(withSlot);

    // 存档之后又发生了两句——读档要把它们收走。
    const m2 = await line('g_v4', '存档之后的话 1', T0 + 30);
    const m3 = await line('g_v4', '存档之后的话 2', T0 + 40);

    const r = await restoreSlot(withSlot, slot.id, T0 + 50);
    expect('error' in r).toBe(false);
    if ('error' in r) return;
    // 幕号 = 槽的幕号（旧实现：history 最近的 ≤2 快照是 seq 1 → 多退一幕）。
    expect(r.save.seq).toBe(2);
    expect(r.save.nodeId).toBe(slot.nodeId);
    expect(r.save.vars).toEqual(slot.vars);
    // 水位 = 槽自己的 msgCursor（旧实现读的是 history 快照的 0 → 什么都裁不了）。
    expect(r.messagesRemoved.sort((a, b) => a - b)).toEqual([m2.id, m3.id]);
    expect((await repo.getMessages('g_v4', { limit: 50 })).map((m) => m.id)).toEqual([m1.id]);
    // 槽自己幸存——检查点是可复用的。
    expect(r.save.slots?.some((s) => s.id === slot.id)).toBe(true);
  });

  it('planSlotRestore 引用槽自己的水位：预览==执行', async () => {
    let save = mkSave(CHOICE_SCRIPT, { id: 'save_slot_plan' });
    save = applyTrigger(save, { when: 'expr:true', to: 'open' }, T0 + 1, 0).save;
    const m1 = await line('g_v4', '锚点', T0 + 10);
    const { save: withSlot, slot } = writeSlot(save, '预览用', m1.id, T0 + 20);
    await line('g_v4', '之后的话', T0 + 30);

    const plan = (await planSlotRestore(withSlot, slot.id))!;
    expect(plan.restoredSeq).toBe(slot.seq);
    expect(plan.messageCount).toBe(1);
    expect(plan.trimsMessages).toBe(true);
    const r = await restoreSlot(withSlot, slot.id, T0 + 40);
    if ('error' in r) throw new Error(r.error);
    expect(r.messagesRemoved).toHaveLength(plan.messageCount);
    // 失效的槽：预览与执行一致地拒绝。
    expect(await planSlotRestore({ ...withSlot, seq: 0, slots: [slot] }, slot.id)).toBeNull();
  });
});

/* ==================== 6. 节奏自适应 ==================== */

describe('tickMsFor：一条 fireAt 算式，绝无第二套时钟', () => {
  const paced: Script = {
    ...CHOICE_SCRIPT,
    scriptId: 'v4pace',
    nodes: CHOICE_SCRIPT.nodes.map((n) =>
      n.id === 'left' ? { ...n, pace: 'fast' as const } : n.id === 'right' ? { ...n, pace: 'slow' as const } : n,
    ),
  };

  it('盯着看 15s，平时 45s，choice 等待不排', () => {
    const save = mkSave(paced, { nodeId: 'open' });
    expect(tickMsFor(save, paced, false)).toBe(STORY_TICK_MS);
    expect(tickMsFor(save, paced, true)).toBe(STORY_TICK_ACTIVE_MS);
    const waiting = openChoice(save, paced.nodes[0], T0);
    expect(tickMsFor(waiting, paced, false)).toBeNull();
    expect(tickMsFor(waiting, paced, true)).toBeNull();
  });

  it('pace fast ×½ / slow ×2，两档叠加在场倍率', () => {
    expect(tickMsFor(mkSave(paced, { nodeId: 'left' }), paced, false)).toBe(STORY_TICK_MS / 2);
    expect(tickMsFor(mkSave(paced, { nodeId: 'left' }), paced, true)).toBe(STORY_TICK_ACTIVE_MS / 2);
    expect(tickMsFor(mkSave(paced, { nodeId: 'right' }), paced, false)).toBe(STORY_TICK_MS * 2);
    // 剧本读不出来（被删了）→ 基础档，不炸。
    expect(tickMsFor(mkSave(paced, { nodeId: 'left' }), null, false)).toBe(STORY_TICK_MS);
  });

  it('chainNextBeat 按 tickMsFor 排 fireAt：在场 15s，不在场 45s', async () => {
    await wipe('scheduled_actions');
    await saveScript(CHOICE_SCRIPT, 'import', T0);
    // 用没有 choice 的节点，链才会排（open 是 choice 节点会直接停）。
    const save = mkSave(CHOICE_SCRIPT, { id: 'save_pace_chain', nodeId: 'left' });
    await putSave(save);

    await chainNextBeat({ saveId: 'save_pace_chain', convId: 'g_v4', tick: 1 }, T0, false);
    let ticks = (await idbGetAll<{ kind: string; fireAt: number }>('scheduled_actions')).filter(
      (a) => a.kind === 'story_tick',
    );
    expect(ticks).toHaveLength(1);
    expect(ticks[0].fireAt).toBe(T0 + STORY_TICK_MS);

    await wipe('scheduled_actions');
    await chainNextBeat({ saveId: 'save_pace_chain', convId: 'g_v4', tick: 1 }, T0, true);
    ticks = (await idbGetAll<{ kind: string; fireAt: number }>('scheduled_actions')).filter(
      (a) => a.kind === 'story_tick',
    );
    expect(ticks[0].fireAt).toBe(T0 + STORY_TICK_ACTIVE_MS);
  });

  it('接线：链侧把 activeConvId 在场信号真的传了进来；聊天页真的挂了选项条', () => {
    const runtime = readFileSync(
      resolve(__dirname, '../../src/app/useSchedulerRuntime.ts'),
      'utf8',
    );
    expect(
      /chainNextBeat\(p, Date\.now\(\),\s*useAppStore\.getState\(\)\.activeConvId === p\.convId\)/.test(
        runtime,
      ),
      '在场信号必须由 app 层注入 chainNextBeat——story-service 按设计摸不到 store',
    ).toBe(true);
    const chat = readFileSync(resolve(__dirname, '../../src/features/chat/ChatPage.tsx'), 'utf8');
    expect(chat).toContain('story-choice');
    expect(chat).toContain('applyChoice(');
    expect(chat, '选项条必须以 pendingChoice 为门').toMatch(/story\?\.pendingChoice/);
  });
});
