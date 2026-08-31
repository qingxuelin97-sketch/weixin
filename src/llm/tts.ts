/**
 * Text-to-speech via MiniMax T2A. Used to give AI voice messages an actual
 * voice — and, critically, a REAL duration: WeChat's voice bar length is derived
 * from the audio, so estimating from character count falls apart the moment you
 * press play.
 *
 * Model / voice / emotion are all configurable: MiniMax ships new speech model
 * ids every few months, so nothing here is hardcoded past a default.
 *
 * SOURCE (M-J3): where the endpoint+key come from is its own setting
 * (`ttsConfig`, page /settings/tts) instead of「chat 列表里第一个 enabled 的
 * minimax 槽位」— that hard bind meant disabling MiniMax for chat silently
 * struck every persona mute, and `ttsModel` had a reader but no writer.
 *
 * NSFW note: explicit text must never be sent to MiniMax (mainland endpoint with
 * input auditing). The engine is responsible for not calling this on a full-tier
 * turn; see specs/nsfw.md.
 */
import { httpJson } from './http';
import { LlmError } from './types';
import { getSecret, hasSecret } from '../lib/keystore';
import { recordUsage } from '../lib/usage';
import { repo } from '../db/repo';

export interface TtsOptions {
  text: string;
  /** MiniMax voice id, e.g. 'male-qn-qingse' / 'female-shaonv'. */
  voiceId?: string;
  emotion?: string;
  speed?: number;
  signal?: AbortSignal;
}

export interface TtsResult {
  /** Raw audio bytes (mp3). */
  audio: ArrayBuffer;
  /** True audio duration in ms, as reported by the API. */
  durationMs: number;
  format: string;
}

export const DEFAULT_TTS_MODEL = 'speech-02-hd';
export const DEFAULT_VOICE = 'female-shaonv';

/** Voices offered in the persona editor. Ids are MiniMax system voices. */
export const VOICE_OPTIONS: Array<{ id: string; label: string }> = [
  { id: 'female-shaonv', label: '少女音' },
  { id: 'female-yujie', label: '御姐音' },
  { id: 'female-tianmei', label: '甜美女声' },
  { id: 'male-qn-qingse', label: '青涩男声' },
  { id: 'male-qn-jingying', label: '精英男声' },
  { id: 'audiobook_male_1', label: '磁性男声' },
  { id: 'audiobook_female_1', label: '温柔女声' },
];

interface T2aResponse {
  data?: { audio?: string; status?: number };
  extra_info?: { audio_length?: number; audio_format?: string };
  base_resp?: { status_code?: number; status_msg?: string };
}

/** Hex string (MiniMax returns hex-encoded audio) → ArrayBuffer. */
function hexToBuffer(hex: string): ArrayBuffer {
  const clean = hex.trim();
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  }
  const buf = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buf).set(bytes);
  return buf;
}

/* ------------------------------------------------------------------ */
/* Source resolution (M-J3): TTS is no longer chained to the chat list */
/* ------------------------------------------------------------------ */

/** The settings row key. The row stores a TtsConfigVM — never a key (rule #2). */
export const TTS_SETTING = 'ttsConfig';

/** Keystore alias for the standalone key mode. */
export const TTS_STANDALONE_ALIAS = 'key_tts_standalone';

export const DEFAULT_TTS_BASE = 'https://api.minimaxi.com/v1';

/**
 * Where TTS gets its endpoint and key from.
 *
 * `provider` — reuse a chat slot's stored key (by id, EXPLICITLY: the slot's
 * `enabled` flag means "use for chat" and is deliberately ignored here — the
 * old code required an *enabled* minimax slot, so disabling MiniMax for chat
 * silently struck every persona mute).
 * `standalone` — an independent key under its own alias, for users whose TTS
 * account is not their chat account (or who have no MiniMax chat slot at all).
 */
export interface TtsConfigVM {
  source: 'provider' | 'standalone';
  /** Chat slot id when source === 'provider'. */
  providerId?: string;
  /** Endpoint for standalone mode; defaults to the MiniMax base. */
  baseUrl?: string;
}

export async function getTtsConfig(): Promise<TtsConfigVM | null> {
  const cfg = await repo.getSetting<TtsConfigVM>(TTS_SETTING);
  if (!cfg || (cfg.source !== 'provider' && cfg.source !== 'standalone')) return null;
  return cfg;
}

