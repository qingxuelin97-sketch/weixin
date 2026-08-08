/**
 * Voice message audio: content-addressed cache + playback.
 *
 * Synthesis is charged per call, so audio is keyed by hash(voice + text + params)
 * — resending the same line costs nothing. Playback is a single shared element so
 * a new voice message stops the previous one, like the real app.
 */
import { idbGet, idbPut, idbGetAll, idbDelete } from '../db/idb';
import { synthesize, isTtsAvailable, DEFAULT_VOICE } from '../llm/tts';

/**
 * Cache ceiling. The store only ever grew (every voice line ≈ tens of KB of
 * MP3, forever); past the cap the oldest clips are evicted — they re-synthesize
 * from text on demand, so eviction costs money-later rather than space-now.
 */
const TTS_CACHE_MAX = 200;

export async function trimTtsCache(max = TTS_CACHE_MAX): Promise<void> {
  try {
    const rows = await idbGetAll<CachedAudio>('tts_cache');
    if (rows.length <= max) return;
    rows.sort((a, b) => a.createdAt - b.createdAt);
    for (const row of rows.slice(0, rows.length - max)) await idbDelete('tts_cache', row.key);
  } catch {
    /* eviction is best-effort */
  }
}

interface CachedAudio {
  key: string;
  blob: Blob;
  durationMs: number;
  createdAt: number;
}

/** Stable non-crypto hash for the cache key (FNV-1a, hex). */
export function audioKey(text: string, voiceId: string, emotion?: string): string {
  const s = `${voiceId}|${emotion ?? ''}|${text}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `tts_${(h >>> 0).toString(16)}_${s.length}`;
}

/**
 * Get (or synthesize and cache) the audio for a line.
 * @returns the cache key and real duration, or null when TTS isn't configured.
 */
export async function ensureVoiceAudio(
  text: string,
  voiceId = DEFAULT_VOICE,
  emotion?: string,
): Promise<{ key: string; durationMs: number } | null> {
  const key = audioKey(text, voiceId, emotion);
  const hit = await idbGet<CachedAudio>('tts_cache', key);
  if (hit) return { key, durationMs: hit.durationMs };

  if (!(await isTtsAvailable())) return null;
  try {
    const res = await synthesize({ text, voiceId, emotion });
    const blob = new Blob([res.audio], { type: 'audio/mpeg' });
    // Trust the API's duration; fall back to a length estimate if it's missing.
    const durationMs = res.durationMs || Math.min(text.length * 220, 60_000);
    await idbPut('tts_cache', { key, blob, durationMs, createdAt: Date.now() } satisfies CachedAudio);
    void trimTtsCache(); // fire-and-forget eviction keeps the store bounded
    return { key, durationMs };
  } catch {
    return null; // silent bubble beats a broken message flow
  }
}

let current: HTMLAudioElement | null = null;
let currentUrl: string | null = null;

/** Stop whatever voice message is playing. */
export function stopVoice(): void {
  if (current) {
    current.pause();
    current = null;
  }
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
    currentUrl = null;
  }
}

/**
 * Play a cached voice clip.
 * @returns true if playback started, false if the audio isn't in the cache.
 */
export async function playVoice(key: string, onEnded?: () => void): Promise<boolean> {
  const row = await idbGet<CachedAudio>('tts_cache', key);
  if (!row) return false;
  stopVoice();
  const url = URL.createObjectURL(row.blob);
  const el = new Audio(url);
  current = el;
  currentUrl = url;
  el.addEventListener('ended', () => {
    stopVoice();
    onEnded?.();
  });
  try {
    await el.play();
    return true;
  } catch {
    stopVoice();
    return false;
  }
}
