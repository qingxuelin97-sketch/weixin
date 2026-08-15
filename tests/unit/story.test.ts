import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { repo } from '../../src/db/repo';
import { idbGetAll, idbPut } from '../../src/db/idb';
import {
  validateScript,
  evalExpr,
  parseWhen,
  evaluateTriggers,
  applyVarEffects,
  directiveTextFor,
  effectiveStoryLevel,
  reachableFrom,
  hasEscapelessCycle,
  type Script,
} from '../../src/ai/story-script';
import {
  makeSave,
  missingBindings,
  planBeat,
  advance,
  applyTrigger,
  materializeEffects,
  rollbackTo,
  isFromLaterBeat,
  storyTag,
  saveScript,
  getScript,
  getSave,
  putSave,
  judgePrompt,
  parseJudgement,
  type StorySaveRow,
} from '../../src/ai/story-gm';
import type { MemoryFactVM, MomentVM } from '../../src/data/types';

/**
 * Story mode (M-E5).
 *
 * The rollback cascade is the reason this file exists. Every other failure in
 * story mode is contained inside the story; a rollback that restores the cursor
 * but leaves a story-written memory behind lets a character remember a future
 * that no longer happens — and that contamination escapes into ordinary chat
 * and cannot be undone by playing on.
 */

const T0 = 1_755_400_000_000;

const SCRIPT: Script = {
  scriptId: 'demo',
  title: '雨夜来客',
  nsfwLevel: 0,
  cast: [
    { charId: 'host', role: '房东', secret: '知道地下室的门锁坏了' },
    { charId: 'guest', role: '访客' },
  ],
  vars: { trust: 0, knows: false },
  entry: 'n1',
  nodes: [
    {
      id: 'n1',
      goal: '让访客进屋，建立初步信任',
      directives: [
        { charId: 'host', instruction: '客气但保持距离', forbid: '不要提地下室' },
        { charId: 'guest', instruction: '解释你为什么冒雨过来' },
      ],
      triggers: [{ when: 'expr:vars.trust >= 3', to: 'n2', effects: { vars: { knows: true } } }],
      timeout: { turns: 8, to: 'end_cold' },
      onEnter: { narrate: '雨声敲在窗上。' },
    },
    {
      id: 'n2',
      goal: '揭开地下室的事',
      directives: [{ charId: 'host', instruction: '松口，说出地下室', reveal: '门锁坏了' }],
      triggers: [{ when: 'llm:访客表现出害怕', to: 'end_warm' }],
      timeout: { turns: 6, to: 'end_warm' },
      nsfwLevel: 1,
      sfwAlt: '这一段点到为止。',
    },
    { id: 'end_warm', goal: '收束', directives: [], triggers: [], ending: true },
    { id: 'end_cold', goal: '不欢而散', directives: [], triggers: [], ending: true },
  ],
};

const save = (over: Partial<StorySaveRow> = {}): StorySaveRow => ({
  ...makeSave({
    script: SCRIPT,
    convId: 'c1',
    bindings: { host: 'ai_lin', guest: 'ai_ada' },
    globalTier: 'off',
    now: T0,
  }),
  ...over,
});

/* ==================== validation ==================== */

