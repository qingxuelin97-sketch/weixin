import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { repo } from '../../src/db/repo';
import { idbGetAll, idbDelete } from '../../src/db/idb';
import { describeWhen, type Script, type Trigger } from '../../src/ai/story-script';
import { rollbackConfirmBody, fmtDuration } from '../../src/features/story/StoryRunPage';
import {
  makeSave,
  planBeat,
  planRollback,
  collectRunTraces,
  saveScript,
  applyTrigger,
  advance,
  materializeEffects,
  rollbackTo,
  restoreSlot,
  writeSlot,
  dropSlot,
  canRestoreSlot,
  storyTag,
  seqOfTag,
  isFromLaterBeat,
  isFromRunLaterBeat,
  runOf,
  clearStall,
  stallsOf,
  isStalled,
  endRun,
  putSave,
  getSave,
  MAX_SLOTS,
  type StorySaveRow,
} from '../../src/ai/story-gm';
import {
  suggestBindings,
  validateBindings,
  assignRole,
  nextRunNumber,
  runsOf,
  runStateLabel,
  galleryFor,
  gallerySummary,
  roleNameOf,
} from '../../src/ai/story-runs';
import { layoutScript, visitedNodeIds, NODE_W, PAD } from '../../src/ai/story-layout';
import {
  beginStoryStamp,
  endStoryStamp,
  storyStampFor,
  applyStoryStamp,
  resetStoryStamps,
} from '../../src/ai/story-stamp';
import { resumeRun, runStoryBeat, type StoryHooks } from '../../src/ai/story-service';
import type { MemoryFactVM, MomentVM, MessageVM } from '../../src/data/types';

/**
 * Story mode V3 (M-I7).
 *
 * The plan names two red tests and this file carries both:
 *  - 回滚后种子重放等于原分支 — after a rollback, replaying the same trigger
 *    sequence reproduces the original branch byte-for-byte (node, vars, seq,
 *    and the side-effect tags), because the walk is deterministic and the
 *    cascade actually restored the earlier state;
 *  - 打乱 persona 数组仍正确绑定 — casting is an explicit map, and every
 *    helper under it is order-independent, so shuffling the group's member
 *    array can never recast the play (the exact bug the old start button had).
 *
 * Plus the three I7 mechanisms with real failure modes: run-namespaced tags
 * (rolling back 周目 2 must not delete 周目 1's rows), transcript trimming by
 * watermark (rowid holes, timestamps untouched), and the storySeq column
 * finally gaining a writer.
 */

const T0 = 1_756_000_000_000;

const SCRIPT: Script = {
  scriptId: 'v3demo',
  title: '三岔口',
  nsfwLevel: 0,
  cast: [
    { charId: 'a', role: '侦探', secret: '你早就认出了他' },
    { charId: 'b', role: '嫌疑人' },
    { charId: 'c', role: '旁观者' },
  ],
  vars: { trust: 0, exposed: false },
  entry: 'n1',
  nodes: [
    {
      id: 'n1',
      goal: '试探',
      onEnter: { narrate: '茶馆里人声嘈杂。' },
      directives: [{ charId: 'a', instruction: '旁敲侧击' }],
      triggers: [
        { when: 'expr:vars.trust >= 2', to: 'n2', effects: { vars: { exposed: true } } },
        { when: 'expr:vars.trust <= -2', to: 'end_cold' },
      ],
      timeout: { turns: 6, to: 'end_cold' },
    },
    {
      id: 'n2',
      goal: '摊牌',
      directives: [{ charId: 'b', instruction: '要么认要么跑' }],
      triggers: [
        { when: 'expr:vars.exposed == true', to: 'end_warm' },
        { when: 'expr:vars.trust >= 99', to: 'n1' },
      ],
      timeout: { turns: 6, to: 'end_warm' },
    },
    { id: 'end_warm', goal: '真相大白', directives: [], triggers: [], ending: true },
    { id: 'end_cold', goal: '不了了之', directives: [], triggers: [], ending: true },
  ],
};

const mkSave = (over: Partial<StorySaveRow> = {}): StorySaveRow => ({
  ...makeSave({
    script: SCRIPT,
    convId: 'g_story',
    bindings: { a: 'ai_x', b: 'ai_y', c: 'ai_z' },
    globalTier: 'off',
    now: T0,
    run: 1,
  }),
  ...over,
});

const effectDeps = {
  putMemory: (f: MemoryFactVM) => repo.putMemory(f),
  putMoment: (m: MomentVM) => repo.putMoment(m),
};

/** Walk a save through `count` beats, each writing one memory + one moment. */
async function playBeats(s: StorySaveRow, count: number, msgCursor = 0): Promise<StorySaveRow> {
  for (let i = 1; i <= count; i++) {
    const stepped = applyTrigger(
      s,
      {
        when: 'expr:true',
        to: 'n1',
        effects: {
          memWrite: [{ charId: 'a', fact: `${s.id} 第${i}幕` }],
          moment: { authorId: 'a', text: `${s.id} 第${i}幕的朋友圈` },
        },
      },
      T0 + i,
      msgCursor,
    );
    s = stepped.save;
    await materializeEffects(s, stepped.effects, s.bindings, T0 + i, effectDeps);
  }
  return s;
}

async function wipeStores() {
  for (const f of await idbGetAll<MemoryFactVM>('memory_facts')) await idbDelete('memory_facts', f.id);
  for (const m of await idbGetAll<MomentVM>('moments')) await idbDelete('moments', m.id);
  for (const m of await idbGetAll<MessageVM>('messages')) await idbDelete('messages', m.id as number);
}

/* ==================== run namespacing (多周目) ==================== */

