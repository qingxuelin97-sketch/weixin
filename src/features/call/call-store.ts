/**
 * 通话的**状态**一半 (M-K10 续 / K5 时拆出)：当前那通电话的快照、订阅、静音、挂断。
 *
 * 为什么从 call-host 里拆出来：悬浮胶囊 MiniCallPill 常驻在 App 壳里，它只需要
 * 「现在有没有一通电话、挂断」——但它 import 的 call-host 静态挂着 CallSession
 * 的构造（./call-script，含整套通话剧本与目标系统），于是 23KB 的通话引擎跟着
 * 一个什么都不画的胶囊进了冷启动。现在胶囊只依赖这里；开始通话的 adoptCall 留在
 * call-host（只有懒加载的两个通话页用它）。call-host 原样 re-export 本文件，
 * 既有调用方与测试一个字不用改。
 *
 * 以下是 call-host 原有的所有权说明，仍然成立：
 *
 * The live call's OWNER (M-J6 最小化悬浮窗).
 *
 * Until now the CallSession lived inside CallPage's effect: navigating away
 * unmounted the component, the cleanup called end(), and the call simply
 * ceased to exist — you could not check a message mid-call without hanging up
 * on her. The session now lives HERE, a module singleton exactly like the
 * engine's in-flight map; CallPage merely renders it, and a floating pill
 * (MiniCallPill, mounted in the app shell) represents it everywhere else.
 *
 * Ownership rules:
 *  - at most ONE live call (adoptCall replaces nothing — it refuses while one
 *    is live; the ring guard in useSchedulerRuntime already prevents stacking);
 *  - hangup is the ONLY way a call ends (page button or pill button — both run
 *    the same hangupActiveCall), and it writes the call record + summary stamp
 *    exactly once;
 *  - snapshots are immutable: every mutation replaces `current`, so
 *    useSyncExternalStore consumers re-render without tearing (the zustand
 *    selector trap does not apply — the snapshot IS the stable reference).
 */
import { useSyncExternalStore } from 'react';
import type { CallTurn } from '../../ai/call-script';
import type { NsfwTier } from '../../llm/router';
import { useAppStore } from '../../store/appStore';
import { logError } from '../../lib/errlog';

/**
 * What the host (and both call pages) need from a live session — CallSession
 * and GroupCallSession both satisfy it structurally. The host never cares
 * which one it holds; hangup/mute/barge-in are one code path either way.
 */
export interface HostableCallSession {
  readonly turns: CallTurn[];
  readonly tier: NsfwTier;
  readonly isMuted: boolean;
  voiceOn: boolean;
  start(): Promise<void>;
  holdFloor(): void;
  setMuted(m: boolean): void;
  userSaid(text: string): Promise<void>;
  finalize(): Promise<string>;
  end(): void;
}

/** The UI callbacks the host owns; `makeSession` receives them pre-wired. */
export interface SessionUiHooks {
  onLine: (turn: CallTurn) => void;
  onSpeaking: (speaking: boolean) => void;
  /** 群语音 (M-J6c): who is talking (grid highlight); single calls never call it. */
  onSpeakingId: (id: string | null) => void;
  onReady: (voiceOn: boolean) => void;
}

export interface ActiveCallSnapshot {
  session: HostableCallSession;
  convId: string;
  peerId: string;
  peerName: string;
  direction: 'in' | 'out';
  /** 视频通话 (M-J6b): drives the record label and the return-URL from the pill. */
  video: boolean;
  /** 群语音 (M-J6c): picks the pill's return route (/group-call vs /call). */
  group: boolean;
  /** Group only: who is talking right now (avatar-grid highlight). */
  speakingId: string | null;
  /** epoch ms of connect — the pill's ticking clock derives from this. */
  connectedAt: number;
  subs: readonly CallTurn[];
  speaking: boolean;
  voiceOn: boolean;
  muted: boolean;
}

let current: ActiveCallSnapshot | null = null;
const listeners = new Set<() => void>();
const emit = () => {
  for (const l of listeners) l();
};

export function getActiveCall(): ActiveCallSnapshot | null {
  return current;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** React binding. Null when no call is live. */
export function useActiveCall(): ActiveCallSnapshot | null {
  return useSyncExternalStore(subscribe, getActiveCall, getActiveCall);
}

/** 内部写口：只给同目录的 call-host（adoptCall）用。 */
export const patchActiveCall = (p: Partial<ActiveCallSnapshot>): void => {
  if (!current) return;
  current = { ...current, ...p };
  emit();
};
const patch = patchActiveCall;

/** 内部写口：adoptCall 装上新会话时调用。 */
export function installActiveCall(snap: ActiveCallSnapshot): void {
  current = snap;
  emit();
}

/** The mute toggle, from page or pill — one implementation. */
export function setCallMuted(m: boolean): void {
  if (!current) return;
  current.session.setMuted(m);
  patch({ muted: m });
}

/**
 * Hang up, from WHEREVER — page button, pill button. Ends the session (which
 * runs its idempotent finalize), writes the call record through the ordinary
 * message path, stamps the summary onto it when the finalize resolves, and
 * releases the singleton. Safe to call twice: the second call finds no owner.
 */
export async function hangupActiveCall(): Promise<void> {
  const snap = current;
  if (!snap) return;
  current = null;
  emit();
  const s = useAppStore.getState();
  const durationMs = Math.max(0, Date.now() - snap.connectedAt);
  const hadTurns = snap.session.turns.length > 0;
  snap.session.end();
  try {
    const saved = await s.appendMessage({
      convId: snap.convId,
      senderId: snap.direction === 'in' ? snap.peerId : 'self',
      type: 'call',
      meta: { direction: snap.direction, durationMs, ...(snap.video ? { video: true } : {}) },
      status: 'sent',
      createdAt: Date.now(),
    });
    if (hadTurns) {
      // Fire-and-forget: a failed summary loses a nicety, never the record.
      void (async () => {
        try {
          const summary = await snap.session.finalize();
          if (summary) await s.updateMessage({ ...saved, meta: { ...saved.meta, summary } });
        } catch (e) {
          logError('call.finalize', e);
        }
      })();
    }
  } catch (e) {
    // Losing the record is bad; a call nobody can leave is worse.
    logError('call.record', e);
  }
}

/** Test hook — the singleton must not leak between cases. */
export function resetCallHostForTests(): void {
  current?.session.end();
  current = null;
  emit();
}