describe('script validation', () => {
  it('accepts a well-formed script', () => {
    expect(validateScript(SCRIPT).ok).toBe(true);
  });

  it('rejects an entry that does not exist', () => {
    const r = validateScript({ ...SCRIPT, entry: 'nowhere' });
    expect(r.issues.map((i) => i.code)).toContain('entry_missing');
  });

  it('rejects edges to invented node ids — the classic LLM output', () => {
    const bad = {
      ...SCRIPT,
      nodes: SCRIPT.nodes.map((n) =>
        n.id === 'n1' ? { ...n, triggers: [{ when: 'expr:true', to: 'n_imagined' }] } : n,
      ),
    };
    expect(validateScript(bad).issues.map((i) => i.code)).toContain('dangling_edge');
  });

  it('rejects a beat nothing can reach', () => {
    const bad = {
      ...SCRIPT,
      nodes: [...SCRIPT.nodes, { id: 'orphan', goal: 'x', directives: [], triggers: [], ending: true }],
    };
    expect(validateScript(bad).issues.map((i) => i.code)).toContain('unreachable');
  });

  it('rejects a non-ending node with no way out', () => {
    const bad = {
      ...SCRIPT,
      nodes: SCRIPT.nodes.map((n) => (n.id === 'n2' ? { ...n, triggers: [], timeout: undefined } : n)),
    };
    expect(validateScript(bad).issues.map((i) => i.code)).toContain('dead_end');
  });

  it('rejects a script with no ending at all', () => {
    const bad = { ...SCRIPT, nodes: SCRIPT.nodes.map((n) => ({ ...n, ending: false })) };
    expect(validateScript(bad).issues.map((i) => i.code)).toContain('no_ending');
  });

  it('rejects a directive aimed at somebody not in the cast', () => {
    const bad = {
      ...SCRIPT,
      nodes: SCRIPT.nodes.map((n) =>
        n.id === 'n1' ? { ...n, directives: [{ charId: 'ghost', instruction: 'x' }] } : n,
      ),
    };
    expect(validateScript(bad).issues.map((i) => i.code)).toContain('unknown_char');
  });

  it('refuses to let the entry be an adult beat', () => {
    // Otherwise the whole gating apparatus is decorative: you would arrive
    // at explicit content without passing a single condition.
    const bad = {
      ...SCRIPT,
      nodes: SCRIPT.nodes.map((n) => (n.id === 'n1' ? { ...n, nsfwLevel: 2 } : n)),
    };
    expect(validateScript(bad).issues.map((i) => i.code)).toContain('nsfw_entry');
  });

  it('reports schema violations rather than throwing', () => {
    expect(validateScript({ nonsense: true }).ok).toBe(false);
    expect(validateScript(null).ok).toBe(false);
    expect(validateScript('a string').ok).toBe(false);
  });

  it('computes reachability and spots a graph that cannot finish', () => {
    expect(reachableFrom(SCRIPT).size).toBe(4);
    expect(hasEscapelessCycle(SCRIPT)).toBe(false);
    const trap: Script = {
      ...SCRIPT,
      nodes: [
        { id: 'a', goal: 'x', directives: [], triggers: [{ when: 'expr:true', to: 'b' }] },
        { id: 'b', goal: 'x', directives: [], triggers: [{ when: 'expr:true', to: 'a' }] },
        { id: 'z', goal: 'x', directives: [], triggers: [], ending: true },
      ],
      entry: 'a',
    };
    expect(hasEscapelessCycle(trap)).toBe(true);
  });

  it('REJECTS a script whose cycle has no exit, naming the trapped nodes', () => {
    // The regression this pins (M-G0): `hasEscapelessCycle` shipped in M-E5
    // with a `cycle` issue code reserved for it — and `validateScript` never
    // called it. Every local check passes on the graph below (both nodes have
    // outgoing edges, so `dead_end` is silent; an ending exists, so `no_ending`
    // is silent), which meant a GENERATED script could strand the player in a
    // two-node loop and still be accepted and stored.
    //
    // Delete the `strandedNodes` loop in validateScript and this turns red.
    const trap: Script = {
      ...SCRIPT,
      nodes: [
        { id: 'a', goal: 'x', directives: [], triggers: [{ when: 'expr:true', to: 'b' }] },
        { id: 'b', goal: 'x', directives: [], triggers: [{ when: 'expr:true', to: 'a' }] },
        // Reachable ending, so `no_ending` cannot be what fails it.
        { id: 'z', goal: 'x', directives: [], triggers: [], ending: true },
        { id: 'a0', goal: 'x', directives: [], triggers: [
          { when: 'expr:true', to: 'a' },
          { when: 'expr:false', to: 'z' },
        ] },
      ],
      entry: 'a0',
    };
    const res = validateScript(trap);
    expect(res.ok).toBe(false);
    const cycles = res.issues.filter((i) => i.code === 'cycle');
    expect(cycles.map((i) => i.nodeId).sort()).toEqual(['a', 'b']);
    // The message has to be actionable: the self-repair loop feeds it back to
    // the model verbatim, and "there is a cycle somewhere" fixes nothing.
    expect(cycles[0].message).toContain('a');
  });

  it('accepts a cycle that does have an exit', () => {
    // Loops are legitimate ("keep talking until the variable moves"). Only
    // exit-less ones are the bug — over-rejecting would break real scripts.
    const loop: Script = {
      ...SCRIPT,
      nodes: [
        { id: 'a', goal: 'x', directives: [], triggers: [
          { when: 'expr:vars.trust < 2', to: 'b' },
          { when: 'expr:vars.trust >= 2', to: 'z' },
        ] },
        { id: 'b', goal: 'x', directives: [], triggers: [{ when: 'expr:true', to: 'a' }] },
        { id: 'z', goal: 'x', directives: [], triggers: [], ending: true },
      ],
      entry: 'a',
    };
    expect(validateScript(loop).issues.filter((i) => i.code === 'cycle')).toHaveLength(0);
  });
});