describe('side-effect tags are namespaced by RUN, not by script', () => {
  beforeEach(wipeStores);

  it('two 周目 of the same script never find each other’s rows', async () => {
    const run1 = await playBeats(mkSave({ id: 'save_v3demo_run1', run: 1 }), 2);
    const run2 = await playBeats(mkSave({ id: 'save_v3demo_run2', run: 2 }), 2);

    // Rolling 周目 2 all the way back must leave 周目 1 untouched. Under the
    // pre-I7 script-namespaced tags this deleted ALL FOUR rows — the exact
    // cross-run contamination this red test exists to keep dead.
    const r = await rollbackTo(run2, 0, T0 + 100);
    expect(r.memoryRemoved).toHaveLength(2);
    expect(r.momentsRemoved).toHaveLength(2);

    const facts = (await repo.getMemory('ai_x')).filter((f) => f.storyTag);
    expect(facts).toHaveLength(2);
    for (const f of facts) expect(f.storySaveId).toBe(run1.id);
    expect((await repo.getMoments()).filter((m) => m.storyTag)).toHaveLength(2);
  });

  it('the tag helpers agree on the namespace format', () => {
    expect(storyTag('save_x', 3)).toBe('save_x#3');
    expect(seqOfTag('save_x#3')).toBe(3);
    expect(seqOfTag('malformed')).toBeUndefined();
    expect(seqOfTag(undefined)).toBeUndefined();
    expect(isFromLaterBeat('save_x#3', 'save_x', 1)).toBe(true);
    expect(isFromLaterBeat('save_x#3', 'save_y', 1)).toBe(false);
  });

  it('pre-I7 rows (script-tagged, storySaveId set) are still swept — by save id', () => {
    const save = mkSave({ id: 'save_legacy' });
    const legacyRow = { storyTag: storyTag(SCRIPT.scriptId, 5), storySaveId: 'save_legacy' };
    expect(isFromRunLaterBeat(legacyRow, save, 1)).toBe(true);
    expect(isFromRunLaterBeat(legacyRow, save, 5)).toBe(false);
    // Another run's legacy row: same script tag, different save id → untouched.
    const otherRuns = { storyTag: storyTag(SCRIPT.scriptId, 5), storySaveId: 'save_other' };
    expect(isFromRunLaterBeat(otherRuns, save, 1)).toBe(false);
  });

  it('numbers the next 周目 past every existing run, ended ones included', () => {
    const saves = [
      mkSave({ id: 's1', run: 1, isActive: false, endingId: 'end_warm', endedAt: T0 }),
      mkSave({ id: 's2', run: 2, isActive: false }),
      { ...mkSave({ id: 'other' }), scriptId: 'unrelated' },
    ];
    expect(nextRunNumber(saves, 'v3demo')).toBe(3);
    expect(nextRunNumber(saves, 'unrelated')).toBe(2);
    expect(nextRunNumber([], 'v3demo')).toBe(1);
  });

  it('runOf tolerates pre-I7 rows without the field', () => {
    const legacy = mkSave();
    delete (legacy as Partial<StorySaveRow>).run;
    expect(runOf(legacy)).toBe(1);
    expect(runOf(mkSave({ run: 4 }))).toBe(4);
  });
});

/* ==================== casting (显式选角) ==================== */

describe('casting is an explicit map, never array order', () => {
  it('打乱 persona 数组仍正确绑定 — the suggestion is order-independent', () => {
    const members = ['ai_zhao', 'ai_qian', 'ai_sun', 'ai_li'];
    const shuffled = ['ai_sun', 'ai_li', 'ai_zhao', 'ai_qian'];
    const reversed = [...members].reverse();
    const a = suggestBindings(SCRIPT, members);
    const b = suggestBindings(SCRIPT, shuffled);
    const c = suggestBindings(SCRIPT, reversed);
    // The old code bound cast[i] → memberIds[i]: shuffling the roster recast
    // the play. The suggestion must be identical whatever the array order.
    expect(b).toEqual(a);
    expect(c).toEqual(a);
    // …and an explicit binding survives any roster order by construction:
    // planBeat looks up by charId → contactId, never by index.
    expect(Object.keys(a)).toEqual(SCRIPT.cast.map((x) => x.charId));
  });

  it('refuses a binding with a role nobody plays', () => {
    const issues = validateBindings(SCRIPT, { a: 'ai_x', b: 'ai_y' }, ['ai_x', 'ai_y']);
    expect(issues.some((i) => i.code === 'unbound' && i.charId === 'c')).toBe(true);
  });

  it('refuses one actor in two roles — their secrets would meet in one prompt', () => {
    const issues = validateBindings(
      SCRIPT,
      { a: 'ai_x', b: 'ai_x', c: 'ai_z' },
      ['ai_x', 'ai_z'],
    );
    expect(issues.some((i) => i.code === 'duplicate')).toBe(true);
  });

  it('refuses an actor who is not in the group, and a stale role', () => {
    const issues = validateBindings(
      SCRIPT,
      { a: 'ai_x', b: 'ai_y', c: 'ai_z', ghost: 'ai_x' },
      ['ai_x', 'ai_y'],
    );
    expect(issues.some((i) => i.code === 'not_a_member')).toBe(true);
    expect(issues.some((i) => i.code === 'unknown_char')).toBe(true);
  });

  it('accepts a complete, distinct, in-group cast', () => {
    expect(
      validateBindings(SCRIPT, { a: 'ai_x', b: 'ai_y', c: 'ai_z' }, ['ai_x', 'ai_y', 'ai_z']),
    ).toEqual([]);
  });

  it('re-picking an actor already on stage SWAPS the two roles', () => {
    const start = { a: 'ai_x', b: 'ai_y', c: 'ai_z' };
    const next = assignRole(start, 'a', 'ai_y');
    expect(next).toEqual({ a: 'ai_y', b: 'ai_x', c: 'ai_z' });
    // Assigning into an empty role just displaces without inventing a binding.
    const partial = assignRole({ a: 'ai_x' }, 'b', 'ai_x');
    expect(partial).toEqual({ b: 'ai_x' });
  });

  it('names roles for error messages', () => {
    expect(roleNameOf(SCRIPT, 'a')).toBe('侦探');
    expect(roleNameOf(SCRIPT, 'nope')).toBe('nope');
  });

  it('planBeat follows the binding, not member order — the secret lands on the ROLE', () => {
    // Deliberately misaligned with any natural array order: the detective is
    // played by ai_z. Under the old positional binding, whoever sat first in
    // the members array would have received the detective's secret.
    const s = mkSave({ bindings: { a: 'ai_z', b: 'ai_x', c: 'ai_y' } });
    const plan = planBeat(SCRIPT, s)!;
    expect(Object.keys(plan.directives)).toEqual(['ai_z']); // n1 directs only 'a'
    expect(plan.directives['ai_z']).toContain('旁敲侧击');
    expect(plan.directives['ai_z']).toContain('你早就认出了他');
    // Nobody else got a directive — least of all the secret.
    expect(plan.directives['ai_x']).toBeUndefined();
    expect(plan.directives['ai_y']).toBeUndefined();
  });
});

