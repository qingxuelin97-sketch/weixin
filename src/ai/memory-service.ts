/**
 * Memory-extraction trigger (M-D2). Closes the loop the codebase never had:
 * extractMemory existed since M2 with ZERO callers — chats never produced
 * memory. Now a conversation going quiet (leaving the chat page) with enough
 * new material queues ONE extraction through the single time-evolution path.
 *
 * Cost discipline: at most one `mem_extract` per conversation per silence,
 * gated on ≥6 new messages since the last extraction marker, deduped by a
 * stable action id (the enqueue-upsert trap: actionExists guards re-adds).
 */
import { repo } from '../db/repo';
import { enqueue, actionExists } from './scheduler';

/**
 * New messages required since the last extraction before we spend a call —
 * calibrated PER ROOM SHAPE (M-J2). The single value 6 was set to single-chat
 * cadence and never re-examined when groups came online: one group round can
 * emit up to 9 lines (3 actors × 3 bubbles), so groups cleared the bar on
 * almost every visit — one memory-role LLM call per peek — while a 1:1 that
 * traded four thoughtful messages never cleared it at all.
 */
export const MEM_EXTRACT_MIN_NEW = 6;
export const MEM_EXTRACT_MIN_NEW_GROUP = 14;
/** Fires shortly after the user leaves — feels like "she thought about it later". */
const EXTRACT_DELAY_MS = 2 * 60_000;

const markerKey = (convId: string) => `memext:${convId}`;

export async function getExtractMarker(convId: string): Promise<number> {
  return (await repo.getSetting<number>(markerKey(convId))) ?? 0;
}

export async function setExtractMarker(convId: string, msgId: number): Promise<void> {
  await repo.putSetting(markerKey(convId), msgId);
}

/**
 * Call when a single chat goes quiet. Queues an extraction if there's enough
 * unprocessed conversation; otherwise does nothing (and costs nothing).
 */
export async function maybeScheduleMemExtract(
  convId: string,
  contactId: string,
  now: number,
  opts: { group?: boolean } = {},
): Promise<boolean> {
  const marker = await getExtractMarker(convId);
  const recent = await repo.getMessages(convId, { limit: 60 });
  const fresh = recent.filter((m) => m.id > marker && !m.isRecalled && m.type === 'text');
  const minNew = opts.group ? MEM_EXTRACT_MIN_NEW_GROUP : MEM_EXTRACT_MIN_NEW;
  if (fresh.length < minNew) return false;

  const lastId = fresh[fresh.length - 1].id;
  const id = `mem_${convId}_${lastId}`;
  // One extraction per (conv, frontier) ever — a completed action must not be
  // revived as pending by the enqueue upsert.
  if (await actionExists(id)) return false;
  await enqueue({
    kind: 'mem_extract',
    fireAt: now + EXTRACT_DELAY_MS,
    payload: { convId, contactId, uptoMsgId: lastId },
    now,
    id,
  });
  return true;
}
