/**
 * Story mode, wired to the app (M-E5).
 *
 * `story-script.ts` is the data and the rules; `story-gm.ts` is the graph walk;
 * this is the impure seam that turns a beat into messages, memories and Moments
 * posts, and keeps the run moving on the ONE queue (`story_tick`).
 *
 * Serial by construction — GM decides the beat, the director casts it, the
 * actors speak — because a story where two beats overlap is not a story.
 */
import { enqueue } from './scheduler';
import { repo } from '../db/repo';
import type { ContactVM, MemoryFactVM, MomentVM } from '../data/types';
import { getScript, activeSaveFor, putSave, planBeat, advance, applyTrigger, materializeEffects, endRun, type StorySaveRow } from './story-gm';
import type { Trigger } from './story-script';
import { BUILTIN_SCRIPTS } from './story-builtin';
import { saveScript, listScripts } from './story-gm';
import { logError } from '../lib/errlog';

/** How long between beats. Slow enough to read, fast enough to feel alive. */
export const STORY_TICK_MS = 45_000;

export interface StoryHooks {
  appendMessage: (m: {
    convId: string;
    senderId: string;
    type: 'text' | 'system';
    content: string;
    status: 'sent';
    createdAt: number;
  }) => Promise<unknown>;
  /** Run one group round with the GM's per-character directives layered in. */
  playBeat: (
    convId: string,
    directives: Record<string, string>,
    goal: string,
  ) => Promise<void>;
  /**
   * Judge the `llm:` soft conditions of the current beat, returning the one
   * that has actually come true (or undefined for "not yet").
   *
   * Injected rather than called directly because it sends the conversation
   * transcript to a model: the tier has to come from the CONVERSATION, which
   * only the app shell can derive (constitution rule #6). Optional so tests and
   * `expr:`-only scripts never pay for a model call.
   */
  judgeTriggers?: (
    convId: string,
    goal: string,
    pending: Trigger[],
  ) => Promise<Trigger | undefined>;
  contactById: (id: string) => ContactVM | undefined;
  now: () => number;
}

/** Seed the built-in examples once. Idempotent; re-adds one the user deleted. */
export async function seedBuiltinScripts(now: number): Promise<number> {
  const existing = new Set((await listScripts()).map((s) => s.id));
  let added = 0;
  for (const s of BUILTIN_SCRIPTS) {
    if (existing.has(s.scriptId)) continue;
    const r = await saveScript(s, 'builtin', now);
    if (r.ok) added++;
    else logError('story.seed', new Error(r.issues.join('; ')));
  }
  return added;
}

/**
 * How many consecutive failed beats before the run pauses itself.
 *
 * Chain-before-work means a beat that throws gets retried by the next tick,
 * which is exactly what we want for one flaky night. Left unbounded it is also
 * a way to spend one LLM call every STORY_TICK_MS forever against a provider
 * that is down. Three strikes buys a genuine outage a couple of minutes of
 * grace and then stops.
 */
export const MAX_STALLS = 3;

export const STALL_NOTICE = '【剧情已暂停：连续多次生成失败。检查网络或 API 配置后，可在剧情页继续】';

/**
 * Queue the next beat for a run.
 *
 * The id is keyed on a monotonic TICK counter, not on the save's `(seq,
 * turnsInNode)`. That is load-bearing now that scheduling happens BEFORE the
 * beat runs: at that moment the save has not advanced yet, so a state-derived
 * id would be byte-identical to the row currently executing — and `enqueue`
 * upserts by id, which would flip the just-completed row back to `pending` and
 * replay the same beat forever (the trap CLAUDE.md records for `nudge`).
 */
export async function scheduleNextBeat(
  save: StorySaveRow,
  now: number,
  tick: number,
): Promise<void> {
  await enqueue({
    kind: 'story_tick',
    fireAt: now + STORY_TICK_MS,
    payload: { saveId: save.id, convId: save.convId, tick },
    now,
    id: `story_${save.id}_t${tick}`,
  });
}

/**
 * The CHAIN half of `story_tick` (see `registerChainedHandler`): queue the
 * successor before the work that can fail.
 *
 * Story mode was the one self-chaining kind that never got this treatment —
 * it used a plain `registerHandler` while its own comment claimed otherwise,
 * and it scheduled the next beat on the LAST line of the work. The scheduler
 * marks a row done before running its handler and drops handler errors without
 * retrying, so a single LLM timeout inside `playBeat` ended the story
 * permanently, silently, with no way back except a manual rollback.
 */
export async function chainNextBeat(
  payload: Record<string, unknown>,
  now: number,
): Promise<void> {
  const saveId = String(payload.saveId ?? '');
  if (!saveId) return;
  const { getSave, isStalled } = await import('./story-gm');
  const save = await getSave(saveId);
  // Don't chain past the end of a run, and don't chain a paused one — that is
  // what stops a dead provider from being retried until the heat death.
  if (!save || !save.isActive || isStalled(save)) return;
  const tick = typeof payload.tick === 'number' && Number.isFinite(payload.tick) ? payload.tick : 0;
  await scheduleNextBeat(save, now, tick + 1);
}