/* ==================== rollback: transcript trimming ==================== */

describe('rollback trims the transcript by watermark', () => {
  beforeEach(wipeStores);

  async function seedMessages(convId: string, n: number): Promise<MessageVM[]> {
    const out: MessageVM[] = [];
    for (let i = 0; i < n; i++) {
      out.push(
        await repo.addMessage({
          convId,
          senderId: i % 2 ? 'self' : 'ai_x',
          type: 'text',
          content: `line ${i}`,
          status: 'sent',
          createdAt: T0 + i * 1000,
        }),
      );
    }
    return out;
  }

  it('deletes rows after the snapshot cursor — rowid holes, timestamps untouched', async () => {
    const before = await seedMessages('g_story', 4);
    const cursor = before.at(-1)!.id;
    // Moving out of beat 0 snapshots the watermark: "beat 0 ended with the
    // transcript at this id"…
    let s = applyTrigger(mkSave(), { when: 'expr:true', to: 'n2' }, T0 + 1, cursor).save;
    // …then the next scene lands in the conversation.
    const after = await seedMessages('g_story', 3);
    s = applyTrigger(s, { when: 'expr:true', to: 'end_warm' }, T0 + 2, after.at(-1)!.id).save;

    // Back to beat 0 = back to the transcript as beat 0 left it.
    const r = await rollbackTo(s, 0, T0 + 100);
    expect(r.messagesRemoved.sort((a, b) => a - b)).toEqual(after.map((m) => m.id));

    const rows = await repo.getMessages('g_story', { limit: 50 });
    // The survivors are byte-identical: same ids (holes stay holes — no
    // re-packing) and same createdAt (rowid order == time order is untouched).
    expect(rows.map((m) => m.id)).toEqual(before.map((m) => m.id));
    expect(rows.map((m) => m.createdAt)).toEqual(before.map((m) => m.createdAt));
    // And user lines got trimmed alongside actor lines — a scene un-happens
    // whole, not just the AI half of it.
    expect(after.some((m) => m.senderId === 'self')).toBe(true);
  });

  it('a zero cursor restores state only — it must NEVER wipe the thread', async () => {
    const before = await seedMessages('g_story', 3);
    // Pre-I7 snapshot shape: msgCursor 0.
    const s = applyTrigger(mkSave(), { when: 'expr:true', to: 'n2' }, T0 + 1).save;
    const r = await rollbackTo(s, 0, T0 + 100);
    expect(r.messagesRemoved).toEqual([]);
    expect((await repo.getMessages('g_story', { limit: 50 })).map((m) => m.id)).toEqual(
      before.map((m) => m.id),
    );
  });

  it('only the run’s own conversation is trimmed', async () => {
    // g_story first, g_other second: the other thread's rowids are all LATER
    // than the watermark, so only per-conversation scoping keeps them alive.
    const mine = await seedMessages('g_story', 2);
    const other = await seedMessages('g_other', 3);
    let s = applyTrigger(
      mkSave(),
      { when: 'expr:true', to: 'n2' },
      T0 + 1,
      mine[0].id, // watermark INSIDE g_story: everything after it goes
    ).save;
    await seedMessages('g_story', 1);
    s = applyTrigger(s, { when: 'expr:true', to: 'end_warm' }, T0 + 2, 9999).save;
    const r = await rollbackTo(s, 0, T0 + 100);
    // g_story lost its tail past the watermark…
    expect(r.messagesRemoved.length).toBe(2);
    expect((await repo.getMessages('g_story', { limit: 50 })).map((m) => m.id)).toEqual([
      mine[0].id,
    ]);
    // …and every g_other row — all with ids past the watermark — survived.
    expect(other.every((m) => m.id > mine[0].id)).toBe(true);
    expect((await repo.getMessages('g_other', { limit: 50 })).map((m) => m.id)).toEqual(
      other.map((m) => m.id),
    );
  });
});

/* ==================== rollback: deterministic replay ==================== */