export async function saveTtsConfig(cfg: TtsConfigVM): Promise<void> {
  await repo.putSetting(TTS_SETTING, cfg);
}

export async function clearTtsConfig(): Promise<void> {
  await repo.putSetting(TTS_SETTING, null);
}

interface ResolvedTts {
  baseUrl: string;
  keyAlias: string;
  /** For the settings page's status line. */
  label: string;
}

/**
 * Resolve which endpoint+alias a synthesis call will use, WITHOUT reading the
 * key itself. Order:
 *   1. explicit `ttsConfig` (provider binding or standalone key);
 *   2. legacy zero-config fallback: any MiniMax chat slot that has a stored
 *      key — enabled ones first, but a DISABLED slot still counts, which is
 *      the fix for「关掉 MiniMax 聊天就静默失声」(its key exists; only the
 *      chat routing opted out).
 * Null = genuinely unconfigured.
 */
export async function resolveTtsSource(): Promise<ResolvedTts | null> {
  const cfg = await getTtsConfig();
  if (cfg?.source === 'standalone') {
    return {
      baseUrl: (cfg.baseUrl ?? '').trim() || DEFAULT_TTS_BASE,
      keyAlias: TTS_STANDALONE_ALIAS,
      label: '独立密钥',
    };
  }
  const providers = await repo.getProviders();
  if (cfg?.source === 'provider' && cfg.providerId) {
    const p = providers.find((x) => x.id === cfg.providerId);
    // A bound slot that was deleted falls through to the legacy scan rather
    // than erroring forever on a ghost id.
    if (p) return { baseUrl: p.baseUrl, keyAlias: p.keyAlias, label: p.label };
  }
  const mm = [...providers]
    .filter((p) => p.kind === 'minimax')
    .sort((a, b) => Number(b.enabled) - Number(a.enabled))
    .find((p) => hasSecret(p.keyAlias));
  return mm ? { baseUrl: mm.baseUrl, keyAlias: mm.keyAlias, label: mm.label } : null;
}

/**
 * Whether TTS is usable right now (a resolvable source with a stored key).
 * Callers use this to degrade gracefully instead of throwing on every voice line.
 */
export async function isTtsAvailable(): Promise<boolean> {
  const src = await resolveTtsSource();
  if (!src) return false;
  return Boolean(await getSecret(src.keyAlias));
}

/**
 * Synthesize speech. Throws LlmError if no TTS source is configured or the
 * call fails — callers should catch and fall back to a silent voice bubble.
 */
export async function synthesize(opts: TtsOptions): Promise<TtsResult> {
  const src = await resolveTtsSource();
  if (!src) throw new LlmError('auth', 'TTS 未配置（设置 → 语音合成）', 401, 'tts');
  const key = await getSecret(src.keyAlias);
  if (!key) throw new LlmError('auth', 'TTS 密钥未保存', 401, 'tts');

  const model = (await repo.getSetting<string>('ttsModel')) ?? DEFAULT_TTS_MODEL;
  const base = src.baseUrl.replace(/\/$/, '');

  // Paid call, per synthesis attempt (cache hits never reach here) — M-J3.
  void recordUsage('tts', Date.now()).catch(() => {});

  const res = await httpJson({
    url: `${base}/t2a_v2`,
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: {
      model,
      text: opts.text,
      stream: false,
      voice_setting: {
        voice_id: opts.voiceId || DEFAULT_VOICE,
        speed: opts.speed ?? 1,
        vol: 1,
        pitch: 0,
        ...(opts.emotion ? { emotion: opts.emotion } : {}),
      },
      audio_setting: { sample_rate: 32000, bitrate: 128000, format: 'mp3', channel: 1 },
    },
    signal: opts.signal,
    timeoutMs: 45_000,
  });

  const data = res.data as T2aResponse;
  const code = data?.base_resp?.status_code;
  if (code && code !== 0) {
    // 1026/1027 are MiniMax's input/output content-audit codes.
    const kind = code === 1026 || code === 1027 ? 'content_filter' : 'unknown';
    throw new LlmError(kind, data.base_resp?.status_msg ?? `TTS 失败 (${code})`, code, 'tts');
  }
  const hex = data?.data?.audio;
  if (!hex) throw new LlmError('bad_response', 'TTS 未返回音频', res.status, 'tts');

  return {
    audio: hexToBuffer(hex),
    durationMs: Math.round(data.extra_info?.audio_length ?? 0),
    format: data.extra_info?.audio_format ?? 'mp3',
  };
}
