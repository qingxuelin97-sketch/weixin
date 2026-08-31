/**
 * M-J6 通话体验修复 red-guards:
 *   1. barge-in：holdFloor 让她瞬间闭嘴且不结束会话（松手后还能接话）；
 *   2. 句间 TTS 预取：后续句在第一句播放前就已开始合成（消灭句间静默）；
 *   3. 静音：切字幕停留、立即停播、可恢复；
 *   4. call-host：会话活过页面卸载，挂断唯一且只写一条通话记录；
 *   5. 接线扫描：CallPage 卸载不再 end()、按下说话先 holdFloor、壳里挂了胶囊。
 * M-J6b 视频通话 red-guards:
 *   6. video 旗从入口一路活到记录：host 快照带 video、挂断落库 meta.video、
 *      语音通话的记录不带 video 键（投影/气泡不误标）；
 *   7. 投影：模型看到的是「视频通话」不是「语音通话」；
 *   8. 接线扫描：入口是真二选一、胶囊返回带 video、恢复读 host 旗、
 *      VideoStage 禁 rAF、SelfCam 清理停摄像头、manifest 声明 CAMERA。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import 'fake-indexeddb/auto';
import { makePersona } from '../../src/data/persona-defaults';
import { CallSession, type CallTtsBackend } from '../../src/ai/call-script';
import {
  adoptCall,
  getActiveCall,
  hangupActiveCall,
  setCallMuted,
  resetCallHostForTests,
} from '../../src/features/call/call-host';
import { useAppStore } from '../../src/store/appStore';
import type { LlmRouter, RouteRequest } from '../../src/llm/router';
import type { GenerateOptions } from '../../src/llm/types';
import type { ContactVM } from '../../src/data/types';
import { parseBubbles } from '../../src/llm/bubbles';
import { renderMessageBody } from '../../src/ai/render-msg';

const T0 = 1_754_600_000_000;

const peer: ContactVM = {
  id: 'ai_call',
  type: 'ai',
  name: '小雨',
  avatarColor: '#000000',
  avatarText: '雨',
};

function fixedRouter(reply: string): LlmRouter {
  return {
    async complete(_req: RouteRequest, _opts: Omit<GenerateOptions, 'model'>) {
      return { text: reply, finishReason: 'stop' as const, raw: null };
    },
    // CallSession's line generation goes through generate(), not complete().
    async *generate(_req: RouteRequest, _opts: Omit<GenerateOptions, 'model'>) {
      for (const b of parseBubbles(reply)) yield b;
    },
  } as unknown as LlmRouter;
}

/** TTS double whose play() hangs until released — lets a test freeze "mid-line". */
function gatedTts() {
  const log: string[] = [];
  let release: (() => void) | null = null;
  const tts: CallTtsBackend = {
    available: async () => true,
    ensure: async (line: string) => {
      log.push(`ensure:${line}`);
      return { key: `k:${line}`, durationMs: 500 };
    },
    play: async (key: string, onEnded?: () => void) => {
      log.push(`play:${key}`);
      await new Promise<void>((r) => {
        release = () => {
          r();
          onEnded?.();
        };
      });
      return true;
    },
    stop: () => {
      log.push('stop');
      release?.();
      release = null;
    },
  };
  return { tts, log, releaseCurrent: () => release?.() };
}

async function until(cond: () => boolean, ms = 1500): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('until: timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const sessionOpts = (over: Partial<ConstructorParameters<typeof CallSession>[0]> = {}) => ({
  convId: 'conv_lin',
  peer,
  persona: makePersona({ contactId: peer.id, core: '测试', nsfwPermit: false }),
  globalTier: 'off' as const,
  direction: 'out' as const,
  recent: [],
  now: () => T0,
  onLine: () => {},
  router: fixedRouter('{"type":"text","content":"喂"}'),
  pace: () => 0,
  ...over,
});

afterEach(() => {
  resetCallHostForTests();
});