describe('回滚后种子重放等于原分支', () => {
  beforeEach(wipeStores);

  /** The same three-move walk, applied to whatever state it is given. */
  function walk(s: StorySaveRow): { states: StorySaveRow[]; tags: string[] } {
    const moves: Trigger[] = [
      { when: 'expr:true', to: 'n2', effects: { vars: { trust: 2, exposed: true } } },
      { when: 'expr:true', to: 'n1', effects: { vars: { trust: 0 } } },
      { when: 'expr:true', to: 'end_warm', effects: { memWrite: [{ charId: 'a', fact: '终' }] } },
    ];
    const states: StorySaveRow[] = [];
    const tags: string[] = [];
    for (const [i, m] of moves.entries()) {
      s = applyTrigger(s, m, T0 + 10 + i, 100 + i).save;
      states.push(s);
      tags.push(storyTag(s.id, s.seq));
    }
    return { states, tags };
  }

  it('replaying the same triggers reproduces the branch exactly', async () => {
    const first = walk(mkSave());
    const finalA = first.states.at(-1)!;

    // Roll all the way back…
    const r = await rollbackTo(finalA, 0, T0 + 50);
    expect(r.save.seq).toBe(0);
    expect(r.save.nodeId).toBe('n1');
    expect(r.save.vars).toEqual(SCRIPT.vars);

    // …and replay. Same nodes, same vars, same seq, same side-effect tags —
    // which is what makes rollback an UNDO rather than a fork.
    const second = walk(r.save);
    const finalB = second.states.at(-1)!;
    expect(finalB.nodeId).toBe(finalA.nodeId);
    expect(finalB.vars).toEqual(finalA.vars);
    expect(finalB.seq).toBe(finalA.seq);
    expect(second.tags).toEqual(first.tags);
    expect(second.states.map((x) => x.nodeId)).toEqual(first.states.map((x) => x.nodeId));
  });

  it('advance() itself is deterministic given the same vars', () => {
    const a = advance(SCRIPT, mkSave({ vars: { trust: 2, exposed: false } }), T0 + 1, 7);
    const b = advance(SCRIPT, mkSave({ vars: { trust: 2, exposed: false } }), T0 + 1, 7);
    expect(a.moved).toBe(true);
    expect(a.save.nodeId).toBe(b.save.nodeId);
    expect(a.save.vars).toEqual(b.save.vars);
    // And the watermark rides into the snapshot the move took.
    expect(a.save.history.at(-1)!.msgCursor).toBe(7);
  });
});

/* ==================== save slots (存档槽) ==================== */

describe('save slots', () => {
  beforeEach(wipeStores);

  it('writes, restores and drops a named slot', async () => {
    let s = await playBeats(mkSave(), 2);
    const { save: withSlot, slot } = writeSlot(s, '摊牌之前', 42, T0 + 20);
    expect(slot.seq).toBe(2);
    expect(slot.msgCursor).toBe(42);
    expect(withSlot.slots).toHaveLength(1);

    s = await playBeats(withSlot, 1);
    const r = await restoreSlot(s, slot.id, T0 + 30);
    expect('error' in r).toBe(false);
    if (!('error' in r)) {
      expect(r.save.seq).toBe(2);
      // The slot survives its own restore — a checkpoint is reusable.
      expect(r.save.slots?.some((x) => x.id === slot.id)).toBe(true);
    }

    const dropped = dropSlot(withSlot, slot.id, T0 + 40);
    expect(dropped.slots).toHaveLength(0);
  });

  it('a slot on a rolled-away timeline is dead, and rollback prunes it', async () => {
    const s = await playBeats(mkSave(), 3);
    const { save: withSlot, slot } = writeSlot(s, '第三幕', 99, T0 + 20);
    // Roll back BEFORE the slot: it points into a future that no longer exists.
    const r = await rollbackTo(withSlot, 1, T0 + 30);
    expect(r.save.slots?.some((x) => x.id === slot.id)).toBe(false);

    // And even an un-pruned stale slot (e.g. from a pre-prune row) is refused.
    const stale = { ...r.save, slots: [slot] };
    expect(canRestoreSlot(stale, slot)).toBe(false);
    const denied = await restoreSlot(stale, slot.id, T0 + 40);
    expect('error' in denied && denied.error).toContain('时间线');
  });

  it('defaults an empty name and bounds the slot count', () => {
    let s = mkSave({ seq: 5 });
    const { slot } = writeSlot(s, '   ', 1, T0);
    expect(slot.name).toBe('第 5 幕');
    for (let i = 0; i < MAX_SLOTS + 4; i++) {
      s = writeSlot(s, `slot${i}`, i, T0 + i).save;
    }
    expect(s.slots).toHaveLength(MAX_SLOTS);
    // Newest survive; the oldest fell off.
    expect(s.slots!.at(-1)!.name).toBe(`slot${MAX_SLOTS + 3}`);
  });
});

/* ==================== endings & gallery ==================== */

describe('结局画廊', () => {
  it('unlocks exactly the endings runs actually reached', () => {
    const saves = [
      mkSave({ id: 's1', run: 1, isActive: false, endingId: 'end_warm', endedAt: T0 + 1 }),
      mkSave({ id: 's2', run: 2, isActive: false }), // abandoned — unlocks nothing
      mkSave({ id: 's3', run: 3, isActive: true }),
      { ...mkSave({ id: 'sX', isActive: false, endingId: 'end_warm' }), scriptId: 'other' },
    ];
    const gallery = galleryFor(SCRIPT, saves);
    expect(gallery).toHaveLength(2);
    const warm = gallery.find((g) => g.node.id === 'end_warm')!;
    const cold = gallery.find((g) => g.node.id === 'end_cold')!;
    expect(warm.unlocked).toBe(true);
    expect(warm.reachedBy).toEqual([{ run: 1, at: T0 + 1, saveId: 's1' }]);
    expect(cold.unlocked).toBe(false);
    expect(gallerySummary(gallery)).toBe('1/2 结局已解锁');
  });

  it('endRun records the ending and archives the row', async () => {
    const s = mkSave({ id: 'save_end_test', nodeId: 'end_warm' });
    await putSave(s);
    const ended = await endRun(s, T0 + 9, 'end_warm');
    expect(ended.isActive).toBe(false);
    expect(ended.endingId).toBe('end_warm');
    expect(ended.endedAt).toBe(T0 + 9);
    const persisted = await getSave('save_end_test');
    expect(persisted?.endingId).toBe('end_warm');
    // An abandoned run ends WITHOUT an ending id — it must not unlock anything.
    const abandoned = await endRun(mkSave({ id: 'save_abandon' }), T0 + 10);
    expect(abandoned.endingId).toBeUndefined();
  });

  it('orders runs newest-first and labels their state', () => {
    const saves = [
      mkSave({ id: 's1', run: 1, isActive: false, endingId: 'end_warm' }),
      mkSave({ id: 's2', run: 2, isActive: true, stalledAt: T0 }),
      mkSave({ id: 's3', run: 3, isActive: true }),
    ];
    expect(runsOf(saves, 'v3demo').map((s) => s.id)).toEqual(['s3', 's2', 's1']);
    expect(runStateLabel(saves[0])).toBe('已完结');
    expect(runStateLabel(saves[1])).toBe('已暂停');
    expect(runStateLabel(saves[2])).toBe('进行中');
    expect(runStateLabel(mkSave({ isActive: false }))).toBe('已中止');
  });
});