/* ==================== expressions ==================== */

describe('trigger expressions', () => {
  it('parses the two tracks and rejects an unprefixed condition', () => {
    expect(parseWhen('expr:vars.x > 1').kind).toBe('expr');
    expect(parseWhen('llm:她看起来在撒谎').kind).toBe('llm');
    expect(parseWhen('vars.x > 1').kind).toBe('invalid');
  });

  it('evaluates comparisons, booleans and parentheses', () => {
    const vars = { trust: 3, mood: 'calm', knows: true };
    expect(evalExpr('vars.trust >= 3', vars)).toBe(true);
    expect(evalExpr('vars.trust > 3', vars)).toBe(false);
    expect(evalExpr('vars.mood == "calm"', vars)).toBe(true);
    expect(evalExpr('vars.mood != "angry"', vars)).toBe(true);
    expect(evalExpr('vars.knows', vars)).toBe(true);
    expect(evalExpr('!vars.knows', vars)).toBe(false);
    expect(evalExpr('vars.trust >= 3 && vars.knows', vars)).toBe(true);
    expect(evalExpr('vars.trust > 9 || vars.knows', vars)).toBe(true);
    expect(evalExpr('(vars.trust > 9 || vars.knows) && vars.mood == "calm"', vars)).toBe(true);
  });

  it('treats an unset variable as 0/false so old saves keep evaluating', () => {
    expect(evalExpr('vars.never_set > 0', {})).toBe(false);
    expect(evalExpr('vars.never_set == 0', {})).toBe(true);
  });

  it('never fires on a malformed condition', () => {
    // Taking a branch on a broken expression would send the story somewhere
    // the author never wrote — worse than simply not advancing.
    expect(evalExpr('vars.x >>> ', { x: 5 })).toBe(false);
    expect(evalExpr('', {})).toBe(false);
    expect(evalExpr('(vars.x > 1', { x: 5 })).toBe(false);
  });

  it('executes nothing — scripts are untrusted input', () => {
    const hit = { fired: false };
    (globalThis as unknown as { __storyPwn: () => void }).__storyPwn = () => {
      hit.fired = true;
    };
    expect(evalExpr('globalThis.__storyPwn()', {})).toBe(false);
    expect(evalExpr('vars.x; __storyPwn()', { x: 1 })).toBe(false);
    expect(hit.fired).toBe(false);
  });

  it('prefers the local track and leaves llm conditions pending', () => {
    const n2 = SCRIPT.nodes[1];
    expect(evaluateTriggers(n2, {}).pending).toHaveLength(1);
    const n1 = SCRIPT.nodes[0];
    expect(evaluateTriggers(n1, { trust: 5 }).fired?.to).toBe('n2');
    expect(evaluateTriggers(n1, { trust: 0 }).fired).toBeUndefined();
  });

  it('applies variable effects immutably', () => {
    const vars = { trust: 1 };
    const next = applyVarEffects(vars, { vars: { trust: 5, seen: true } });
    expect(next).toEqual({ trust: 5, seen: true });
    expect(vars).toEqual({ trust: 1 });
  });
});

/* ==================== beats ==================== */

