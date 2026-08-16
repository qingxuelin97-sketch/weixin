import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { transcribe, AsrError, ASR_SETTING, type AsrConfigVM } from '../../src/llm/asr';
import { repo } from '../../src/db/repo';

/**
 * 铁律 6 has an INBOUND face too (M-I18).
 *
 * The rule was enforced in one direction only: the router refuses to send
 * full-tier prompts to a domestic official endpoint. But speech is the same
 * context travelling the other way — in a full-tier call the user's own words
 * are uploaded verbatim to whatever ASR endpoint is configured, and ASR does
 * not go through the router, so nothing checked it at all.
 *
 * The gate is a declaration, not a guess: an endpoint receives full-tier audio
 * only if the user marked it `nsfwSafe`. Undeclared means no.
 */
const CFG: AsrConfigVM = {
  kind: 'siliconflow',
  label: 'SiliconFlow',
  baseUrl: 'https://api.siliconflow.cn/v1',
  model: 'FunAudioLLM/SenseVoiceSmall',
  keyAlias: 'key_asr_test',
  language: 'zh',
};

vi.mock('../../src/lib/keystore', () => ({
  getSecret: async () => 'sk-test',
  hasSecret: async () => true,
  setSecret: async () => {},
  deleteSecret: async () => {},
}));

const clip = () => new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' });

describe('ASR 入站 tier 闸门', () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await repo.putSetting(ASR_SETTING, CFG);
  });

  it('refuses full-tier speech on an endpoint that was never declared safe', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(transcribe(clip(), { tier: 'full' })).rejects.toMatchObject({
      kind: 'tier_blocked',
    });
    // The point is that the bytes never left the device.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allows full-tier speech once the user declares the endpoint permissive', async () => {
    await repo.putSetting(ASR_SETTING, { ...CFG, nsfwSafe: true });
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(JSON.stringify({ text: '听到了' }), { status: 200 }));
    await expect(transcribe(clip(), { tier: 'full' })).resolves.toBe('听到了');
    expect(fetchSpy).toHaveBeenCalled();
  });

  it('leaves the ordinary tiers alone', async () => {
    // A fresh Response per call: a body can only be read once, and this test
    // deliberately transcribes twice.
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => new Response(JSON.stringify({ text: 'ok' }), { status: 200 }));
    await expect(transcribe(clip(), { tier: 'ambiguous' })).resolves.toBe('ok');
    await expect(transcribe(clip(), {})).resolves.toBe('ok');
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('reports the block as its own error kind, not a generic failure', () => {
    expect(new AsrError('tier_blocked', 'x').kind).toBe('tier_blocked');
  });
});

/**
 * Both microphones must pass the tier down. A push-to-talk surface that calls
 * `transcribe(clip)` with no tier is indistinguishable from a safe one at the
 * gate — this is the grep that keeps a future surface from quietly opting out.
 */
describe('每个按住说话的入口都把 tier 传下去', () => {
  const ROOT = join(__dirname, '..', '..');
  const CALLERS = ['src/features/chat/VoiceInput.tsx', 'src/features/call/CallPage.tsx'];

  for (const rel of CALLERS) {
    it(`${rel} passes tier into transcribe`, () => {
      const src = readFileSync(join(ROOT, rel), 'utf8');
      const call = /transcribe\(([^)]*)\)/.exec(src);
      expect(call, 'no transcribe() call found').toBeTruthy();
      expect(call![1]).toMatch(/tier/);
    });
  }
});

/**
 * A hidden AI↔AI DM must render as "does not exist" — not as a thread, and not
 * as "you may not view this" either, since acknowledging it exists IS the tell.
 * `/chat/:convId` is reachable from a deep link (the allowlist passes any id by
 * design — it is a pure parser with no store access), so the guard lives at the
 * render surface every entry path funnels through.
 */
describe('隐藏会话不能被路由直接渲染', () => {
  it('ChatPage refuses a hidden conversation the same way it refuses a missing one', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src/features/chat/ChatPage.tsx'), 'utf8');
    expect(src).toMatch(/if \(!conv \|\| conv\.isHidden\)/);
    // And the refusal text must not distinguish the two cases.
    const branch = src.slice(src.indexOf('if (!conv || conv.isHidden)'));
    expect(branch.slice(0, 400)).toContain('会话不存在');
    expect(branch.slice(0, 400)).not.toMatch(/不可查看|无权|隐藏/);
  });
});
