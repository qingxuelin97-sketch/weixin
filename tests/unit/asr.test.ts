import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * M-I9 ASR (按住说话) — transport, config, and wiring guards.
 *
 * The three red-flip guarantees demanded by the plan:
 *   1. the composer mic button really imports the ASR module (stub killed);
 *   2. the native-bridge upload path rejects BOUNDEDLY when the bridge hangs
 *      (the constitution-trap "timeout must be a real rejection");
 *   3. with no config, behavior is predictable: a typed not_configured error
 *      and ZERO network attempts.
 */

/* ------------------------------------------------------------------ */
/* Module mocks: settings row + keystore, in-memory                    */
/* ------------------------------------------------------------------ */

const settings = new Map<string, unknown>();
const secrets = new Map<string, string>();

// Passthrough mock: replacing this module WHOLESALE drops its non-repo
// exports (REL_PAIR_SEP, SETTINGS_KEY_CASCADE…), and a consumer importing
// one of those then breaks the whole module graph — which surfaces as an
// unrelated test returning nothing at all rather than as a missing export.
vi.mock('../../src/db/repo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/db/repo')>()),
  repo: {
    getSetting: async (k: string) => settings.get(k),
    putSetting: async (k: string, v: unknown) => {
      settings.set(k, v);
    },
  },
}));

vi.mock('../../src/lib/keystore', () => ({
  getSecret: async (alias: string) => secrets.get(alias) ?? null,
  hasSecret: (alias: string) => secrets.has(alias),
  setSecret: async (alias: string, v: string) => {
    secrets.set(alias, v);
  },
  deleteSecret: (alias: string) => {
    secrets.delete(alias);
  },
}));

// The native bridge: default behavior is the pathological device case — a
// call that NEVER settles. Individual tests override per-call.
const bridgeRequest = vi.fn(() => new Promise<never>(() => {}));
vi.mock('@capacitor/core', () => ({
  CapacitorHttp: { request: bridgeRequest },
}));

import {
  ASR_PRESETS,
  ASR_SETTING,
  asrPresetToConfig,
  getAsrConfig,
  saveAsrConfig,
  clearAsrConfig,
  isAsrReady,
  transcribe,
  transcribeWith,
  parseTranscription,
  cleanupTranscript,
  fileNameFor,
  makeSilentWav,
  blobToBase64,
  friendlyAsrError,
  AsrError,
  type AsrConfigVM,
} from '../../src/llm/asr';

type G = { Capacitor?: { isNativePlatform?: () => boolean } };

const CFG: AsrConfigVM = {
  kind: 'siliconflow',
  label: 'SiliconFlow',
  baseUrl: 'https://asr.example.test/v1',
  model: 'FunAudioLLM/SenseVoiceSmall',
  keyAlias: 'key_asr_siliconflow',
  language: 'zh',
};

const clip = () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/webm' });

const realFetch = globalThis.fetch;

beforeEach(() => {
  settings.clear();
  secrets.clear();
  bridgeRequest.mockReset();
  bridgeRequest.mockImplementation(() => new Promise<never>(() => {}));
});