describe('beats', () => {
  it('gives each character only their own directive and secret', () => {
    const plan = planBeat(SCRIPT, save())!;
    // Handing an actor the whole graph is how a mystery gets spoiled in line 2.
    expect(plan.directives.ai_lin).toContain('地下室的门锁坏了');
    expect(plan.directives.ai_ada).not.toContain('地下室');
    expect(plan.directives.ai_ada).not.toContain('房东');
  });

  it('substitutes the SFW alternative above the run’s tier', () => {
    const sfwRun = save({ nodeId: 'n2', effectiveLevel: 0 });
    expect(planBeat(SCRIPT, sfwRun)!.directives.ai_lin).toContain('点到为止');
    const openRun = save({ nodeId: 'n2', effectiveLevel: 1 });
    expect(planBeat(SCRIPT, openRun)!.directives.ai_lin).toContain('松口');
  });

  it('locks the tier at start rather than re-reading the global setting', () => {
    // Lowering the global setting mid-run must not rewrite a story in progress,
    // and raising it must not silently escalate one started at a lower tier.
    const run = makeSave({
      script: { ...SCRIPT, nsfwLevel: 2 },
      convId: 'c',
      bindings: {},
      globalTier: 'ambiguous',
      now: T0,
    });
    expect(run.effectiveLevel).toBe(1);
    expect(effectiveStoryLevel('full', { ...SCRIPT, nsfwLevel: 1 })).toBe(1);
    expect(effectiveStoryLevel('off', { ...SCRIPT, nsfwLevel: 2 })).toBe(0);
  });

  it('refuses to start with an unbound cast member', () => {
    expect(missingBindings(SCRIPT, { host: 'ai_lin' })).toEqual(['guest']);
    expect(missingBindings(SCRIPT, { host: 'a', guest: 'b' })).toEqual([]);
  });

  it('advances when a local condition holds', () => {
    const r = advance(SCRIPT, save({ vars: { trust: 5 } }), T0);
    expect(r.moved).toBe(true);
    expect(r.save.nodeId).toBe('n2');
    expect(r.save.vars.knows).toBe(true);
    expect(r.save.seq).toBe(1);
  });

  it('counts turns and finally takes the timeout exit', () => {
    let s = save();
    for (let i = 0; i < 7; i++) s = advance(SCRIPT, s, T0).save;
    expect(s.nodeId).toBe('n1');
    expect(s.turnsInNode).toBe(7);
    // Without the forced exit a beat whose condition never comes true traps the
    // run silently: the story just stops and nothing says why.
    const out = advance(SCRIPT, s, T0);
    expect(out.save.nodeId).toBe('end_cold');
  });

  it('resets the turn counter on every move', () => {
    const moved = advance(SCRIPT, save({ vars: { trust: 5 }, turnsInNode: 6 }), T0);
    expect(moved.save.turnsInNode).toBe(0);
  });

  it('bounds the snapshot history', () => {
    let s = save();
    for (let i = 0; i < 80; i++) {
      s = applyTrigger(s, { when: 'expr:true', to: 'n1' }, T0 + i).save;
    }
    expect(s.history.length).toBeLessThanOrEqual(50);
  });
});

/* ==================== rollback ==================== */

describe('rollback cascades into memory and Moments', () => {
  beforeEach(async () => {
    for (const f of await idbGetAll<MemoryFactVM>('memory_facts')) await repo.deleteMemory(f.id);
    for (const m of await idbGetAll<MomentVM>('moments')) await idbPut('moments', { ...m, id: m.id });
  });

  async function runThreeBeats() {
    let s = save();
    const deps = {
      putMemory: (f: MemoryFactVM) => repo.putMemory(f),
      putMoment: (m: MomentVM) => repo.putMoment(m),
    };
    for (let i = 1; i <= 3; i++) {
      const stepped = applyTrigger(
        s,
        {
          when: 'expr:true',
          to: 'n1',
          effects: {
            memWrite: [{ charId: 'host', fact: `第${i}幕发生的事` }],
            moment: { authorId: 'host', text: `第${i}幕的朋友圈` },
          },
        },
        T0 + i,
      );
      s = stepped.save;
      await materializeEffects(s, stepped.effects, s.bindings, T0 + i, deps);
    }
    return s;
  }

  it('retracts everything the undone beats wrote', async () => {
    const s = await runThreeBeats();
    expect((await repo.getMemory('ai_lin')).filter((f) => f.storyTag)).toHaveLength(3);
    expect((await repo.getMoments()).filter((m) => m.storyTag)).toHaveLength(3);

    const result = await rollbackTo(s, 1, T0 + 100);

    // Beats 2 and 3 are gone from BOTH surfaces. Missing either one leaves a
    // character remembering a future that no longer happens.
    expect(result.memoryRemoved).toHaveLength(2);
    expect(result.momentsRemoved).toHaveLength(2);
    const facts = (await repo.getMemory('ai_lin')).filter((f) => f.storyTag);
    expect(facts).toHaveLength(1);
    expect(facts[0].fact).toBe('第1幕发生的事');
    expect((await repo.getMoments()).filter((m) => m.storyTag)).toHaveLength(1);
  });

  it('restores the cursor and the variables together', async () => {
    const s = await runThreeBeats();
    const result = await rollbackTo(s, 1, T0 + 100);
    expect(result.save.seq).toBeLessThanOrEqual(1);
    expect(result.save.turnsInNode).toBe(0);
  });

  it('never touches anything the user actually said', async () => {
    const s = await runThreeBeats();
    await repo.putMemory({
      id: 'user_fact',
      subjectId: 'ai_lin',
      fact: '用户喜欢喝美式',
      importance: 3,
      sensitivity: 'normal',
      evidenceMsgIds: [1],
      status: 'confirmed',
      isPinned: false,
      createdAt: T0,
    });
    await rollbackTo(s, 0, T0 + 100);
    const survived = await repo.getMemory('ai_lin');
    expect(survived.map((f) => f.id)).toContain('user_fact');
  });

  it('never touches ANOTHER script’s rows', async () => {
    const s = await runThreeBeats();
    await repo.putMemory({
      id: 'other_story',
      subjectId: 'ai_lin',
      fact: '另一个剧本写的',
      importance: 3,
      sensitivity: 'normal',
      evidenceMsgIds: [],
      status: 'confirmed',
      isPinned: false,
      createdAt: T0,
      storyTag: storyTag('another_script', 99),
    });
    await rollbackTo(s, 0, T0 + 100);
    expect((await repo.getMemory('ai_lin')).map((f) => f.id)).toContain('other_story');
  });

  /**
   * The deliberate-omission case the plan calls for. `isFromLaterBeat` is the
   * single predicate every surface's sweep runs through — so an implementation
   * that "forgot" one surface would simply not call it, and this test pins the
   * predicate itself so a sweep cannot be silently narrowed instead.
   */
  it('the tag predicate catches every later beat, on any surface', () => {
    expect(isFromLaterBeat(storyTag('demo', 3), 'demo', 1)).toBe(true);
    expect(isFromLaterBeat(storyTag('demo', 1), 'demo', 1)).toBe(false);
    expect(isFromLaterBeat(storyTag('demo', 0), 'demo', 1)).toBe(false);
    expect(isFromLaterBeat(storyTag('other', 9), 'demo', 1)).toBe(false);
    // An untagged row is the failure mode itself: a story-written row that
    // cannot be found is indistinguishable from real history forever.
    expect(isFromLaterBeat(undefined, 'demo', 0)).toBe(false);
    expect(isFromLaterBeat('malformed', 'demo', 0)).toBe(false);
  });

  it('every materialized row carries a findable tag — no silent orphans', async () => {
    const s = await runThreeBeats();
    const facts = (await repo.getMemory('ai_lin')).filter((f) => f.source === 'story');
    expect(facts).toHaveLength(3);
    for (const f of facts) {
      expect(f.storyTag, `story fact ${f.id} 没有 tag，回档永远删不掉它`).toBeTruthy();
      expect(f.storySaveId).toBe(s.id);
    }
    for (const m of (await repo.getMoments()).filter((x) => x.storyTag)) {
      // Since M-I7 the tag namespace is the RUN (save id), not the script id —
      // two 周目 of the same script must never find each other's rows.
      expect(isFromLaterBeat(m.storyTag, s.id, -1)).toBe(true);
    }
  });
});