/* ==================== resume ==================== */

describe('a stalled run can actually be resumed', () => {
  it('clearStall wipes the strike state', () => {
    const stalled = mkSave({ stalls: 3, stalledAt: T0 + 5 });
    expect(isStalled(stalled)).toBe(true);
    const cleared = clearStall(stalled, T0 + 10);
    expect(stallsOf(cleared)).toBe(0);
    expect(isStalled(cleared)).toBe(false);
    expect(cleared.updatedAt).toBe(T0 + 10);
  });

  it('resumeRun persists the cleared row and queues a fresh tick', async () => {
    const stalled = mkSave({ id: 'save_resume_me', stalls: 3, stalledAt: T0 + 5 });
    await putSave(stalled);
    const resumed = await resumeRun('save_resume_me', T0 + 60_000);
    expect(resumed).toBeDefined();
    expect(isStalled(resumed!)).toBe(false);
    expect(isStalled((await getSave('save_resume_me'))!)).toBe(false);
    const actions = await idbGetAll<{ id: string; kind: string; status: string }>(
      'scheduled_actions',
    );
    const tick = actions.find((a) => a.id.startsWith('story_save_resume_me_t'));
    expect(tick?.kind).toBe('story_tick');
    expect(tick?.status).toBe('pending');
    // An ended run refuses to resume — there is nothing to continue.
    await putSave(mkSave({ id: 'save_over', isActive: false }));
    expect(await resumeRun('save_over', T0)).toBeUndefined();
  });
});

/* ==================== graph layout ==================== */

describe('the SVG layout is deterministic geometry', () => {
  it('places every node exactly once, entry in column 0', () => {
    const l = layoutScript(SCRIPT);
    expect(l.nodes).toHaveLength(SCRIPT.nodes.length);
    expect(new Set(l.nodes.map((n) => n.id)).size).toBe(SCRIPT.nodes.length);
    expect(l.nodes.find((n) => n.id === 'n1')!.col).toBe(0);
    expect(l.nodes.find((n) => n.id === 'n1')!.x).toBe(PAD);
    // No two nodes share a cell.
    const cells = new Set(l.nodes.map((n) => `${n.col}:${n.row}`));
    expect(cells.size).toBe(l.nodes.length);
    // Canvas is wide enough for the deepest column.
    const deepest = Math.max(...l.nodes.map((n) => n.x));
    expect(l.width).toBeGreaterThanOrEqual(deepest + NODE_W);
  });

  it('classifies forward, back and self edges', () => {
    const l = layoutScript(SCRIPT);
    const fwd = l.edges.find((e) => e.from === 'n1' && e.to === 'n2');
    const back = l.edges.find((e) => e.from === 'n2' && e.to === 'n1');
    expect(fwd?.direction).toBe('forward');
    expect(back?.direction).toBe('back');
    const withSelf: Script = {
      ...SCRIPT,
      nodes: SCRIPT.nodes.map((n) =>
        n.id === 'n1'
          ? { ...n, triggers: [...n.triggers, { when: 'expr:false', to: 'n1' }] }
          : n,
      ),
    };
    expect(
      layoutScript(withSelf).edges.find((e) => e.from === 'n1' && e.to === 'n1')?.direction,
    ).toBe('self');
  });

  it('marks endings, timeouts and adult beats for the renderer', () => {
    const l = layoutScript(SCRIPT);
    expect(l.nodes.find((n) => n.id === 'end_warm')!.ending).toBe(true);
    expect(l.nodes.find((n) => n.id === 'n1')!.hasTimeout).toBe(true);
    const adult: Script = {
      ...SCRIPT,
      nodes: SCRIPT.nodes.map((n) => (n.id === 'n2' ? { ...n, nsfwLevel: 2 } : n)),
    };
    expect(layoutScript(adult).nodes.find((n) => n.id === 'n2')!.nsfwLevel).toBe(2);
  });

  it('is deterministic — same script, same geometry', () => {
    expect(layoutScript(SCRIPT)).toEqual(layoutScript(SCRIPT));
  });

  it('parks unreachable nodes instead of crashing (invalid drafts render too)', () => {
    const broken: Script = {
      ...SCRIPT,
      nodes: [
        ...SCRIPT.nodes,
        { id: 'orphan', goal: '孤岛', directives: [], triggers: [], ending: true },
      ],
    };
    const l = layoutScript(broken);
    const orphan = l.nodes.find((n) => n.id === 'orphan')!;
    const reachableDeepest = Math.max(
      ...l.nodes.filter((n) => n.id !== 'orphan').map((n) => n.col),
    );
    expect(orphan.col).toBe(reachableDeepest + 1);
    // A dangling edge is dropped, not thrown.
    const dangling: Script = {
      ...SCRIPT,
      nodes: SCRIPT.nodes.map((n) =>
        n.id === 'n1' ? { ...n, triggers: [{ when: 'expr:true', to: 'ghost' }] } : n,
      ),
    };
    expect(layoutScript(dangling).edges.every((e) => e.to !== 'ghost')).toBe(true);
  });

  it('visitedNodeIds = every snapshot plus the current beat', () => {
    const s = mkSave({
      nodeId: 'n2',
      history: [
        { seq: 0, nodeId: 'n1', vars: {}, msgCursor: 0, at: T0 },
        { seq: 1, nodeId: 'n2', vars: {}, msgCursor: 0, at: T0 + 1 },
      ],
    });
    expect([...visitedNodeIds(s)].sort()).toEqual(['n1', 'n2']);
  });
});

