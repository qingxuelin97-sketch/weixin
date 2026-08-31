/**
 * On-demand materialization of media object URLs (M-G1).
 *
 * Hydration registers metadata for the whole library but only materializes
 * avatars, because an object URL pins its blob until revoked and doing that for
 * every photo is how an Android WebView runs out of memory. Everything else is
 * loaded here, when something is actually about to draw it.
 *
 * `resolveImageRef` already renders a stable placeholder gradient for a ref it
 * cannot resolve, so the first paint is never broken — it is a placeholder that
 * becomes the photo a moment later.
 */
import { repo } from '../db/repo';
import { materializeMedia, unmaterialized } from '../data/media-registry';
import { logError } from './errlog';

/** Extract the media ids from a list of refs, ignoring `img:`/`ph:` forms. */
export function idbRefIds(refs: ReadonlyArray<string | undefined>): string[] {
  const out: string[] = [];
  for (const r of refs) {
    if (r?.startsWith('idb:')) out.push(r.slice(4));
  }
  return out;
}

/**
 * Load and materialize any of these ids that are not already live.
 *
 * Returns how many were newly materialized, so a caller can skip its re-render
 * when nothing changed. Never throws: a missing blob means the placeholder
 * stays, which is a cosmetic outcome, not a broken screen.
 */
export async function primeMedia(ids: readonly string[]): Promise<number> {
  const missing = unmaterialized([...new Set(ids)]);
  if (missing.length === 0) return 0;
  let n = 0;
  await Promise.all(
    missing.map(async (id) => {
      try {
        const item = await repo.getMediaItem(id);
        if (item?.blob && materializeMedia(id, item.blob)) n++;
      } catch (e) {
        logError('media.prime', e);
      }
    }),
  );
  return n;
}