/* ==================== storage ==================== */

describe('script storage', () => {
  it('round-trips a valid script', async () => {
    expect(await saveScript(SCRIPT, 'builtin', T0)).toEqual({ ok: true, id: 'demo' });
    expect((await getScript('demo'))?.title).toBe('雨夜来客');
  });

  it('refuses to store an invalid one, with reasons', async () => {
    const r = await saveScript({ ...SCRIPT, scriptId: 'bad', entry: 'nope' }, 'import', T0);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.join()).toContain('entry');
    expect(await getScript('bad')).toBeNull();
  });
});

describe('directive text respects the tier', () => {
  it('uses the real instruction at or below the level, sfwAlt above it', () => {
    const node = SCRIPT.nodes[1];
    const d = node.directives[0];
    expect(directiveTextFor(node, 1, d)).toContain('松口');
    expect(directiveTextFor(node, 0, d)).toBe('这一段点到为止。');
  });

  it('falls back to a safe line when a node forgot its sfwAlt', () => {
    const node = { ...SCRIPT.nodes[1], sfwAlt: undefined };
    expect(directiveTextFor(node, 0, node.directives[0])).toContain('留白');
  });
});

describe('the built-in scripts are the working reference they claim to be', () => {
  it('every shipped script validates', async () => {
    const { BUILTIN_SCRIPTS } = await import('../../src/ai/story-builtin');
    expect(BUILTIN_SCRIPTS.length).toBeGreaterThan(0);
    for (const s of BUILTIN_SCRIPTS) {
      const r = validateScript(s);
      expect(r.issues.map((i) => i.message).join(' | '), `${s.title} 不合法`).toBe('');
      expect(r.ok).toBe(true);
    }
  });

  it('every shipped script can actually finish, from the entry', async () => {
    const { BUILTIN_SCRIPTS } = await import('../../src/ai/story-builtin');
    for (const s of BUILTIN_SCRIPTS) {
      expect(hasEscapelessCycle(s), `${s.title} 有走不到结局的节点`).toBe(false);
    }
  });

  it('ships at SFW level so the examples are playable at the default setting', async () => {
    const { BUILTIN_SCRIPTS } = await import('../../src/ai/story-builtin');
    for (const s of BUILTIN_SCRIPTS) expect(s.nsfwLevel).toBe(0);
  });

  it('every expr: trigger in a shipped script parses', async () => {
    const { BUILTIN_SCRIPTS } = await import('../../src/ai/story-builtin');
    for (const s of BUILTIN_SCRIPTS) {
      for (const n of s.nodes) {
        for (const t of n.triggers) {
          const w = parseWhen(t.when);
          // 'invalid' is silently dropped at runtime, so a typo in a shipped
          // script would be a branch that simply never fires.
          expect(w.kind, `${s.title}/${n.id}: ${t.when}`).not.toBe('invalid');
        }
      }
    }
  });
});