/* ==================== storySeq stamping ==================== */

describe('the story_seq column finally has a writer', () => {
  beforeEach(() => resetStoryStamps());

  it('stamps messages only while a beat is open, and closes cleanly', () => {
    const msg = { convId: 'g_story', senderId: 'ai_x', content: 'hi' };
    // No beat playing: the SAME object comes back (no per-message clone tax).
    expect(applyStoryStamp(msg)).toBe(msg);

    beginStoryStamp('g_story', { saveId: 'save_1', scriptId: 'v3demo', seq: 4 });
    expect(storyStampFor('g_story')).toEqual({ saveId: 'save_1', scriptId: 'v3demo', seq: 4 });
    const stamped = applyStoryStamp(msg);
    expect(stamped.storyScriptId).toBe('v3demo');
    expect(stamped.storySeq).toBe(4);
    // Another conversation's messages stay untouched.
    expect(applyStoryStamp({ convId: 'g_other' })).toEqual({ convId: 'g_other' });

    endStoryStamp('g_story');
    expect(applyStoryStamp(msg)).toBe(msg);
    // Idempotent close.
    endStoryStamp('g_story');
  });
});

/* ==================== dry-run preview & traces ==================== */

describe('the rollback preview is the rollback (dry-run parity)', () => {
  beforeEach(wipeStores);

  it('planRollback reports exactly what rollbackTo then removes — and deletes nothing', async () => {
    const s = await playBeats(mkSave({ id: 'save_plan' }), 3);
    const withSlot = writeSlot(s, '后来会失效', 5, T0 + 20).save;

    const plan = await planRollback(withSlot, 1);
    // Nothing was touched by the preview.
    expect((await repo.getMemory('ai_x')).filter((f) => f.storyTag)).toHaveLength(3);
    expect((await repo.getMoments()).filter((m) => m.storyTag)).toHaveLength(3);

    const r = await rollbackTo(withSlot, 1, T0 + 30);
    // Preview and execution are the same query: counts must agree, row for row.
    expect(plan.memory.map((f) => f.id).sort()).toEqual([...r.memoryRemoved].sort());
    expect(plan.moments.map((m) => m.id).sort()).toEqual([...r.momentsRemoved].sort());
    expect(plan.messageCount).toBe(r.messagesRemoved.length);
    expect(plan.restoredSeq).toBe(r.save.seq);
    expect(plan.slotsLost).toEqual(['后来会失效']);
  });

  it('the preview names the memories it would take', async () => {
    const s = await playBeats(mkSave({ id: 'save_named' }), 2);
    const plan = await planRollback(s, 0);
    expect(plan.memory.map((f) => f.fact)).toEqual([
      'save_named 第1幕',
      'save_named 第2幕',
    ]);
    expect(plan.trimsMessages).toBe(false); // beats played without a watermark
  });

  it('collectRunTraces counts what a run left standing', async () => {
    const s = await playBeats(mkSave({ id: 'save_traces' }), 2);
    // Two stamped lines inside the run's window, one before it, one unstamped.
    await repo.addMessage({
      convId: 'g_story',
      senderId: 'ai_x',
      type: 'text',
      content: '开演前的闲聊',
      status: 'sent',
      createdAt: T0 - 100,
      storyScriptId: 'v3demo',
    } as Parameters<typeof repo.addMessage>[0]);
    for (let i = 0; i < 2; i++) {
      await repo.addMessage({
        convId: 'g_story',
        senderId: 'ai_x',
        type: 'text',
        content: `台词${i}`,
        status: 'sent',
        createdAt: T0 + 100 + i,
        storyScriptId: 'v3demo',
        storySeq: i,
      } as Parameters<typeof repo.addMessage>[0]);
    }
    await repo.addMessage({
      convId: 'g_story',
      senderId: 'self',
      type: 'text',
      content: '不相干的话',
      status: 'sent',
      createdAt: T0 + 200,
    });
    const traces = await collectRunTraces(s);
    expect(traces.facts).toHaveLength(2);
    expect(traces.moments).toHaveLength(2);
    expect(traces.messageCount).toBe(2);
  });
});

describe('trigger conditions read like sentences', () => {
  it('describes both tracks and calls out the invalid one', () => {
    expect(describeWhen('expr:vars.trust >= 2 && vars.exposed == true')).toBe(
      'trust >= 2 且 exposed = true',
    );
    expect(describeWhen('llm:访客终于说出了实话')).toBe('由 GM 判断：访客终于说出了实话');
    expect(describeWhen('trust > 2')).toContain('永不触发');
  });
});

