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
import { enqueue, pendingActions, payloadOf } from './scheduler';
import { repo } from '../db/repo';
import type { ContactVM, MemoryFactVM, MomentVM } from '../data/types';
import { getScript, activeSaveFor, putSave, planBeat, advance, applyTrigger, applyChoiceOption, openChoice, hasPendingChoice, materializeEffects, endRun, getSave, clearStall, runOf, type StorySaveRow } from './story-gm';
import type { Script, Trigger } from './story-script';
import { ngPlusOpening } from './story-runs';
import { BUILTIN_SCRIPTS } from './story-builtin';
import { saveScript, listScripts } from './story-gm';
import { beginStoryStamp, endStoryStamp } from './story-stamp';
import { logError } from '../lib/errlog';

/** The idle cadence. Slow enough to read, fast enough to feel alive. */
export const STORY_TICK_MS = 45_000;

/** The cadence while the user is LOOKING at the stage conversation (V4). */
export const STORY_TICK_ACTIVE_MS = 15_000;

/**
 * The gap before the NEXT beat, or `null` for "do not schedule at all" (V4).
 *
 * Three inputs, one fireAt — never a second timer (constitution rule #5):
 *  - a run waiting on a player choice schedules NOTHING; the user's tap
 *    re-opens the chain (`applyChoice`);
 *  - the user watching the stage conversation gets beats at 15s instead of
 *    45s — a play you are looking at should feel live, one running in the
 *    background should not burn tokens at watch speed;
 *  - the CURRENT node's `pace` scales the result ('fast' ×½, 'slow' ×2), so an
 *    author can make a confrontation tumble and an aftermath breathe.
 */
export function tickMsFor(
  save: Pick<StorySaveRow, 'pendingChoice' | 'nodeId'>,
  script: Script | null,
  userPresent: boolean,
): number | null {
  if (hasPendingChoice(save)) return null;
  const base = userPresent ? STORY_TICK_ACTIVE_MS : STORY_TICK_MS;
  const pace = script?.nodes.find((n) => n.id === save.nodeId)?.pace;
  const mul = pace === 'fast' ? 0.5 : pace === 'slow' ? 2 : 1;
  return Math.round(base * mul);
}

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
  delayMs: number = STORY_TICK_MS,
): Promise<void> {
  await enqueue({
    kind: 'story_tick',
    fireAt: now + delayMs,
    payload: { saveId: save.id, convId: save.convId, tick },
    now,
    id: `story_${save.id}_t${tick}`,
  });
}

/**
 * Is a tick already queued for this run? (V4)
 *
 * The chain queues the successor BEFORE the work, so the beat that OPENS a
 * choice already left one pending tick behind — it lands as a no-op and its
 * own chain step refuses to continue. If the user picks an option INSIDE that
 * window, scheduling a second fresh chain would leave two live chains playing
 * beats in parallel forever. The pick therefore only opens a new chain when
 * the queue holds nothing for this run; otherwise the surviving tick — now
 * unblocked — carries on. (`resumeRun` reuses this for the same ≤1-tick race.)
 */
export async function hasLiveTick(saveId: string): Promise<boolean> {
  const rows = await pendingActions();
  return rows.some((r) => r.kind === 'story_tick' && payloadOf(r)?.saveId === saveId);
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
  /** Is the user looking at the stage conversation right now? Injected by the app shell. */
  userPresent = false,
): Promise<void> {
  const saveId = String(payload.saveId ?? '');
  if (!saveId) return;
  const { getSave, isStalled } = await import('./story-gm');
  const save = await getSave(saveId);
  // Don't chain past the end of a run, and don't chain a paused one — that is
  // what stops a dead provider from being retried until the heat death.
  if (!save || !save.isActive || isStalled(save)) return;
  // Adaptive cadence (V4), and the choice pause: `null` means the run is
  // waiting on the player — the chain STOPS here, and the user's tap
  // (`applyChoice`) is what opens a fresh one.
  const delay = tickMsFor(save, await getScript(save.scriptId), userPresent);
  if (delay == null) return;
  const tick = typeof payload.tick === 'number' && Number.isFinite(payload.tick) ? payload.tick : 0;
  await scheduleNextBeat(save, now, tick + 1, delay);
}

/** Newest message id in a conversation — the rollback watermark. 0 when empty. */
export async function latestMessageId(convId: string): Promise<number> {
  const rows = await repo.getMessages(convId, { limit: 1 });
  return rows.at(-1)?.id ?? 0;
}

/**
 * Resume a paused (stalled) run: clear the strike state and open a fresh tick
 * chain (M-I7 — the STALL_NOTICE has promised "可在剧情页继续" since M-G0,
 * and until now the story page had no button that did it).
 *
 * The tick is keyed on the resume moment. Safe against the `enqueue` upsert
 * trap: a stalled run queued NO successor (`chainNextBeat` refuses while
 * stalled), so there is no pending row this id could revive.
 */
export async function resumeRun(saveId: string, now: number): Promise<StorySaveRow | undefined> {
  const save = await getSave(saveId);
  if (!save || !save.isActive) return undefined;
  const cleared = clearStall(save, now);
  await putSave(cleared);
  // The last tick queued before the stall can still be pending (chain runs
  // before the failing work); resuming inside that window must join the
  // surviving chain, not stand up a second one beside it (V4).
  if (!(await hasLiveTick(cleared.id))) {
    const delay = tickMsFor(cleared, await getScript(cleared.scriptId), true);
    await scheduleNextBeat(cleared, now, now, delay ?? STORY_TICK_ACTIVE_MS);
  }
  return cleared;
}