describe('one-line generation is ask → CHECK → repair', () => {
  it('extracts JSON even when the model wraps it in prose or fences', async () => {
    const { extractJson } = await import('../../src/ai/story-generate');
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('好的，这是剧本：\n{"a":1}\n希望你喜欢')).toEqual({ a: 1 });
    expect(extractJson('完全不是 JSON')).toBeNull();
  });

  it('accepts a valid script on the first attempt', async () => {
    const { generateScript } = await import('../../src/ai/story-generate');
    let call = 0;
    const r = await generateScript(
      '一个雨夜的故事',
      {
        complete: async () => {
          call++;
          return call === 1 ? '大纲：…' : JSON.stringify(SCRIPT);
        },
      },
      T0,
    );
    expect(r.ok).toBe(true);
    expect(call).toBe(2); // outline + json, no repair
  });

  it('feeds the model its OWN specific failures and accepts the repair', async () => {
    const { generateScript } = await import('../../src/ai/story-generate');
    const prompts: string[] = [];
    let call = 0;
    const r = await generateScript(
      'x',
      {
        complete: async (messages) => {
          call++;
          prompts.push(messages.at(-1)!.content);
          if (call === 1) return '大纲';
          // First graph points its entry at a node that does not exist — the
          // single most common way a generated script is silently unplayable.
          if (call === 2) return JSON.stringify({ ...SCRIPT, entry: 'ghost' });
          return JSON.stringify(SCRIPT);
        },
      },
      T0,
    );
    expect(r.ok).toBe(true);
    expect(r.attempts).toHaveLength(1);
    expect(prompts.at(-1)).toContain('entry');
  });

  it('gives up after the bounded repair budget rather than storing a broken script', async () => {
    const { generateScript, MAX_REPAIRS } = await import('../../src/ai/story-generate');
    let call = 0;
    const r = await generateScript(
      'x',
      {
        complete: async () => {
          call++;
          return call === 1 ? '大纲' : JSON.stringify({ ...SCRIPT, entry: 'ghost' });
        },
      },
      T0,
    );
    expect(r.ok).toBe(false);
    expect(r.attempts).toHaveLength(MAX_REPAIRS + 1);
    // A story that cannot run is not a story; saying so here beats stranding
    // the user three scenes in.
    expect(r.error).toContain('entry');
  });

  it('reports a provider failure instead of hanging or half-saving', async () => {
    const { generateScript } = await import('../../src/ai/story-generate');
    const r = await generateScript(
      'x',
      {
        complete: async () => {
          throw new Error('network down');
        },
      },
      T0,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain('network down');
  });

  it('gives every generated script a unique id, whatever the model called it', async () => {
    const { generateScript } = await import('../../src/ai/story-generate');
    const gen = (now: number) =>
      generateScript(
        'x',
        {
          complete: async (m) =>
            m.at(-1)!.content === 'x' ? '大纲' : JSON.stringify({ ...SCRIPT, scriptId: 'story_1' }),
        },
        now,
      );
    const a = await gen(T0);
    const b = await gen(T0 + 1);
    // Two generated scripts both calling themselves "story_1" would overwrite
    // each other in a store keyed by id.
    expect(a.script!.scriptId).not.toBe(b.script!.scriptId);
  });

  it('only escalates the tier for an explicitly adult premise', async () => {
    const { tierForPremise } = await import('../../src/ai/story-generate');
    expect(tierForPremise('写个悬疑故事', 'full')).toBe('off');
    expect(tierForPremise('写个成人向的故事', 'full')).toBe('full');
    // The global setting is still the ceiling — a premise cannot raise it.
    expect(tierForPremise('写个成人向的故事', 'off')).toBe('off');
  });
});

/* ==================== the llm: trigger track ==================== */

