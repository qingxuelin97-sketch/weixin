/**
 * Voice message audio: content-addressed cache + playback.
 *
 * Synthesis is charged per call, so audio is keyed by hash(voice + text + params)
 * — resending the same line costs nothing. Playback is a single shared element so
 * a new voice message stops the previous one, like the real app.
 */
import { idbGet, idbPut, idbGetAll, idbDelete } from '../db/idb';
import { repo } from '../db/repo';
// 已知债（M-J0 依赖方向上锁时既存）：TTS 合成器住在 llm/（它就是一次 provider 调用），
// 而缓存+播放住在 lib/。按 §1 该是 llm→lib，这条是反着的。搬家会动 features 里所有
// 调用方，不属于门禁地基期的改动范围——先逐条豁免，欠据在此。
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
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
/**
 * In-flight dedup: the engine prefetches while playback awaits the same line —
 * without this the cache-miss window (synthesis is a multi-second round trip)
 * fires a SECOND paid synthesize() for identical text. Same key → same promise.
 */
const inFlight = new Map<string, Promise<{ key: string; durationMs: number } | null>>();

export function ensureVoiceAudio(
  text: string,
  voiceId = DEFAULT_VOICE,
  emotion?: string,
): Promise<{ key: string; durationMs: number } | null> {
  const key = audioKey(text, voiceId, emotion);
  const pending = inFlight.get(key);
  if (pending) return pending;

  const p = (async (): Promise<{ key: string; durationMs: number } | null> => {
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
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, p);
  return p;
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

/* ==================================================================== */
/* 用户语音消息 (M-J7a)                                                  */
/* ==================================================================== */

// 录音剪辑与 TTS 缓存是两种东西：TTS 行可以随时从文本重合成（可逐出、不进
// 备份），你亲口说的话丢了就是丢了。所以剪辑住媒体库（kind 'voice'，随备份
// 走、不参加 tts_cache 的逐出），播放复用同一个共享 <audio>（新的一条开播
// 就停上一条，和真微信一致）。走 repo 而不是直打 idb——换 SQLite 驱动时
// 这条路径不能是断的。

/** 保存一段录音进媒体库，返回消息可携带的 `idb:<id>` 引用。 */
export async function saveVoiceClip(blob: Blob, durationMs: number): Promise<string> {
  const id = crypto.randomUUID();
  await repo.putMedia({
    id,
    kind: 'voice',
    tags: [],
    mime: blob.type || 'audio/webm',
    blob,
    createdAt: Date.now(),
    ...(durationMs > 0 ? { durationMs } : {}),
  });
  return `idb:${id}`;
}

/** 按引用取回剪辑的 Blob（转文字用）。 */
export async function voiceClipBlob(ref: string): Promise<Blob | undefined> {
  if (!ref.startsWith('idb:')) return undefined;
  const row = await repo.getMediaItem(ref.slice(4));
  return row?.blob;
}

/**
 * 播放一段用户录音（`idb:<id>` 引用）。与 playVoice 共享停止语义：
 * stopVoice() 对两者都生效，两条语音不会叠着响。
 */
export async function playVoiceRef(ref: string, onEnded?: () => void): Promise<boolean> {
  const blob = await voiceClipBlob(ref);
  if (!blob) return false;
  stopVoice();
  const url = URL.createObjectURL(blob);
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