describe('barge-in (holdFloor)', () => {
  it('stops her mid-line WITHOUT ending the session; she can still answer', async () => {
    const { tts, log } = gatedTts();
    const lines: string[] = [];
    const sess = new CallSession(
      sessionOpts({
        tts,
        onLine: (t) => lines.push(`${t.speaker}:${t.text}`),
        router: fixedRouter('{"type":"text","content":"我正说着呢"}'),
      }),
    );
    const started = sess.start();
    // Wait until playback is actually in flight (the gated play logged itself).
    await until(() => log.some((l) => l.startsWith('play:')));

    sess.holdFloor();
    expect(log).toContain('stop');
    await started;

    // NOT ended: a new user line still produces a reply round. Not awaited —
    // the gated play() hangs by design; the onLine callback fires before it.
    const replied = sess.userSaid('等等，先听我说');
    await until(() => lines.some((l) => l.startsWith('self:')));
    await until(() => lines.filter((l) => l.startsWith('peer:')).length >= 1);
    sess.end(); // releases the gate so the dangling round settles
    await replied.catch(() => {});
  });
});

describe('句间预取', () => {
  it('later lines start synthesizing before the first line finishes playing', async () => {
    const { tts, log, releaseCurrent } = gatedTts();
    const sess = new CallSession(
      sessionOpts({
        tts,
        router: fixedRouter(
          '{"type":"text","content":"第一句"}\n{"type":"text","content":"第二句"}',
        ),
      }),
    );
    const started = sess.start();
    // While 第一句 is still gated in play(), 第二句's ensure must already exist.
    await until(() => log.includes('play:k:第一句'));
    await until(() => log.includes('ensure:第二句'));
    releaseCurrent();
    await until(() => log.includes('play:k:第二句'));
    releaseCurrent();
    sess.end();
    await started.catch(() => {});
  });
});

describe('静音', () => {
  it('mute stops current playback and later lines skip TTS entirely', async () => {
    const { tts, log } = gatedTts();
    const sess = new CallSession(sessionOpts({ tts }));
    const started = sess.start();
    await until(() => log.some((l) => l.startsWith('play:')));
    sess.setMuted(true);
    expect(log).toContain('stop');
    await started;
    const playsBefore = log.filter((l) => l.startsWith('play:')).length;
    await sess.userSaid('还在吗');
    // Muted round: subtitle pacing only, zero new play calls.
    expect(log.filter((l) => l.startsWith('play:')).length).toBe(playsBefore);
    expect(sess.isMuted).toBe(true);
    sess.end();
  });
});

describe('call-host owns the live call', () => {
  beforeEach(() => {
    resetCallHostForTests();
  });

  it('adopting twice returns the SAME call (the return-from-pill path)', () => {
    const a = adoptCall({
      convId: 'conv_lin',
      peerId: peer.id,
      peerName: '小雨',
      direction: 'out',
      sessionOpts: sessionOpts(),
    });
    const b = adoptCall({
      convId: 'conv_other',
      peerId: 'x',
      peerName: 'x',
      direction: 'out',
      sessionOpts: sessionOpts({ convId: 'conv_other' }),
    });
    expect(b.session).toBe(a.session);
    expect(getActiveCall()?.convId).toBe('conv_lin');
  });

  it('hangup writes exactly ONE call record and releases the singleton', async () => {
    adoptCall({
      convId: 'conv_lin',
      peerId: peer.id,
      peerName: '小雨',
      direction: 'out',
      sessionOpts: sessionOpts(),
    });
    const before = useAppStore.getState().messagesFor('conv_lin').length;
    await hangupActiveCall();
    await hangupActiveCall(); // double-tap: second finds no owner
    const after = useAppStore
      .getState()
      .messagesFor('conv_lin')
      .filter((m) => m.type === 'call');
    expect(getActiveCall()).toBeNull();
    expect(after.length - before).toBeLessThanOrEqual(1);
    expect(after.length).toBeGreaterThanOrEqual(1);
  });

  it('mute toggling routes through the host (one implementation for page & pill)', () => {
    adoptCall({
      convId: 'conv_lin',
      peerId: peer.id,
      peerName: '小雨',
      direction: 'out',
      sessionOpts: sessionOpts(),
    });
    setCallMuted(true);
    expect(getActiveCall()?.muted).toBe(true);
    expect(getActiveCall()?.session.isMuted).toBe(true);
  });
});