/**
 * `specs/story-gm.md` specifies two trigger tracks. `evaluateTriggers` has
 * always returned the `llm:` ones in `pending`, and `advance` has always passed
 * that array through — and until M-G0 NOTHING read it. Node `n2` above hangs
 * its only non-timeout exit on `llm:访客表现出害怕`, so every run of this script
 * reached n2 and then sat there until the 6-turn timeout, always taking the
 * same branch. The "dual track" was single-track.
 */
describe('soft conditions are actually judged', () => {
  const n2 = SCRIPT.nodes.find((n) => n.id === 'n2')!;

  it('builds a prompt that names each pending condition', () => {
    const p = judgePrompt('揭开地下室的事', 'lin: 你还好吗', n2.triggers);
    expect(p).toContain('访客表现出害怕');
    // The condition must arrive WITHOUT its `llm:` prefix — that prefix is our
    // routing syntax, not something to ask a model about.
    expect(p).not.toContain('llm:');
    expect(p).toContain('揭开地下室的事');
  });

  it('reads a verdict, and treats anything unexpected as “not yet”', () => {
    expect(parseJudgement('1', n2.triggers)).toBe(n2.triggers[0]);
    expect(parseJudgement('嗯，我认为是 1', n2.triggers)).toBe(n2.triggers[0]);
    // 0 is the model's own "none of these".
    expect(parseJudgement('0', n2.triggers)).toBeUndefined();
    // Out of range, empty, and prose all mean the same thing. Advancing on a
    // misparse skips a beat the author wrote and can strand the vars later
    // nodes read; waiting just costs a turn and then hits the node's timeout,
    // which is the exit the author already designed.
    expect(parseJudgement('7', n2.triggers)).toBeUndefined();
    expect(parseJudgement('', n2.triggers)).toBeUndefined();
    expect(parseJudgement('说不好', n2.triggers)).toBeUndefined();
  });

  it('moves the run when the judge says a soft condition came true', async () => {
    const { runStoryBeat } = await import('../../src/ai/story-service');
    await saveScript(SCRIPT, 'builtin', T0);
    await putSave(save({ id: 'save_soft', nodeId: 'n2' }));
    let asked = 0;
    await runStoryBeat('save_soft', {
      appendMessage: async () => undefined,
      playBeat: async () => {},
      judgeTriggers: async (_c, _g, pending) => {
        asked++;
        return pending[0];
      },
      contactById: () => undefined,
      now: () => T0,
    });
    expect(asked).toBe(1);
    expect((await getSave('save_soft'))!.nodeId).toBe('end_warm');
  });

  it('does not spend a judgement when a local expr already fired', async () => {
    const { runStoryBeat } = await import('../../src/ai/story-service');
    await saveScript(SCRIPT, 'builtin', T0);
    // n1's exit is `expr:vars.trust >= 3` — deterministic and already true.
    await putSave(save({ id: 'save_expr', nodeId: 'n1', vars: { trust: 5, knows: false } }));
    let asked = 0;
    await runStoryBeat('save_expr', {
      appendMessage: async () => undefined,
      playBeat: async () => {},
      judgeTriggers: async () => {
        asked++;
        return undefined;
      },
      contactById: () => undefined,
      now: () => T0,
    });
    // Local first, by design: a deterministic condition is never second-guessed
    // by a model, and the common beat stays free.
    expect(asked).toBe(0);
    expect((await getSave('save_expr'))!.nodeId).toBe('n2');
  });

  it('survives a judge that throws, falling back to the authored timeout', async () => {
    const { runStoryBeat } = await import('../../src/ai/story-service');
    await saveScript(SCRIPT, 'builtin', T0);
    await putSave(save({ id: 'save_judgefail', nodeId: 'n2' }));
    const r = await runStoryBeat('save_judgefail', {
      appendMessage: async () => undefined,
      playBeat: async () => {},
      judgeTriggers: async () => {
        throw new Error('429');
      },
      contactById: () => undefined,
      now: () => T0,
    });
    // The beat completes; the run just stays put and counts toward `timeout`.
    expect(r.finished).toBe(false);
    const s = await getSave('save_judgefail')!;
    expect(s!.nodeId).toBe('n2');
    expect(s!.turnsInNode).toBe(1);
  });

  it('still runs a script with no judge hook at all', async () => {
    const { runStoryBeat } = await import('../../src/ai/story-service');
    await saveScript(SCRIPT, 'builtin', T0);
    await putSave(save({ id: 'save_nojudge', nodeId: 'n2' }));
    await runStoryBeat('save_nojudge', {
      appendMessage: async () => undefined,
      playBeat: async () => {},
      contactById: () => undefined,
      now: () => T0,
    });
    expect((await getSave('save_nojudge'))!.nodeId).toBe('n2');
  });
});

