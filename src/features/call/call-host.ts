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
import { CallSession } from '../../ai/call-script';
import { logError } from '../../lib/errlog';
import {
  installActiveCall,
  patchActiveCall,
  getActiveCall,
  type ActiveCallSnapshot,
  type HostableCallSession,
  type SessionUiHooks,
} from './call-store';
import type { CallSessionOpts } from '../../ai/call-script';

// 状态一半住在 ./call-store（悬浮胶囊只依赖它，见那边的头注释）；这里 re-export，
// 让 CallPage / GroupCallPage / 测试照旧从 call-host 拿到全部。
export * from './call-store';

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
  const live = getActiveCall();
  if (live) return live;
  const ui: SessionUiHooks = {
    onLine: (t) => {
      const c = getActiveCall();
      if (c?.session === session) patchActiveCall({ subs: [...c.subs, t] });
    },
    onSpeaking: (v) => {
      if (getActiveCall()?.session === session) patchActiveCall({ speaking: v });
    },
    onSpeakingId: (id) => {
      if (getActiveCall()?.session === session) patchActiveCall({ speakingId: id });
    },
    onReady: (v) => {
      if (getActiveCall()?.session === session) patchActiveCall({ voiceOn: v });
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
  const snap: ActiveCallSnapshot = {
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
  installActiveCall(snap);
  void session.start().catch((e) => logError('call.session', e));
  return snap;
}

