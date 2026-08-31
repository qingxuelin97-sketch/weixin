/**
 * Letting her send a photo (M-H1).
 *
 * `image` has been a valid bubble type since M1 and the playback path has
 * always handled it — but nothing ever produced one, because the model has no
 * way to name a file. It can only describe what it wants to show ("刚烤的饼干"),
 * and something has to turn that into a real ref from the user's own pool.
 *
 * That is this module. It is the same pool, the same tag filter and the same
 * seeded selection the Moments engine has used since M4 (`pickImages`), so a
 * persona's photos look like the same person's photos wherever they appear.
 *
 * DEGRADES, NEVER BREAKS: with no usable pool the bubble becomes text. A
 * broken-image placeholder in a chat reads as a bug; her saying the thing in
 * words reads as her not having a picture to hand.
 */
import type { Bubble } from '../llm/types';
import type { NsfwTier } from '../llm/router';
import type { PersonaVM } from '../data/types';
import { pickImages, hasRealAssets } from '../data/moments-images';
import { photoPoolIds } from '../data/media-registry';
import { generateToLibrary } from './gen-media';

/**
 * Recently-sent refs per conversation, so she does not send the same photo
 * twice in a row. Process-lifetime and small: this is a "don't be obvious"
 * guard, not a history — it deliberately forgets across restarts rather than
 * spending a settings row on it.
 */
const recentByConv = new Map<string, string[]>();
const RECENT_KEEP = 8;

function remember(convId: string, ref: string): void {
  const list = recentByConv.get(convId) ?? [];
  list.push(ref);
  recentByConv.set(convId, list.slice(-RECENT_KEEP));
}

/** Test seam — the guard above is process state, and tests must start clean. */
export function resetPhotoMemory(): void {
  recentByConv.clear();
}

/**
 * Resolve one `image` bubble into a sendable message.
 *
 * `content` arrives as the model's description of the picture. It is kept as
 * the message's caption metadata rather than thrown away: it is what the
 * projection layer will later show HER OWN photo as, so a later turn can refer
 * back to "那张饼干的照片" instead of to an opaque handle.
 */
export function resolvePhotoBubble(
  bubble: Bubble,
  persona: Pick<PersonaVM, 'contactId' | 'imageTags'>,
  convId: string,
  seed: string,
): { ref: string; caption: string } | null {
  const caption = (bubble.content ?? '').trim().slice(0, 40);
  const used = new Set(recentByConv.get(convId) ?? []);
  // Ask for more than one so a recently-used hit still leaves a choice.
  const candidates = pickImages(`photo:${seed}`, RECENT_KEEP + 1, persona.imageTags);
  const ref = candidates.find((r) => !used.has(r)) ?? candidates[0];
  if (!ref) return null;
  remember(convId, ref);
  return { ref, caption };
}

/**
 * Does the pool hold REAL material for these tags (M-J3)?
 *
 * "Real" means a runtime-library photo matching the persona's tags (any
 * library photo when she has none), or — with an empty library — a build-time
 * asset. Placeholder gradients do NOT count: they exist so an unconfigured
 * feed stays populated, and "only placeholders left" is precisely the state
 * where generating a real picture is an upgrade rather than a cost.
 */
export function hasPoolMaterial(tags?: string[]): boolean {
  if (photoPoolIds(tags, true).length > 0) return true;
  return photoPoolIds().length === 0 && hasRealAssets;
}

/**
 * The pool-first, generate-second resolver (M-J3).
 *
 * Priority is deliberate and cost-shaped: a tagged hit in the user's own pool
 * is free and already looks like "her" photos, so it always wins. Only when
 * the pool has nothing real to offer AND a generation endpoint is configured
 * (and passes the 铁律 6 tier gate — `tier` comes from the calling surface,
 * never from here) does a paid generation run, prompted by the model's own
 * description of the picture plus the persona's style words. Every failure
 * falls back to the old pool path; this function upgrades outcomes and never
 * introduces a new way to break a turn.
 */
export async function resolvePhotoOrGenerate(
  bubble: Bubble,
  persona: Pick<PersonaVM, 'contactId' | 'imageTags'>,
  convId: string,
  seed: string,
  tier: NsfwTier,
  now: number,
): Promise<{ ref: string; caption: string } | null> {
  const caption = (bubble.content ?? '').trim().slice(0, 40);
  if (!hasPoolMaterial(persona.imageTags) && caption) {
    const style = persona.imageTags.filter(Boolean).join('、');
    const ref = await generateToLibrary({
      prompt: `一张随手拍的生活照片：${caption}${style ? `。画面风格贴合：${style}` : ''}。真实感、自然光、不要文字水印。`,
      tier,
      now,
      seed,
      tags: persona.imageTags,
    });
    if (ref) {
      remember(convId, ref);
      return { ref, caption };
    }
    // Generation unavailable or failed → the pool path below (which may still
    // resolve to a placeholder, exactly as before this feature existed).
  }
  return resolvePhotoBubble(bubble, persona, convId, seed);
}

/**
 * The instruction that tells the model it CAN send a photo.
 *
 * Only added when there is actually a pool to draw from — advertising a
 * capability she cannot exercise produces image bubbles that all degrade to
 * text, which is worse than never offering it.
 */
export function photoDirective(persona: Pick<PersonaVM, 'imageTags'>): string {
  if (pickImages('probe', 1, persona.imageTags).length === 0) return '';
  return [
    '你也可以发照片：输出 {"type":"image","content":"照片里是什么"}，',
    'content 用一句话描述你想给对方看的东西（例如「刚烤的饼干」「今天的晚霞」）。',
    '别滥用——真人不会每句话都配图，一次对话里最多一张，聊到了才发。',
  ].join('');
}