describe('run page copy helpers', () => {
  it('the confirm body names counts, memories and dying slots', () => {
    const body = rollbackConfirmBody({
      restoredSeq: 1,
      trimsMessages: true,
      memory: [
        { id: 'a', fact: '雨夜的访客是旧识' },
        { id: 'b', fact: '门锁坏了' },
      ],
      moments: [{ id: 'm', text: 'x' }],
      messageCount: 7,
      slotsLost: ['摊牌之前'],
    });
    expect(body).toContain('2 条记忆、1 条朋友圈、7 条消息');
    expect(body).toContain('「雨夜的访客是旧识」');
    expect(body).toContain('存档槽「摊牌之前」');
    // And the old-save caveat appears only when there is no watermark.
    expect(body).not.toContain('原样保留');
    expect(
      rollbackConfirmBody({
        restoredSeq: 0,
        trimsMessages: false,
        memory: [],
        moments: [],
        messageCount: 0,
        slotsLost: [],
      }),
    ).toContain('原样保留');
  });

  it('formats durations the way a person says them', () => {
    expect(fmtDuration(30_000)).toBe('1 分钟');
    expect(fmtDuration(4 * 60_000)).toBe('4 分钟');
    expect(fmtDuration(83 * 60_000)).toBe('1 小时 23 分');
    expect(fmtDuration(120 * 60_000)).toBe('2 小时');
  });
});

/* ==================== runStoryBeat: the I7 seams ==================== */

describe('runStoryBeat — stamp, watermark and ending recording', () => {
  beforeEach(async () => {
    await wipeStores();
    resetStoryStamps();
    await saveScript(SCRIPT, 'import', T0);
  });

  /** Hooks whose appendMessage runs the SAME choke point the store does. */
  function stampingHooks(appended: Array<Record<string, unknown>>): StoryHooks {
    return {
      appendMessage: async (m) => {
        // Mirrors appStore.appendMessage: stamp, then persist.
        const stamped = applyStoryStamp(m);
        appended.push(stamped as unknown as Record<string, unknown>);
        await repo.addMessage(stamped as Parameters<typeof repo.addMessage>[0]);
      },
      playBeat: async (convId) => {
        // The actors' lines arrive through the same door.
        const line = applyStoryStamp({
          convId,
          senderId: 'ai_z',
          type: 'text' as const,
          content: '你今晚来得真巧。',
          status: 'sent' as const,
          createdAt: T0 + 5,
        });
        appended.push(line as unknown as Record<string, unknown>);
        await repo.addMessage(line);
      },
      contactById: () => undefined,
      now: () => T0 + 10,
    };
  }

  it('every message of a beat carries the run tag, and the stamp closes after', async () => {
    await putSave(mkSave({ id: 'save_stamp', seq: 2, vars: { trust: 0, exposed: false } }));
    const appended: Array<Record<string, unknown>> = [];
    await runStoryBeat('save_stamp', stampingHooks(appended));

    // Narration + the actor's line both landed stamped with the CURRENT seq.
    expect(appended.length).toBeGreaterThanOrEqual(2);
    for (const m of appended) {
      expect(m.storyScriptId).toBe('v3demo');
      expect(m.storySeq).toBe(2);
    }
    // The beat is over: ordinary chat in the same conversation is untouched.
    expect(storyStampFor('g_story')).toBeUndefined();
    const plain = applyStoryStamp({ convId: 'g_story' });
    expect('storyScriptId' in plain).toBe(false);
  });

  it('closes the stamp even when playBeat throws', async () => {
    await putSave(mkSave({ id: 'save_stamp_throw' }));
    const hooks: StoryHooks = {
      appendMessage: async () => undefined,
      playBeat: async () => {
        // The stamp must be open DURING the beat…
        expect(storyStampFor('g_story')).toBeDefined();
        throw new Error('LLM 超时');
      },
      contactById: () => undefined,
      now: () => T0,
    };
    await expect(runStoryBeat('save_stamp_throw', hooks)).rejects.toThrow('LLM 超时');
    // …and closed after the throw, or every later message in this conversation
    // would be tagged into a story forever.
    expect(storyStampFor('g_story')).toBeUndefined();
  });

  it('a moving beat snapshots the real transcript watermark', async () => {
    // trust ≥ 2: n1's local trigger fires on this beat.
    await putSave(mkSave({ id: 'save_water', vars: { trust: 5, exposed: false } }));
    const appended: Array<Record<string, unknown>> = [];
    await runStoryBeat('save_water', stampingHooks(appended));
    const after = await getSave('save_water');
    expect(after!.nodeId).toBe('n2');
    const snap = after!.history.at(-1)!;
    // The watermark is the newest message id AFTER the beat's lines landed —
    // rolling back to this beat keeps its own dialogue and trims what follows.
    const newest = (await repo.getMessages('g_story', { limit: 1 })).at(-1)!.id;
    expect(snap.msgCursor).toBe(newest);
    expect(snap.msgCursor).toBeGreaterThan(0);
  });

  it('finishing on an ending node records WHICH ending', async () => {
    await putSave(mkSave({ id: 'save_finale', nodeId: 'end_warm' }));
    const appended: Array<Record<string, unknown>> = [];
    const r = await runStoryBeat('save_finale', stampingHooks(appended));
    expect(r.finished).toBe(true);
    const done = await getSave('save_finale');
    expect(done!.isActive).toBe(false);
    expect(done!.endingId).toBe('end_warm');
    expect(done!.endedAt).toBe(T0 + 10);
    // …which is exactly what unlocks the gallery.
    const gallery = galleryFor(SCRIPT, [done!]);
    expect(gallery.find((g) => g.node.id === 'end_warm')!.unlocked).toBe(true);
  });
});

/* ==================== backup round trip ==================== */

