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

/**
 * 隐藏会话闸门必须成对 (M-I18).
 *
 * `a96c0e8` gated `/chat/:convId` and stopped there. `/chat/:convId/info` names
 * both AI↔AI participants, their group nicknames and the member grid — a
 * hand-typed URL showed the user a private conversation they must never learn
 * exists. A route pair that shares a `convId` shares the gate.
 */
describe('聊天路由的隐藏会话闸门', () => {
  const repoRoot = join(__dirname, '..', '..');
  const src = (p: string) => readFileSync(join(repoRoot, p), 'utf8');

  for (const page of ['src/features/chat/ChatPage.tsx', 'src/features/chat/ChatInfoPage.tsx']) {
    it(`${page} refuses a hidden conversation`, () => {
      expect(src(page)).toMatch(/if \(!conv \|\| conv\.isHidden\)/);
    });

    it(`${page} says 会话不存在, never 「不可查看」`, () => {
      // Admitting the thread exists is itself the leak, so the refusal must be
      // indistinguishable from a bad id. Judged on CODE only: both files
      // discuss the alternative wording in prose, and a guard that reads its
      // own rationale as a violation is worse than no guard.
      const code = src(page)
        .split('\n')
        .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
        .join('\n');
      expect(code).toContain('会话不存在');
      expect(code).not.toContain('不可查看');
    });
  }
});

/** 未读口径只有一份 (M-I18): the widget was a fourth copy, missing 免打扰. */
describe('未读总数只有一个实现', () => {
  it('the widget uses lib/unread rather than summing by hand', () => {
    const w = readFileSync(join(__dirname, '..', '..', 'src/native/widget-sync.ts'), 'utf8');
    expect(w).toContain("from '../lib/unread'");
    expect(w).toContain('totalUnread(visible)');
    // The hand-rolled reduce is what silently dropped the 免打扰 half.
    expect(w).not.toMatch(/reduce\(\(sum, c\) => sum \+ \(c\.unreadCount/);
  });
});