/* ==================== the beat chain ==================== */

/**
 * The bug this section exists for (M-G0): `story_tick` was registered with a
 * plain `registerHandler` while the comment above it claimed it was chained,
 * and `runStoryBeat` queued its own successor on its LAST line — after the
 * group generation that can time out. The scheduler marks a row done BEFORE
 * running its handler and drops handler errors without retrying, so a single
 * LLM failure inside `playBeat` ended the story permanently and silently.
 */
describe('a failed beat pauses the story instead of ending it', () => {
  const SAVE_ID = 'save_chain';

  async function pendingTicks(): Promise<string[]> {
    const rows = await idbGetAll<{ id: string; kind: string; status: string }>('scheduled_actions');
    return rows.filter((r) => r.kind === 'story_tick' && r.status === 'pending').map((r) => r.id).sort();
  }

  beforeEach(async () => {
    for (const r of await idbGetAll<{ id: string }>('scheduled_actions')) {
      await idbPut('scheduled_actions', { ...r, status: 'done' });
    }
    await saveScript(SCRIPT, 'builtin', T0);
    await putSave(save({ id: SAVE_ID }));
  });

  it('queues the successor BEFORE the work that can fail', async () => {
    const { chainNextBeat } = await import('../../src/ai/story-service');
    await chainNextBeat({ saveId: SAVE_ID, convId: 'c1', tick: 1 }, T0);
    // Chaining happens without the beat having run at all — that is the point.
    expect(await pendingTicks()).toEqual([`story_${SAVE_ID}_t2`]);
  });

  it('keeps the run alive across a throwing beat, then pauses after MAX_STALLS', async () => {
    const { chainNextBeat, runStoryBeat, MAX_STALLS, STALL_NOTICE } = await import(
      '../../src/ai/story-service'
    );
    const appended: string[] = [];
    const hooks = {
      appendMessage: async (m: { content: string }) => {
        appended.push(m.content);
        return undefined;
      },
      playBeat: async () => {
        throw new Error('LLM 超时');
      },
      contactById: () => undefined,
      now: () => T0,
    };

    for (let i = 1; i <= MAX_STALLS; i++) {
      // The scheduler always chains first, then works.
      await chainNextBeat({ saveId: SAVE_ID, convId: 'c1', tick: i }, T0);
      await expect(runStoryBeat(SAVE_ID, hooks)).rejects.toThrow('LLM 超时');
      const s = await getSave(SAVE_ID);
      expect(s!.stalls).toBe(i);
      // Still active every time — a failed beat is a retry, not a death.
      expect(s!.isActive).toBe(true);
    }

    // Having struck out, the run pauses itself rather than burning one LLM
    // call every STORY_TICK_MS against a provider that is down.
    const stalled = await getSave(SAVE_ID);
    expect(typeof stalled!.stalledAt).toBe('number');
    expect(appended).toContain(STALL_NOTICE);
    // ...and the pause is what actually stops the chain.
    const before = await pendingTicks();
    await chainNextBeat({ saveId: SAVE_ID, convId: 'c1', tick: MAX_STALLS + 1 }, T0);
    expect(await pendingTicks()).toEqual(before);
  });

  it('narrates a beat once even when it is retried', async () => {
    const { runStoryBeat } = await import('../../src/ai/story-service');
    const appended: string[] = [];
    const hooks = {
      appendMessage: async (m: { content: string }) => {
        appended.push(m.content);
        return undefined;
      },
      playBeat: async () => {
        throw new Error('LLM 超时');
      },
      contactById: () => undefined,
      now: () => T0,
    };
    await expect(runStoryBeat(SAVE_ID, hooks)).rejects.toThrow();
    const afterFirst = appended.length;
    await expect(runStoryBeat(SAVE_ID, hooks)).rejects.toThrow();
    // The retry re-enters with the same unadvanced save; without the
    // `stallsOf(save) === 0` gate it would reprint the scene-setting line.
    expect(appended.length).toBe(afterFirst);
  });

  it('clears the strike count once a beat completes', async () => {
    const { runStoryBeat } = await import('../../src/ai/story-service');
    await putSave(save({ id: SAVE_ID, stalls: 2 }));
    await runStoryBeat(SAVE_ID, {
      appendMessage: async () => undefined,
      playBeat: async () => {},
      contactById: () => undefined,
      now: () => T0,
    });
    // MAX_STALLS counts CONSECUTIVE failures: one bad night mid-story must not
    // carry over and pause the run three nights later.
    expect((await getSave(SAVE_ID))!.stalls).toBe(0);
  });
});