/**
 * The player picked an option (V4): land the vars, move to the option's node,
 * clear the wait, and re-open the tick chain. The impure half of
 * `applyChoiceOption` — this is the ONLY code path that un-pauses a choice.
 */
export async function applyChoice(
  saveId: string,
  optionIndex: number,
  now: number,
  hooks: Pick<StoryHooks, 'appendMessage'>,
): Promise<StorySaveRow | undefined> {
  const save = await getSave(saveId);
  if (!save || !save.isActive || !hasPendingChoice(save)) return undefined;
  const label = save.pendingChoice!.options[optionIndex]?.label;
  if (label == null) return undefined;

  // The watermark FIRST, then the「选择」line: rolling back to this beat later
  // trims the line and re-asks the question — a rolled-back decision is undecided.
  const msgCursor = await latestMessageId(save.convId);
  beginStoryStamp(save.convId, { saveId: save.id, scriptId: save.scriptId, seq: save.seq });
  try {
    await hooks.appendMessage({
      convId: save.convId,
      senderId: 'system',
      type: 'system',
      content: `【选择】${label}`,
      status: 'sent',
      createdAt: now,
    });
  } finally {
    endStoryStamp(save.convId);
  }

  const stepped = applyChoiceOption(save, optionIndex, now, msgCursor);
  if (!stepped) return undefined;
  await putSave(stepped.save);

  // Re-open the chain — unless the pause's own leftover tick is still queued
  // (see `hasLiveTick`); the user is by definition present, so active cadence.
  if (!(await hasLiveTick(stepped.save.id))) {
    const delay = tickMsFor(stepped.save, await getScript(stepped.save.scriptId), true);
    await scheduleNextBeat(stepped.save, now, now, delay ?? STORY_TICK_ACTIVE_MS);
  }
  return stepped.save;
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
  // Waiting on the player (V4): a leftover tick landing during the wait must
  // not advance ANYTHING — no acting, no trigger evaluation, no turn counted.
  // The story moves again only through `applyChoice`.
  if (hasPendingChoice(save)) return { finished: false };
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

  // Every message this beat causes — narration, the actors' lines out of
  // `playBeat`, the stall/ending notices, and the user's own replies while the
  // scene plays — carries the run's (scriptId, seq) tag. The columns waited
  // since M1 for a writer; the stamp closes in `finally` so a thrown beat can
  // never leave the conversation stamping ordinary chat forever.
  beginStoryStamp(save.convId, { saveId: save.id, scriptId: save.scriptId, seq: save.seq });
  try {
    const firstArrival = save.turnsInNode === 0 && gm.stallsOf(save) === 0;

    // NG+ opening (V4): the very first beat of an inheriting run announces
    // what it inherited — once, before even the entry narration. Same gate as
    // narration so a flaky first night cannot repeat it.
    if (save.ngPlus && save.seq === 0 && firstArrival) {
      await hooks.appendMessage({
        convId: save.convId,
        senderId: 'system',
        type: 'system',
        content: ngPlusOpening(script, save.ngPlus, runOf(save)),
        status: 'sent',
        createdAt: now,
      });
    }

    // Narration next, as a grey system line — the story's own voice, visibly
    // distinct from anything a character says.
    //
    // `stallsOf(save) === 0` gates it to the FIRST attempt at this beat. Retries
    // re-enter with the same unadvanced save, so without the gate a flaky night
    // would print the same narration line once per retry.
    if (plan.narrate && firstArrival) {
      await hooks.appendMessage({
        convId: save.convId,
        senderId: 'system',
        type: 'system',
        content: plan.narrate,
        status: 'sent',
        createdAt: now,
      });
    }

    // A choice node (V4): the story PAUSES here. The prompt lands as grey
    // narration (stamped with this beat, so rollback re-asks it), the wait is
    // persisted, and the beat neither acts nor advances — deterministic and
    // free of LLM calls, which is what makes the pause instant. The successor
    // tick already queued by the chain lands as a no-op and refuses to chain
    // further; the user's tap is what moves the story again.
    if (plan.node.choice) {
      if (firstArrival) {
        await hooks.appendMessage({
          convId: save.convId,
          senderId: 'system',
          type: 'system',
          content: `【剧情抉择】${plan.node.choice.prompt}`,
          status: 'sent',
          createdAt: now,
        });
      }
      await putSave(openChoice(save, plan.node, hooks.now()));
      return { finished: false };
    }

    try {
      // The NG+ flavour rides into the FIRST beat's goal (V4): the actors are
      // not handed the previous run's plot — only that a faint familiarity is
      // in character now. Spoiling the old ending here would replay it.
      const goal =
        save.ngPlus && save.seq === 0
          ? `${plan.goal}（多周目重开：角色间带着一点说不清的既视感）`
          : plan.goal;
      await hooks.playBeat(save.convId, plan.directives, goal);
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
      // Record WHICH ending — the结局画廊 unlocks from this (M-I7).
      await endRun(save, hooks.now(), plan.node.id);
      return { finished: true };
    }

    // The transcript watermark for the snapshot a move takes: the newest
    // message id now that this beat's lines are on screen. Rolling back to
    // this beat later restores the conversation to exactly this point —
    // scenes after it are trimmed, this scene's dialogue survives.
    const msgCursor = await latestMessageId(save.convId);

    // Advance the graph and materialize whatever the trigger caused.
    let result = advance(script, save, hooks.now(), msgCursor);

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
        const stepped = applyTrigger(save, picked, hooks.now(), msgCursor);
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
  } finally {
    endStoryStamp(save.convId);
  }
}

/** Is a story currently playing in this conversation? Used to gate the UI. */
export async function storyRunning(convId: string): Promise<StorySaveRow | undefined> {
  return activeSaveFor(convId);
}
