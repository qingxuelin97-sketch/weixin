/**
 * Text-to-speech via MiniMax T2A. Used to give AI voice messages an actual
 * voice — and, critically, a REAL duration: WeChat's voice bar length is derived
 * from the audio, so estimating from character count falls apart the moment you
 * press play.
 *
 * Model / voice / emotion are all configurable: MiniMax ships new speech model
 * ids every few months, so nothing here is hardcoded past a default.
 *
 * NSFW note: explicit text must never be sent to MiniMax (mainland endpoint with
 * input auditing). The engine is responsible for not calling this on a full-tier
 * turn; see specs/nsfw.md.
 */
import { httpJson } from './http';
import { LlmError } from './types';
import { getSecret } from '../lib/keystore';
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

/**
 * Whether TTS is usable right now (a MiniMax provider exists with a stored key).
 * Callers use this to degrade gracefully instead of throwing on every voice line.
 */
export async function isTtsAvailable(): Promise<boolean> {
  const providers = await repo.getProviders();
  const mm = providers.find((p) => p.kind === 'minimax' && p.enabled);
  if (!mm) return false;
  return Boolean(await getSecret(mm.keyAlias));
}

/**
 * Synthesize speech. Throws LlmError if MiniMax isn't configured or the call
 * fails — callers should catch and fall back to a silent voice bubble.
 */
export async function synthesize(opts: TtsOptions): Promise<TtsResult> {
  const providers = await repo.getProviders();
  const mm = providers.find((p) => p.kind === 'minimax' && p.enabled);
  if (!mm) throw new LlmError('auth', 'MiniMax provider 未配置', 401, 'minimax');
  const key = await getSecret(mm.keyAlias);
  if (!key) throw new LlmError('auth', 'MiniMax 密钥未设置', 401, mm.id);

  const model = (await repo.getSetting<string>('ttsModel')) ?? DEFAULT_TTS_MODEL;
  const base = mm.baseUrl.replace(/\/$/, '');

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
    throw new LlmError(kind, data.base_resp?.status_msg ?? `TTS 失败 (${code})`, code, mm.id);
  }
  const hex = data?.data?.audio;
  if (!hex) throw new LlmError('bad_response', 'TTS 未返回音频', res.status, mm.id);

  return {
    audio: hexToBuffer(hex),
    durationMs: Math.round(data.extra_info?.audio_length ?? 0),
    format: data.extra_info?.audio_format ?? 'mp3',
  };
}
