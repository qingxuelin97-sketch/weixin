/**
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
import { CallSession, type CallTurn, type CallSessionOpts } from '../../ai/call-script';
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

const patch = (p: Partial<ActiveCallSnapshot>): void => {
  if (!current) return;
  current = { ...current, ...p };
  emit();
};

export interface AdoptCallOpts {
  convId: string;
  peerId: string;
  peerName: string;
  direction: 'in' | 'out';
  video?: boolean;
  /** 群语音 (M-J6c): the pill routes back to /group-call and the grid lights up. */
  group?: boolean;
  /** Everything CallSession needs except the UI callbacks this host owns. */
  sessionOpts?: Omit<CallSessionOpts, 'onLine' | 'onSpeaking' | 'onReady'>;
  /**
   * Alternative constructor for non-single sessions (GroupCallSession): gets
   * the host-wired UI hooks, returns the session. Exactly one of
   * sessionOpts / makeSession must be provided.
   */
  makeSession?: (ui: SessionUiHooks) => HostableCallSession;
  /** Clock for connectedAt when makeSession is used (sessionOpts carries its own). */
  now?: () => number;
}

/**
 * Create the session and take ownership. Returns the snapshot, or the EXISTING
 * one when a call is already live (the page then binds to it — that is the
 * "return from the pill" path, not an error).
 */
export function adoptCall(opts: AdoptCallOpts): ActiveCallSnapshot {
  if (current) return current;
  const ui: SessionUiHooks = {
    onLine: (t) => {
      if (current?.session === session) patch({ subs: [...current.subs, t] });
    },
    onSpeaking: (v) => {
      if (current?.session === session) patch({ speaking: v });
    },
    onSpeakingId: (id) => {
      if (current?.session === session) patch({ speakingId: id });
    },
    onReady: (v) => {
      if (current?.session === session) patch({ voiceOn: v });
    },
  };
  const session: HostableCallSession = opts.makeSession
    ? opts.makeSession(ui)
    : new CallSession({
        ...opts.sessionOpts!,
        onLine: ui.onLine,
        onSpeaking: ui.onSpeaking,
        onReady: ui.onReady,
      });
  current = {
    session,
    convId: opts.convId,
    peerId: opts.peerId,
    peerName: opts.peerName,
    direction: opts.direction,
    video: opts.video ?? false,
    group: opts.group ?? false,
    speakingId: null,
    connectedAt: (opts.sessionOpts?.now ?? opts.now ?? Date.now)(),
    subs: [],
    speaking: false,
    voiceOn: false,
    muted: false,
  };
  emit();
  void session.start().catch((e) => logError('call.session', e));
  return current;
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
