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
import { getScript, activeSaveFor, putSave, planBeat, advance, materializeEffects, endRun, type StorySaveRow } from './story-gm';
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

/** Queue the next beat for a run. Stable id so a double-fire cannot stack. */
export async function scheduleNextBeat(save: StorySaveRow, now: number): Promise<void> {
  await enqueue({
    kind: 'story_tick',
    fireAt: now + STORY_TICK_MS,
    payload: { saveId: save.id, convId: save.convId },
    now,
    id: `story_${save.id}_${save.seq}_${save.turnsInNode}`,
  });
}

/**
 * One beat. Chain-before-work applies here too (see scheduler.ts): the next
 * tick is queued by the caller BEFORE this runs, so a failed beat pauses the
 * story rather than ending it permanently.
 */
export async function runStoryBeat(
  saveId: string,
  hooks: StoryHooks,
): Promise<{ finished: boolean }> {
  const save = await import('./story-gm').then((m) => m.getSave(saveId));
  if (!save || !save.isActive) return { finished: true };
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
  if (plan.narrate && save.turnsInNode === 0) {
    await hooks.appendMessage({
      convId: save.convId,
      senderId: 'system',
      type: 'system',
      content: plan.narrate,
      status: 'sent',
      createdAt: now,
    });
  }

  await hooks.playBeat(save.convId, plan.directives, plan.goal);

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
  const result = advance(script, save, hooks.now());
  await materializeEffects(result.save, result.effects, result.save.bindings, hooks.now(), {
    putMemory: (f: MemoryFactVM) => repo.putMemory(f),
    putMoment: (m: MomentVM) => repo.putMoment(m),
  });
  await putSave(result.save);
  await scheduleNextBeat(result.save, hooks.now());
  return { finished: false };
}

/** Is a story currently playing in this conversation? Used to gate the UI. */
export async function storyRunning(convId: string): Promise<StorySaveRow | undefined> {
  return activeSaveFor(convId);
}
