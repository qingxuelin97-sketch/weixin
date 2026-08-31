/**
 * Deciding which photos ride along with a turn (M-H1).
 *
 * The transport can carry images; this decides whether it should. Two
 * questions matter and neither is the model's to answer:
 *
 *   1. WHICH images. Not "every photo in the conversation" — that would re-send
 *      the same picture on every turn for the rest of the thread, at roughly a
 *      thousand tokens each, forever. Only pictures from the last few messages,
 *      i.e. the ones the current exchange is plausibly about.
 *   2. WHETHER at all. Vision costs real money per turn and not everyone wants
 *      it on; a single setting turns it off without touching any call site.
 *
 * Kept out of `engine.ts` because both engines need it and because "what does
 * she actually see" deserves to be testable on its own.
 */
import type { MessageVM } from '../data/types';
import { repo } from '../db/repo';
import { encodeImage, MAX_IMAGES_PER_TURN } from '../llm/vision';
import { logError } from '../lib/errlog';

/** Settings key for the global on/off. Absent = on. */
export const VISION_SETTING = 'visionEnabled';

/**
 * How far back a photo can be and still count as "what we are talking about".
 *
 * Six messages is roughly one exchange: you send a picture, she reacts, you
 * say something about it, she answers. Beyond that the conversation has moved
 * on and the picture is history — which the transcript still records in words.
 */
const LOOKBACK = 6;

export async function visionEnabled(): Promise<boolean> {
  try {
    return (await repo.getSetting<boolean>(VISION_SETTING)) !== false;
  } catch {
    return true;
  }
}

/** The `idb:` media ids worth attaching to this turn, newest last. */
export function imageRefsForTurn(recent: MessageVM[]): string[] {
  const out: string[] = [];
  for (const m of recent.slice(-LOOKBACK)) {
    if (m.type !== 'image' || m.isRecalled) continue;
    // A recalled photo must not be sent: the user took it back, and a model
    // that can still see it will react to something that is no longer there.
    const ref = m.content ?? '';
    if (ref.startsWith('idb:')) out.push(ref.slice(4));
  }
  // Newest win when there are more than the cap: the most recent picture is
  // the one the current message is about.
  return out.slice(-MAX_IMAGES_PER_TURN);
}

/**
 * Load and encode the turn's images. Empty array whenever vision is off,
 * unavailable, or nothing recent qualifies — callers pass the result straight
 * through and the text-only path is unchanged.
 */
export async function collectTurnImages(recent: MessageVM[]): Promise<string[]> {
  const ids = imageRefsForTurn(recent);
  if (ids.length === 0) return [];
  if (!(await visionEnabled())) return [];
  const out: string[] = [];
  for (const id of ids) {
    try {
      const item = await repo.getMediaItem(id);
      if (!item?.blob) continue;
      const url = await encodeImage(item.blob);
      if (url) out.push(url);
    } catch (e) {
      // One unreadable photo must not cost the whole reply.
      logError('vision.encode', e);
    }
  }
  return out;
}
