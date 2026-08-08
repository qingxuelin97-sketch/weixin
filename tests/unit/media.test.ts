import { describe, it, expect, beforeEach } from 'vitest';
import { encodeMediaRows, decodeMediaRow } from '../../src/lib/backup';
import {
  registerMedia,
  unregisterMedia,
  getMediaUrl,
  photoPoolIds,
  listRegisteredMedia,
} from '../../src/data/media-registry';
import { pickImages, resolveImageRef } from '../../src/data/moments-images';

describe('media backup round-trip', () => {
  it('blob → blobB64 → blob preserves bytes and mime', async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 255, 137, 80, 78, 71]);
    const row = {
      id: 'm1',
      kind: 'photo',
      tags: ['美食'],
      mime: 'image/png',
      blob: new Blob([bytes], { type: 'image/png' }),
      createdAt: 123,
    };
    const [encoded] = await encodeMediaRows([row]);
    // The Blob itself must be gone (JSON would husk it into {} — the H3 class of bug).
    expect((encoded as { blob?: unknown }).blob).toBeUndefined();
    expect(typeof (encoded as { blobB64?: string }).blobB64).toBe('string');
    expect(JSON.parse(JSON.stringify(encoded))).toEqual(encoded); // JSON-safe

    const decoded = decodeMediaRow(JSON.parse(JSON.stringify(encoded))) as {
      blob: Blob;
      id: string;
      tags: string[];
    };
    expect(decoded.id).toBe('m1');
    expect(decoded.tags).toEqual(['美食']);
    expect(decoded.blob.type).toBe('image/png');
    expect(new Uint8Array(await decoded.blob.arrayBuffer())).toEqual(bytes);
  });

  it('rows without a blob pass through decode unchanged', () => {
    const row = { id: 'x', tags: [] };
    expect(decodeMediaRow(row)).toBe(row);
  });
});

describe('media registry + tagged image pools', () => {
  beforeEach(() => {
    for (const m of listRegisteredMedia()) unregisterMedia(m.id);
  });

  it('registers, resolves and unregisters', () => {
    registerMedia('a', { url: 'blob:a', kind: 'avatar', tags: [] });
    expect(getMediaUrl('a')).toBe('blob:a');
    expect(resolveImageRef('idb:a').url).toBe('blob:a');
    unregisterMedia('a');
    expect(getMediaUrl('a')).toBeUndefined();
    // A dangling ref renders as a stable placeholder, not a broken image.
    expect(resolveImageRef('idb:a').background).toBeTruthy();
  });

  it('photoPoolIds filters by tag and excludes avatars', () => {
    registerMedia('p1', { url: 'blob:1', kind: 'photo', tags: ['美食'] });
    registerMedia('p2', { url: 'blob:2', kind: 'photo', tags: ['风景'] });
    registerMedia('av', { url: 'blob:3', kind: 'avatar', tags: [] });
    expect(photoPoolIds(['美食'])).toEqual(['p1']);
    expect(photoPoolIds()).toEqual(['p1', 'p2']);
  });

  it('a tag filter matching nothing falls back to the whole pool', () => {
    registerMedia('p1', { url: 'blob:1', kind: 'photo', tags: ['美食'] });
    expect(photoPoolIds(['健身'])).toEqual(['p1']);
  });

  it('pickImages draws idb refs deterministically from the tagged pool', () => {
    registerMedia('p1', { url: 'blob:1', kind: 'photo', tags: ['美食'] });
    registerMedia('p2', { url: 'blob:2', kind: 'photo', tags: ['美食'] });
    registerMedia('p3', { url: 'blob:3', kind: 'photo', tags: ['风景'] });
    const a = pickImages('seed-1', 2, ['美食']);
    const b = pickImages('seed-1', 2, ['美食']);
    expect(a).toEqual(b); // same seed → same pictures (replay invariant)
    for (const ref of a) {
      expect(ref.startsWith('idb:')).toBe(true);
      expect(['idb:p1', 'idb:p2']).toContain(ref);
    }
  });
});
