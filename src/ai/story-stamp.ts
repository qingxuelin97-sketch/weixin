/**
 * Story message stamping (M-I7) — the writer the `story_seq` column waited for.
 *
 * `messages.story_script_id` / `story_seq` have been in the schema since M1
 * ("present now for zero-migration") and were never written by anything: the
 * story engine appended plain messages, so a transcript line caused by a beat
 * was indistinguishable from ordinary chat. That made per-beat bookkeeping
 * impossible and left rollback with nothing finer than "the whole tail".
 *
 * The mechanism is a tiny conversation-scoped registry rather than a new
 * parameter threaded through every append path, because a beat's messages are
 * born in three different places — the GM's own narration, the group engine's
 * `sendGroupProactiveMessage` (which knows nothing about stories, by design),
 * and the stall/ending system notices. All of them funnel through the store's
 * `appendMessage`; the store asks this registry "is a story playing a beat in
 * this conversation right now?" and tags the row if so. The group engine stays
 * story-blind, which is the isolation invariant of the whole feature.
 *
 * A message the USER sends during a beat is stamped too — deliberately. Their
 * line is part of the scene (the director reads it, triggers judge it), so it
 * belongs to the beat exactly as much as an actor's line does.
 *
 * Pure module state, no clock, no storage: `runStoryBeat` opens the stamp
 * before its first append and closes it in a `finally`, so a thrown beat can
 * never leave a conversation stamping forever.
 */

export interface StoryStamp {
  /** The run whose beat is playing (`StorySaveRow.id`). */
  saveId: string;
  /** Denormalized onto every message row: the script… */
  scriptId: string;
  /** …and the beat counter at the moment the message lands. */
  seq: number;
}

const active = new Map<string, StoryStamp>();

/** Begin stamping a conversation's appended messages with this beat's tag. */
export function beginStoryStamp(convId: string, stamp: StoryStamp): void {
  active.set(convId, stamp);
}

/** Stop stamping. Idempotent; call from `finally` so a thrown beat closes too. */
export function endStoryStamp(convId: string): void {
  active.delete(convId);
}

/** The stamp currently open on a conversation, if a beat is playing there. */
export function storyStampFor(convId: string): StoryStamp | undefined {
  return active.get(convId);
}

/**
 * Tag a message about to be persisted. Returns the SAME object when no beat is
 * playing — the common path must not clone every message in the app.
 */
export function applyStoryStamp<T extends { convId: string }>(
  msg: T,
): T & { storyScriptId?: string; storySeq?: number } {
  const stamp = active.get(msg.convId);
  if (!stamp) return msg;
  return { ...msg, storyScriptId: stamp.scriptId, storySeq: stamp.seq };
}

/** Test seam: forget every open stamp. */
export function resetStoryStamps(): void {
  active.clear();
}