afterEach(() => {
  delete (globalThis as G).Capacitor;
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */
/* Presets & config                                                    */
/* ------------------------------------------------------------------ */

describe('presets and config persistence', () => {
  it('ships the three first-class presets, all https, all with a default model', () => {
    for (const kind of ['siliconflow', 'openai', 'groq']) {
      const p = ASR_PRESETS[kind];
      expect(p, `preset ${kind} missing`).toBeTruthy();
      expect(p.baseUrl.startsWith('https://')).toBe(true);
      expect(p.models.length).toBeGreaterThan(0);
    }
  });

  it('asrPresetToConfig: keyAlias is per-kind and NEVER carries a key (rule #2)', () => {
    const c = asrPresetToConfig('groq');
    expect(c.keyAlias).toBe('key_asr_groq');
    expect(JSON.stringify(c)).not.toMatch(/sk-/);
    // Unknown kind degrades to a blank custom slot, not a throw.
    expect(asrPresetToConfig('nope').kind).toBe('custom');
  });

  it('save → get roundtrip; malformed rows read as "not configured"', async () => {
    expect(await getAsrConfig()).toBeNull();
    await saveAsrConfig(CFG);
    expect(await getAsrConfig()).toEqual(CFG);
    settings.set(ASR_SETTING, { garbage: true });
    expect(await getAsrConfig()).toBeNull();
    await saveAsrConfig(CFG);
    await clearAsrConfig();
    expect(await getAsrConfig()).toBeNull();
  });

  it('isAsrReady = config + endpoint + model + saved key, nothing less', async () => {
    expect(await isAsrReady()).toBe(false);
    await saveAsrConfig(CFG);
    expect(await isAsrReady()).toBe(false); // no key yet
    secrets.set(CFG.keyAlias, 'k');
    expect(await isAsrReady()).toBe(true);
    await saveAsrConfig({ ...CFG, model: ' ' });
    expect(await isAsrReady()).toBe(false); // blank model
  });
});

/* ------------------------------------------------------------------ */
/* No config → predictable, zero network                               */
/* ------------------------------------------------------------------ */

describe('unconfigured behavior', () => {
  it('transcribe throws not_configured and never touches the network', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await expect(transcribe(clip())).rejects.toMatchObject({
      name: 'AsrError',
      kind: 'not_configured',
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(bridgeRequest).not.toHaveBeenCalled();
  });

  it('config without a saved key is still not_configured (alias ≠ key)', async () => {
    await saveAsrConfig(CFG);
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await expect(transcribe(clip())).rejects.toMatchObject({ kind: 'not_configured' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('not_configured has a friendly line pointing at settings', () => {
    const msg = friendlyAsrError(new AsrError('not_configured', 'x'));
    expect(msg).toContain('设置');
  });
});

/* ------------------------------------------------------------------ */
/* Web transport                                                       */
/* ------------------------------------------------------------------ */

function okFetch(body: unknown, status = 200) {
  return vi.fn(async () => ({
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  })) as unknown as typeof fetch;
}

describe('web multipart upload', () => {
  beforeEach(async () => {
    await saveAsrConfig(CFG);
    secrets.set(CFG.keyAlias, 'real-key');
  });

  it('POSTs multipart to <base>/audio/transcriptions with bearer auth', async () => {
    const spy = okFetch({ text: ' 你好 呀 ' });
    globalThis.fetch = spy;
    const text = await transcribe(clip());
    expect(text).toBe('你好 呀');
    const [url, init] = (spy as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string>; body: FormData },
    ];
    expect(url).toBe('https://asr.example.test/v1/audio/transcriptions');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer real-key');
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.body.get('model')).toBe(CFG.model);
    expect(init.body.get('language')).toBe('zh');
    const f = init.body.get('file') as File;
    expect(f.name).toBe('speech.webm');
  });

  it('a trailing slash on baseUrl does not double the path', async () => {
    await saveAsrConfig({ ...CFG, baseUrl: 'https://asr.example.test/v1/' });
    const spy = okFetch({ text: 'ok' });
    globalThis.fetch = spy;
    await transcribe(clip());
    const [url] = (spy as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string];
    expect(url).toBe('https://asr.example.test/v1/audio/transcriptions');
  });

  it('hanging web fetch rejects with timeout around the deadline, not never', async () => {
    globalThis.fetch = vi.fn(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((_res, rej) => {
          init?.signal?.addEventListener('abort', () => rej(new DOMException('x', 'AbortError')));
        }),
    ) as unknown as typeof fetch;
    const t0 = Date.now();
    await expect(transcribe(clip(), { timeoutMs: 80 })).rejects.toMatchObject({ kind: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it('caller abort surfaces as aborted, not as a network lie', async () => {
    globalThis.fetch = vi.fn(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise((_res, rej) => {
          init?.signal?.addEventListener('abort', () => rej(new DOMException('x', 'AbortError')));
        }),
    ) as unknown as typeof fetch;
    const ctrl = new AbortController();
    const p = transcribe(clip(), { signal: ctrl.signal, timeoutMs: 30_000 });
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ kind: 'aborted' });
  });
});

/* ------------------------------------------------------------------ */
/* Response / error mapping                                            */
/* ------------------------------------------------------------------ */

describe('parseTranscription', () => {
  it('maps statuses to kinds', () => {
    expect(() => parseTranscription(401, {})).toThrowError(
      expect.objectContaining({ kind: 'auth' }),
    );
    expect(() => parseTranscription(403, {})).toThrowError(
      expect.objectContaining({ kind: 'auth' }),
    );
    expect(() => parseTranscription(429, {})).toThrowError(
      expect.objectContaining({ kind: 'rate_limit' }),
    );
    expect(() => parseTranscription(500, {})).toThrowError(
      expect.objectContaining({ kind: 'server' }),
    );
    expect(() => parseTranscription(400, { error: 'bad audio' })).toThrowError(
      expect.objectContaining({ kind: 'bad_response' }),
    );
  });

  it('accepts { text } and bare-string bodies; rejects shapeless 2xx', () => {
    expect(parseTranscription(200, { text: 'hi' })).toBe('hi');
    expect(parseTranscription(200, '早上好')).toBe('早上好');
    expect(() => parseTranscription(200, { transcript: 'x' })).toThrowError(
      expect.objectContaining({ kind: 'bad_response' }),
    );
  });

  it('empty text for silence is a VALID result, not an error', () => {
    expect(parseTranscription(200, { text: '  ' })).toBe('');
  });

  it('cleanupTranscript strips SenseVoice event tags and squeezes whitespace', () => {
    expect(cleanupTranscript('<|zh|><|NEUTRAL|><|Speech|> 早上 好  ')).toBe('早上 好');
    expect(cleanupTranscript('a\n b')).toBe('a\nb');
  });

  it('every AsrError kind has a human line and raw provider text stays off it', () => {
    const kinds = [
      'not_configured',
      'auth',
      'rate_limit',
      'timeout',
      'network',
      'server',
      'aborted',
    ] as const;
    for (const k of kinds) {
      const line = friendlyAsrError(new AsrError(k, 'raw provider blob'));
      expect(line.length).toBeGreaterThan(1);
      if (k !== 'not_configured') expect(line).not.toContain('raw provider blob');
    }
  });
});

/* ------------------------------------------------------------------ */
/* Native bridge fallback — THE trap test                              */
/* ------------------------------------------------------------------ */

describe('native bridge fallback', () => {
  beforeEach(async () => {
    (globalThis as G).Capacitor = { isNativePlatform: () => true };
    await saveAsrConfig(CFG);
    secrets.set(CFG.keyAlias, 'real-key');
  });

  it('rejects BOUNDEDLY when fetch fails and the bridge never settles', async () => {
    // The exact real-device pathology: web channel down, plugin call hung.
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    const t0 = Date.now();
    await expect(transcribe(clip(), { timeoutMs: 80 })).rejects.toMatchObject({
      name: 'AsrError',
    });
    // Around the deadline — never the 30s default, and NEVER forever. This is
    // the constitution trap: the race partner must actually reject.
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(bridgeRequest).toHaveBeenCalledTimes(1);
  });

  it('bridge fallback sends dataType formData with a base64 audio entry', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    bridgeRequest.mockImplementation(
      async () => ({ status: 200, data: { text: '桥到了' } }) as never,
    );
    const text = await transcribe(clip(), { timeoutMs: 5_000 });
    expect(text).toBe('桥到了');
    const opts = (bridgeRequest.mock.calls[0] as unknown[])[0] as {
      url: string;
      dataType: string;
      headers: Record<string, string>;
      data: Array<Record<string, string>>;
    };
    expect(opts.url).toBe('https://asr.example.test/v1/audio/transcriptions');
    expect(opts.dataType).toBe('formData');
    expect(opts.headers.Authorization).toBe('Bearer real-key');
    const file = opts.data.find((e) => e.key === 'file');
    expect(file?.type).toBe('base64File');
    expect(file?.value).toBe(await blobToBase64(clip()));
    expect(opts.data.find((e) => e.key === 'model')?.value).toBe(CFG.model);
  });

  it('protocol-level web answers (401) do NOT fall through to the bridge', async () => {
    globalThis.fetch = okFetch({ error: 'bad key' }, 401);
    await expect(transcribe(clip())).rejects.toMatchObject({ kind: 'auth' });
    // The bytes reached the server; re-uploading over the bridge would only
    // re-bill the same verdict.
    expect(bridgeRequest).not.toHaveBeenCalled();
  });

  it('web-only environments never touch the bridge at all', async () => {
    delete (globalThis as G).Capacitor;
    globalThis.fetch = okFetch({ text: 'ok' });
    await transcribe(clip());
    expect(bridgeRequest).not.toHaveBeenCalled();
  });
});

/* ------------------------------------------------------------------ */
/* Probe helpers                                                       */
/* ------------------------------------------------------------------ */

describe('probe helpers', () => {
  it('makeSilentWav is deterministic, RIFF-headed, and clock-free', async () => {
    const a = makeSilentWav();
    const b = makeSilentWav();
    expect(a.size).toBe(b.size);
    const bytesA = new Uint8Array(await a.arrayBuffer());
    const bytesB = new Uint8Array(await b.arrayBuffer());
    expect(bytesA).toEqual(bytesB);
    expect(String.fromCharCode(...bytesA.subarray(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...bytesA.subarray(8, 12))).toBe('WAVE');
    // 240ms @16kHz mono 16-bit + 44B header
    expect(a.size).toBe(44 + 16_000 * 0.24 * 2);
  });

  it('fileNameFor picks an extension providers can sniff', () => {
    expect(fileNameFor('audio/webm;codecs=opus')).toBe('speech.webm');
    expect(fileNameFor('audio/mp4')).toBe('speech.m4a');
    expect(fileNameFor('audio/wav')).toBe('speech.wav');
    expect(fileNameFor('')).toBe('speech.webm');
  });

  it('blobToBase64 survives blobs past the call-stack chunk boundary', async () => {
    const big = new Uint8Array(0x8000 * 2 + 17).map((_, i) => i % 251);
    const b64 = await blobToBase64(new Blob([big]));
    const round = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    expect(round).toEqual(big);
  });

  it('transcribeWith lets the settings page test a draft config directly', async () => {
    globalThis.fetch = okFetch({ text: 'probe ok' });
    const text = await transcribeWith(CFG, 'draft-key', makeSilentWav(), { timeoutMs: 5_000 });
    expect(text).toBe('probe ok');
  });
});

/* ------------------------------------------------------------------ */
/* Wiring guards (转红清单)                                            */
/* ------------------------------------------------------------------ */

const root = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

describe('I9 wiring: the stub is dead and the layers are connected', () => {
  const chatPage = read('src/features/chat/ChatPage.tsx');
  const voiceInput = read('src/features/chat/VoiceInput.tsx');
  const asrSrc = read('src/llm/asr.ts');
  const app = read('src/App.tsx');
  const settingsPage = read('src/features/settings/SettingsPage.tsx');

  it('composer mic button imports the ASR UI — the stub toast is gone', () => {
    expect(
      chatPage.includes("from './VoiceInput'"),
      'ChatPage 必须挂载 VoiceInputButton——写了没接线 = 没做',
    ).toBe(true);
    expect(
      chatPage.includes('语音输入暂未开放'),
      '「语音输入暂未开放」stub 还活着——I9 的第一条转红就是杀掉它',
    ).toBe(false);
    expect(voiceInput.includes("from '../../llm/asr'")).toBe(true);
    expect(voiceInput.includes("from '../../lib/recorder'")).toBe(true);
  });

  it('the recording overlay registers with the dismiss stack', () => {
    expect(
      voiceInput.includes('useDismissable('),
      '录音浮层必须进 dismiss 栈，否则硬件返回键会从录音底下退出聊天页',
    ).toBe(true);
  });

  it('no rAF loops in the hold-to-talk UI (screenshot-gate constraint)', () => {
    expect(voiceInput.includes('requestAnimationFrame')).toBe(false);
    expect(read('src/features/chat/voice-input.css').includes('animation')).toBe(true);
  });

  it('asr.ts wraps the uninterruptible bridge call in raceDeadline', () => {
    expect(
      /raceDeadline\(\s*\n?\s*native\.request\(/.test(asrSrc),
      '原生桥的超时必须是 raceDeadline（会 reject 的定时器）——陷阱清单原文',
    ).toBe(true);
    // And it reuses the shared, tested one — not a private re-derivation.
    expect(asrSrc.includes("import { nativeHttp, raceDeadline } from './http'")).toBe(true);
  });

  it('settings entry and route exist', () => {
    expect(app.includes('/settings/asr')).toBe(true);
    expect(settingsPage.includes("navigate('/settings/asr')")).toBe(true);
  });

  it('no key material patterns anywhere in the new modules (rule #2)', () => {
    for (const src of [asrSrc, voiceInput, read('src/features/settings/AsrConfigPage.tsx')]) {
      expect(/sk-[A-Za-z0-9]{8}/.test(src)).toBe(false);
    }
  });
});