describe('the I7 save-row shape survives a backup round trip', () => {
  it('slots, run number, vars and the ending all come back intact', async () => {
    const { exportBackup, serializeBackup, parseBackup, restoreBackup } = await import(
      '../../src/lib/backup'
    );
    let s = mkSave({ id: 'save_backup_me', run: 2, endingId: 'end_warm', endedAt: T0 + 99 });
    s = writeSlot(s, '备份前留的档', 7, T0 + 10).save;
    await putSave(s);

    // The whole journey a `.aiwx` file makes: export → text → parse → restore.
    const file = await exportBackup(T0 + 100, 'test', { includeMedia: false });
    const parsed = parseBackup(serializeBackup(file));
    await idbDelete('story_saves', 'save_backup_me');
    expect(await getSave('save_backup_me')).toBeUndefined();
    await restoreBackup(parsed, T0 + 200);

    const back = await getSave('save_backup_me');
    expect(back).toBeDefined();
    expect(runOf(back!)).toBe(2);
    expect(back!.endingId).toBe('end_warm');
    expect(back!.endedAt).toBe(T0 + 99);
    expect(back!.vars).toEqual(s.vars);
    expect(back!.slots).toHaveLength(1);
    expect(back!.slots![0].name).toBe('备份前留的档');
    expect(back!.slots![0].msgCursor).toBe(7);
    // Restoring on another device must not revive a paused chain's strike
    // state incorrectly — the row round-trips verbatim, stalls included.
    expect(stallsOf(back!)).toBe(stallsOf(s));
  });
});

/* ==================== the store keeps up with rollback ==================== */

describe('rollback and the in-memory store agree', () => {
  beforeEach(wipeStores);

  it('reloadConversation replaces the trimmed thread and fixes the list preview', async () => {
    const { useAppStore } = await import('../../src/store/appStore');
    const conv = {
      id: 'g_live',
      type: 'group' as const,
      title: '剧组',
      avatarColor: '',
      avatarText: '剧',
      memberIds: ['ai_x', 'ai_y'],
      isPinned: false,
      isMuted: false,
      unreadCount: 0,
      mentionMe: false,
      lastMsgPreview: '',
      lastMsgAt: 0,
    };
    await repo.putConversation(conv);
    useAppStore.setState({ conversations: [conv], messages: {}, hydrated: true });

    const rows: MessageVM[] = [];
    for (let i = 0; i < 4; i++) {
      rows.push(
        await repo.addMessage({
          convId: 'g_live',
          senderId: i % 2 ? 'self' : 'ai_x',
          type: 'text',
          content: `第${i}句`,
          status: 'sent',
          createdAt: T0 + i,
        }),
      );
    }
    const store = useAppStore.getState();
    await store.openConversation('g_live');
    expect(useAppStore.getState().messagesFor('g_live')).toHaveLength(4);

    // A rollback deletes the tail UNDERNEATH the store…
    await repo.deleteMessage(rows[2].id);
    await repo.deleteMessage(rows[3].id);
    // …and the stale in-memory thread would resurrect the trimmed scenes.
    expect(useAppStore.getState().messagesFor('g_live')).toHaveLength(4);

    await useAppStore.getState().reloadConversation('g_live');
    const fresh = useAppStore.getState().messagesFor('g_live');
    expect(fresh.map((m) => m.id)).toEqual([rows[0].id, rows[1].id]);
    // The list row's preview followed the new tail.
    const patched = useAppStore.getState().conversationById('g_live');
    expect(patched?.lastMsgPreview).toBe('第1句');
    expect(patched?.lastMsgAt).toBe(rows[1].createdAt);

    // A thread that was never loaded stays untouched (no phantom hydration).
    await useAppStore.getState().reloadConversation('g_never');
    expect(useAppStore.getState().messages['g_never']).toBeUndefined();
  });
});

/* ==================== wiring guards ==================== */

const root = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

describe('I7 wiring — written AND plugged in', () => {
  it('appendMessage actually applies the story stamp', () => {
    const store = read('src/store/appStore.ts');
    expect(
      store.includes('applyStoryStamp('),
      'appStore.appendMessage 必须过 applyStoryStamp——否则 story_seq 列又回到零写入方。',
    ).toBe(true);
  });

  it('runStoryBeat opens the stamp and closes it in finally', () => {
    const svc = read('src/ai/story-service.ts');
    expect(svc.includes('beginStoryStamp(')).toBe(true);
    expect(
      /finally\s*\{\s*endStoryStamp\(/.test(svc),
      'endStoryStamp 必须在 finally 里——beat 抛错不能让会话永远带戳。',
    ).toBe(true);
  });

  it('the beat feeds a real watermark into advance()', () => {
    const svc = read('src/ai/story-service.ts');
    expect(
      svc.includes('latestMessageId(save.convId)'),
      '不取水位，快照的 msgCursor 恒为 0——回滚就永远裁不了消息。',
    ).toBe(true);
  });

  it('the run pages are actually routed', () => {
    const app = read('src/App.tsx');
    for (const route of ['/story', '/story/script/:scriptId', '/story/run/:saveId']) {
      expect(app.includes(`path="${route}"`), `路由 ${route} 没挂进 App.tsx`).toBe(true);
    }
  });

  it('the chat surfaces deep-link into the RUN page, not the library', () => {
    // The banner exists to answer "what is happening HERE" — landing the user
    // on the library list makes them find their own run in it.
    expect(read('src/features/chat/ChatPage.tsx').includes('/story/run/${story.id}')).toBe(true);
    expect(read('src/features/chat/ChatInfoPage.tsx').includes('/story/run/${storyRun.id}')).toBe(
      true,
    );
  });

  it('the start path passes an explicit run number', () => {
    const page = read('src/features/story/ScriptDetailPage.tsx');
    expect(
      page.includes('nextRunNumber('),
      '开演必须带周目号——否则第二轮的 run 又静默回到 1。',
    ).toBe(true);
    expect(
      page.includes('suggestBindings') || read('src/features/story/CastingSheet.tsx').includes('suggestBindings'),
      '选角默认值必须来自 order-independent 的 suggestBindings。',
    ).toBe(true);
  });
});