describe('视频通话 (M-J6b)：video 旗从入口活到记录', () => {
  beforeEach(() => {
    resetCallHostForTests();
  });

  it('adoptCall 带 video → 快照带 video → 挂断落库 meta.video === true', async () => {
    adoptCall({
      convId: 'conv_lin',
      peerId: peer.id,
      peerName: '小雨',
      direction: 'out',
      video: true,
      sessionOpts: sessionOpts(),
    });
    expect(getActiveCall()?.video).toBe(true);
    await hangupActiveCall();
    const calls = useAppStore
      .getState()
      .messagesFor('conv_lin')
      .filter((m) => m.type === 'call');
    expect(calls.at(-1)?.meta?.video).toBe(true);
  });

  it('语音通话的记录不带 video 键（投影与气泡不许误标成视频）', async () => {
    adoptCall({
      convId: 'conv_voice',
      peerId: peer.id,
      peerName: '小雨',
      direction: 'out',
      sessionOpts: sessionOpts({ convId: 'conv_voice' }),
    });
    expect(getActiveCall()?.video).toBe(false);
    await hangupActiveCall();
    const calls = useAppStore
      .getState()
      .messagesFor('conv_voice')
      .filter((m) => m.type === 'call');
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect('video' in (calls.at(-1)?.meta ?? {})).toBe(false);
  });

  it('投影区分视频/语音——她能记得你们是视频过还是只打过电话', () => {
    const base = {
      id: 1,
      convId: 'c',
      senderId: 'self',
      type: 'call' as const,
      status: 'sent' as const,
      createdAt: T0,
    };
    expect(
      renderMessageBody({ ...base, meta: { direction: 'out', durationMs: 65_000, video: true } }),
    ).toContain('视频通话');
    expect(
      renderMessageBody({ ...base, meta: { direction: 'out', durationMs: 65_000 } }),
    ).toContain('语音通话');
    expect(renderMessageBody({ ...base, meta: { direction: 'in', video: true } })).toContain(
      '对方打来视频通话',
    );
  });
});

describe('接线扫描（写了没接线 = 没做，接了不该接的也一样）', () => {
  const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

  it('CallPage 卸载不再挂断——会话归 call-host 所有', () => {
    const src = read('src/features/call/CallPage.tsx');
    expect(src).not.toContain('sessionRef.current?.end()');
    expect(src).toContain("from './call-host'");
  });

  it('按下说话的瞬间先 holdFloor（barge-in 不等 ASR 往返）', () => {
    const src = read('src/features/call/CallPage.tsx');
    const down = src.slice(src.indexOf('const onTalkDown'));
    expect(down.slice(0, down.indexOf('startRecording'))).toContain('holdFloor()');
  });

  it('MiniCallPill 挂在应用壳里，且挂断走的是同一个 hangupActiveCall', () => {
    expect(read('src/App.tsx')).toContain('<MiniCallPill />');
    const pill = read('src/features/call/MiniCallPill.tsx');
    expect(pill).toContain('hangupActiveCall');
  });

  it('聊天页「视频通话」入口是真二选一，视频走 ?video=1（M5 起的名实不符到此为止）', () => {
    const src = read('src/features/chat/ChatPage.tsx');
    expect(src).toContain("['视频通话', '语音通话']");
    expect(src).toContain('?video=1');
  });

  it('胶囊返回视频通话时带 video 旗；恢复时 CallPage 还会读 host 的旗兜底', () => {
    expect(read('src/features/call/MiniCallPill.tsx')).toContain('&video=1');
    const page = read('src/features/call/CallPage.tsx');
    expect(page).toContain('getActiveCall()?.video');
  });

  it('VideoStage 禁 rAF（截图门禁只能冻结 CSS/WAAPI），SelfCam 清理必停摄像头', () => {
    const src = read('src/features/call/VideoStage.tsx');
    expect(src).not.toContain('requestAnimationFrame');
    // The cleanup that releases the camera light — losing it means the lens
    // stays hot after hanging up.
    expect(src).toContain('.getTracks().forEach((t) => t.stop())');
  });

  it('manifest 声明 CAMERA——不声明 = WebView 权限请求被系统静默拒绝', () => {
    expect(read('android/app/src/main/AndroidManifest.xml')).toContain(
      'android.permission.CAMERA',
    );
  });
});
