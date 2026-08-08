/**
 * In-memory registry: media-library id → object URL (+ metadata for pool
 * selection). Zero imports on purpose — Avatar (components/) and the ref
 * resolver (data/) read it synchronously, while the async side (store
 * hydration, the media library page) populates it from the Repo.
 *
 * Object URLs are process-lifetime here: entries are registered once at
 * startup / import time and revoked only when the underlying item is deleted,
 * so there is no per-render churn to leak.
 */

export interface RegisteredMedia {
  url: string;
  kind: 'avatar' | 'photo';
  tags: string[];
}

const registry = new Map<string, RegisteredMedia>();

export function registerMedia(id: string, entry: RegisteredMedia): void {
  const prev = registry.get(id);
  if (prev && prev.url !== entry.url) URL.revokeObjectURL(prev.url);
  registry.set(id, entry);
}

export function unregisterMedia(id: string): void {
  const prev = registry.get(id);
  if (prev) URL.revokeObjectURL(prev.url);
  registry.delete(id);
}

export function getMediaUrl(id: string): string | undefined {
  return registry.get(id)?.url;
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

/** Snapshot list for pickers/library grids (insertion order = import order). */
export function listRegisteredMedia(
  kind?: RegisteredMedia['kind'],
): Array<{ id: string } & RegisteredMedia> {
  const out: Array<{ id: string } & RegisteredMedia> = [];
  for (const [id, m] of registry) {
    if (!kind || m.kind === kind) out.push({ id, ...m });
  }
  return out;
}