/**
 * One beat. The successor is already queued by `chainNextBeat` before this
 * runs, so throwing here pauses the story rather than ending it: the next tick
 * re-enters with the same save state and retries. `MAX_STALLS` bounds that.
 */
export async function runStoryBeat(
  saveId: string,
  hooks: StoryHooks,
): Promise<{ finished: boolean }> {
  const gm = await import('./story-gm');
  const save = await gm.getSave(saveId);
  if (!save || !save.isActive) return { finished: true };
  // A tick queued before the run paused can still land here. Honour the pause.
  if (gm.isStalled(save)) return { finished: false };
  const script = await getScript(save.scriptId);
  if (!script) {
    // The script was deleted mid-run. Ending the run is the honest outcome —
    // continuing would mean inventing beats nobody wrote.
    await endRun(save, hooks.now());
    return { finished: true };
  }

  const plan = planBeat(script, save);
  if (!plan) {
    await endRun(save, hooks.now());
    return { finished: true };
  }

  const now = hooks.now();

  // Narration first, as a grey system line — the story's own voice, visibly
  // distinct from anything a character says.
  //
  // `stallsOf(save) === 0` gates it to the FIRST attempt at this beat. Retries
  // re-enter with the same unadvanced save, so without the gate a flaky night
  // would print the same narration line once per retry.
  if (plan.narrate && save.turnsInNode === 0 && gm.stallsOf(save) === 0) {
    await hooks.appendMessage({
      convId: save.convId,
      senderId: 'system',
      type: 'system',
      content: plan.narrate,
      status: 'sent',
      createdAt: now,
    });
  }

  try {
    await hooks.playBeat(save.convId, plan.directives, plan.goal);
  } catch (e) {
    // The successor tick is already queued (chain-before-work), so this is a
    // retry, not a death — up to MAX_STALLS of them.
    const stalls = gm.stallsOf(save) + 1;
    const paused = stalls >= MAX_STALLS;
    await putSave({
      ...save,
      stalls,
      ...(paused ? { stalledAt: hooks.now() } : {}),
      updatedAt: hooks.now(),
    });
    if (paused) {
      await hooks.appendMessage({
        convId: save.convId,
        senderId: 'system',
        type: 'system',
        content: STALL_NOTICE,
        status: 'sent',
        createdAt: hooks.now(),
      });
    }
    // Rethrow so the scheduler's error sink logs it: a story that quietly
    // stops is the exact failure mode this whole change exists to kill.
    throw e;
  }

  if (plan.ending) {
    await hooks.appendMessage({
      convId: save.convId,
      senderId: 'system',
      type: 'system',
      content: `【剧情结束：${script.title}】`,
      status: 'sent',
      createdAt: hooks.now(),
    });
    await endRun(save, hooks.now());
    return { finished: true };
  }

  // Advance the graph and materialize whatever the trigger caused.
  let result = advance(script, save, hooks.now());

  // The `llm:` track. `advance` is pure, so it can only hand back the soft
  // conditions it could not judge; consuming them is this seam's job. Until
  // M-G0 nobody consumed `pending` at all, which made every `llm:` edge a
  // silently dropped one and left such beats to time out.
  //
  // Only reached when no local `expr:` fired — deterministic conditions are
  // never second-guessed by a model, and the common beat still costs 0 tokens.
  if (!result.moved && result.pending.length > 0 && hooks.judgeTriggers) {
    let picked: Trigger | undefined;
    try {
      picked = await hooks.judgeTriggers(save.convId, plan.goal, result.pending);
    } catch (e) {
      // A failed judgement is "not yet", not a dead story: the node's own
      // `timeout` is the exit the author already wrote for this case.
      logError('story.judge', e);
    }
    if (picked) {
      // Apply to the ORIGINAL save, not the turn-incremented one `advance`
      // returned — moving resets `turnsInNode` anyway, and counting a turn the
      // story did not spend would bring the timeout forward by one beat.
      const stepped = applyTrigger(save, picked, hooks.now());
      result = { save: stepped.save, fired: picked, pending: [], moved: true, effects: stepped.effects };
    }
  }

  await materializeEffects(result.save, result.effects, result.save.bindings, hooks.now(), {
    putMemory: (f: MemoryFactVM) => repo.putMemory(f),
    putMoment: (m: MomentVM) => repo.putMoment(m),
  });
  // A completed beat clears the strike count — MAX_STALLS counts CONSECUTIVE
  // failures, so one bad night mid-story must not carry over into the next.
  await putSave({ ...result.save, stalls: 0 });
  // NOTE: the successor tick is queued by `chainNextBeat`, not here. Scheduling
  // it at the end of the work is what made a single LLM failure terminal.
  return { finished: false };
}

/** Is a story currently playing in this conversation? Used to gate the UI. */
export async function storyRunning(convId: string): Promise<StorySaveRow | undefined> {
  return activeSaveFor(convId);
}
