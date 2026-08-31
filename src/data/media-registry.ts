/**
 * In-memory registry: media-library id → metadata, plus a bounded cache of
 * live object URLs. Zero imports on purpose — Avatar (components/) and the ref
 * resolver (data/) read it synchronously, while the async side (store
 * hydration, the media library page) populates it from the Repo.
 *
 * WHY THE URL CACHE IS BOUNDED (M-G1):
 *
 * `URL.createObjectURL` pins its Blob in memory until the URL is revoked. This
 * registry used to be handed an object URL for EVERY item at startup — the
 * store read the whole media table and looped `createObjectURL` over it — and
 * revoked one only when its item was deleted. A library of 500 photos at 2 MB
 * therefore pinned about a gigabyte for the life of the process, which on an
 * Android WebView is not a slow leak but a kill.
 *
 * So metadata (kind, tags — what pool selection needs) is registered for
 * everything and costs nothing, while URLs are materialized on demand and the
 * least-recently-used ones are released once `MAX_LIVE_URLS` is exceeded.
 * Releasing is safe: `resolveImageRef` already degrades to a placeholder
 * gradient for an unresolvable ref, and `primeMedia` brings it back.
 */

export interface RegisteredMedia {
  url: string;
  kind: 'avatar' | 'photo' | 'sticker';
  tags: string[];
}

interface Entry {
  kind: 'avatar' | 'photo' | 'sticker';
  tags: string[];
  /** Live object URL, or undefined when not currently materialized. */
  url?: string;
  /** Monotonic counter for LRU eviction; only meaningful when `url` is set. */
  touched: number;
}

/**
 * How many object URLs may be live at once.
 *
 * Sized for "everything on screen plus a few screens of scrollback", not for
 * the whole library. Avatars are exempt (see `materializeMedia`): they are
 * small, few, and read on every list row, so evicting them would trade a
 * memory problem for a flicker problem.
 */
export const MAX_LIVE_URLS = 80;

const registry = new Map<string, Entry>();
let clock = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

/**
 * Re-render hook for lazily materialized images. A component that draws media
 * subscribes, so a URL that arrives after first paint replaces its placeholder.
 */
export function subscribeMedia(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Register what an item IS, without paying for a URL. */
export function registerMediaMeta(
  id: string,
  meta: { kind: 'avatar' | 'photo' | 'sticker'; tags: string[] },
): void {
  const prev = registry.get(id);
  registry.set(id, { ...meta, url: prev?.url, touched: prev?.touched ?? 0 });
}

/** Register an item that already has a URL (fresh import — the blob is in hand). */
export function registerMedia(id: string, entry: RegisteredMedia): void {
  const prev = registry.get(id);
  if (prev?.url && prev.url !== entry.url) URL.revokeObjectURL(prev.url);
  registry.set(id, { kind: entry.kind, tags: entry.tags, url: entry.url, touched: ++clock });
  evict();
  notify();
}

/** Give a registered item a live URL from its blob. Idempotent. */
export function materializeMedia(id: string, blob: Blob): string | undefined {
  const e = registry.get(id);
  if (!e) return undefined;
  if (e.url) {
    e.touched = ++clock;
    return e.url;
  }
  e.url = URL.createObjectURL(blob);
  e.touched = ++clock;
  evict();
  notify();
  return e.url;
}

/** Which of these ids still need their blob read? */
export function unmaterialized(ids: readonly string[]): string[] {
  return ids.filter((id) => {
    const e = registry.get(id);
    return e != null && e.url == null;
  });
}

/**
 * Release least-recently-used photo URLs down to the cap.
 *
 * Avatars are never evicted: a handful of small images that every conversation
 * row draws, so dropping them would mean visible flicker on every scroll for
 * no meaningful memory saving. Stickers (M-I15) are exempt for the same
 * reason — small, few, redrawn on every composer open.
 */
function evict(): void {
  const live = [...registry.entries()].filter(([, e]) => e.url && e.kind === 'photo');
  if (live.length <= MAX_LIVE_URLS) return;
  live.sort((a, b) => a[1].touched - b[1].touched);
  for (const [, e] of live.slice(0, live.length - MAX_LIVE_URLS)) {
    if (e.url) URL.revokeObjectURL(e.url);
    e.url = undefined;
  }
}

export function unregisterMedia(id: string): void {
  const prev = registry.get(id);
  if (prev?.url) URL.revokeObjectURL(prev.url);
  registry.delete(id);
  notify();
}

export function getMediaUrl(id: string): string | undefined {
  const e = registry.get(id);
  if (!e?.url) return undefined;
  e.touched = ++clock;
  return e.url;
}

/** All registered photo-pool ids, optionally narrowed to items matching any of `tags`. */
export function photoPoolIds(tags?: string[]): string[] {
  const ids: string[] = [];
  const want = tags?.filter(Boolean) ?? [];
  for (const [id, m] of registry) {
    if (m.kind !== 'photo') continue;
    if (want.length && !m.tags.some((t) => want.includes(t))) continue;
    ids.push(id);
  }
  // A tag filter that matches nothing falls back to the whole pool — an empty
  // result would silently turn the persona's Moments into text-only forever.
  if (want.length && ids.length === 0) return photoPoolIds();
  return ids;
}

export function registeredCount(): number {
  return registry.size;
}

/**
 * Snapshot list for pickers/library grids (insertion order = import order).
 *
 * `url` is '' for anything not currently materialized; callers draw the
 * placeholder for those and call `primeMedia` to fill them in.
 */
export function listRegisteredMedia(
  kind?: RegisteredMedia['kind'],
): Array<{ id: string } & RegisteredMedia> {
  const out: Array<{ id: string } & RegisteredMedia> = [];
  for (const [id, m] of registry) {
    if (!kind || m.kind === kind) out.push({ id, url: m.url ?? '', kind: m.kind, tags: m.tags });
  }
  return out;
}
