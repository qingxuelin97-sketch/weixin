/**
 * 按住说话 — WeChat hold-to-talk voice input (M-I9).
 *
 * The mic button inside the composer pill. Press and hold → full-screen
 * recording overlay (dark scrim, green waveform bubble, slide-up-to-cancel);
 * release → transcribe via the configured ASR provider → the text lands in
 * the INPUT BOX for editing, it is never auto-sent (WeChat's 转文字 behavior,
 * and the safer default for a model-written message).
 *
 * Hard constraints honored here:
 *   - the waveform is pure CSS keyframes — no rAF loops (the screenshot gate
 *     can only freeze CSS/WAAPI; a wiring test greps this file for the API);
 *   - the overlay registers with the dismiss stack, so the hardware back
 *     button cancels a recording instead of navigating under it;
 *   - colors are tokens only;
 *   - every failure path degrades to a toast — no recording support, no ASR
 *     config, permission denied, transcription error — the composer never
 *     breaks, it just tells you why.
 *
 * Gesture model: pointer capture on the button keeps move/up events flowing
 * to us even though the finger is over the overlay, so there are zero
 * document-level listeners to leak.
 */
import { useRef, useState } from 'react';
import type * as React from 'react';
import { IconMicSmall } from '../../components/icons';
import { useDismissable } from '../../app/useDismissable';
import { useAppStore } from '../../store/appStore';
import { isRecordingSupported, startRecording, RecorderError, type RecordingHandle } from '../../lib/recorder';
import { transcribe, isAsrReady, friendlyAsrError, AsrError } from '../../llm/asr';
import './voice-input.css';

/** Drag up at least this far (px) to arm slide-to-cancel, like the device. */
const CANCEL_DRAG_PX = 90;
/** Clips shorter than this are almost always accidental taps. */
const MIN_CLIP_MS = 600;
/** WeChat caps a voice press at 60s; the recorder auto-stops there. */
const MAX_CLIP_MS = 60_000;

type Phase = 'idle' | 'starting' | 'recording' | 'transcribing';

export interface VoiceInputButtonProps {
  /** Receives the recognized text; the caller appends it to the draft. */
  onText: (text: string) => void;
}

export function VoiceInputButton({ onText }: VoiceInputButtonProps) {
  const showToast = useAppStore((s) => s.showToast);
  const [phase, setPhase] = useState<Phase>('idle');
  const [cancelArmed, setCancelArmed] = useState(false);
  const [elapsedS, setElapsedS] = useState(0);

  /** Mutable per-press state; a ref so pointer handlers never see stale closures. */
  const press = useRef<{
    id: number;
    startY: number;
    startedAt: number;
    released: boolean;
    cancelled: boolean;
    handle: RecordingHandle | null;
    ticker: ReturnType<typeof setInterval> | null;
    abort: AbortController | null;
  } | null>(null);

  const phaseRef = useRef<Phase>('idle');
  const setPhaseBoth = (p: Phase) => {
    phaseRef.current = p;
    setPhase(p);
  };

  const cleanupPress = () => {
    const p = press.current;
    if (p?.ticker) clearInterval(p.ticker);
    press.current = null;
    setCancelArmed(false);
    setElapsedS(0);
    setPhaseBoth('idle');
  };

  /** Abandon everything (slide-up cancel, back button, pointercancel). */
  const cancelAll = () => {
    const p = press.current;
    if (p) {
      p.cancelled = true;
      p.handle?.cancel();
      p.abort?.abort();
    }
    cleanupPress();
  };

  // Hardware back while the overlay is up = cancel the recording, stay on the page.
  useDismissable(phase !== 'idle', cancelAll);

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (phaseRef.current !== 'idle') return;
    e.preventDefault();
    // Keep the whole gesture on this element — no document listeners.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture is best-effort; move/up still bubble here in tests */
    }

    if (!isRecordingSupported()) {
      // Graceful stub degradation: environments without MediaRecorder keep a
      // predictable, honest message instead of a broken gesture.
      showToast('当前环境不支持录音，语音输入不可用');
      return;
    }

    const p = {
      id: e.pointerId,
      startY: e.clientY,
      startedAt: Date.now(),
      released: false,
      cancelled: false,
      handle: null as RecordingHandle | null,
      ticker: null as ReturnType<typeof setInterval> | null,
      abort: null as AbortController | null,
    };
    press.current = p;
    setPhaseBoth('starting');

    void (async () => {
      // Check config BEFORE claiming the mic: recording 30s only to learn it
      // can't be transcribed is the worst possible order of operations.
      let ready = false;
      try {
        ready = await isAsrReady();
      } catch {
        ready = false;
      }
      if (press.current !== p || p.released || p.cancelled) return;
      if (!ready) {
        showToast('先在 设置 → 语音输入 里配置识别服务');
        cleanupPress();
        return;
      }
      try {
        const handle = await startRecording({
          maxMs: MAX_CLIP_MS,
          onAutoStop: () => {
            // Cap hit while still holding: finish as if the finger lifted.
            if (press.current === p && !p.released) void finishPress(p);
          },
        });
        if (press.current !== p || p.released || p.cancelled) {
          // Finger already lifted while we were asking for permission.
          handle.cancel();
          if (press.current === p) cleanupPress();
          return;
        }
        p.handle = handle;
        p.startedAt = Date.now();
        p.ticker = setInterval(() => {
          setElapsedS(Math.min(60, Math.floor((Date.now() - p.startedAt) / 1000)));
        }, 250);
        setPhaseBoth('recording');
      } catch (err) {
        if (press.current === p) cleanupPress();
        showToast(err instanceof RecorderError ? err.message : '录音启动失败');
      }
    })();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const p = press.current;
    if (!p || e.pointerId !== p.id || phaseRef.current === 'transcribing') return;
    setCancelArmed(p.startY - e.clientY > CANCEL_DRAG_PX);
  };

  const finishPress = async (p: NonNullable<typeof press.current>) => {
    if (p.released) return;
    p.released = true;

    if (phaseRef.current === 'starting' || !p.handle) {
      // Lifted before the mic even opened — a tap. Teach the gesture.
      cleanupPress();
      showToast('按住说话，松开转文字');
      return;
    }
    if (p.ticker) {
      clearInterval(p.ticker);
      p.ticker = null;
    }

    const heldMs = Date.now() - p.startedAt;
    if (heldMs < MIN_CLIP_MS) {
      p.handle.cancel();
      cleanupPress();
      showToast('说话时间太短');
      return;
    }

    setPhaseBoth('transcribing');
    const abort = new AbortController();
    p.abort = abort;
    try {
      const clip = await p.handle.stop();
      if (p.cancelled) return;
      const text = await transcribe(clip, { signal: abort.signal });
      if (p.cancelled) return;
      if (text) onText(text);
      else showToast('没有听清，再试一次？');
    } catch (err) {
      if (!p.cancelled && !(err instanceof AsrError && err.kind === 'aborted')) {
        showToast(friendlyAsrError(err));
      }
    } finally {
      if (press.current === p) cleanupPress();
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const p = press.current;
    if (!p || e.pointerId !== p.id || phaseRef.current === 'transcribing') return;
    // Re-derive from the event too: a fast flick can deliver its last move and
    // the up in one React batch, where `cancelArmed` state is one frame stale.
    if (cancelArmed || p.startY - e.clientY > CANCEL_DRAG_PX) {
      cancelAll();
      return;
    }
    void finishPress(p);
  };

  const onPointerCancel = (e: React.PointerEvent<HTMLButtonElement>) => {
    const p = press.current;
    if (!p || e.pointerId !== p.id) return;
    // The system stole the gesture (edge swipe, notification shade) — a
    // recording nobody can release must not keep the mic hot.
    cancelAll();
  };

  const overlayUp = phase === 'recording' || phase === 'transcribing';

  return (
    <>
      <button
        className="composer__mic"
        aria-label="语音输入"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onContextMenu={(e) => e.preventDefault()}
        style={{ touchAction: 'none' }}
      >
        <IconMicSmall />
      </button>

      {overlayUp && (
        <div className={`vrec${cancelArmed ? ' vrec--cancel' : ''}`} aria-live="polite">
          {phase === 'recording' ? (
            <>
              <div className="vrec__stage">
                <div className="vrec__bubble">
                  <div className="vrec__wave" aria-hidden>
                    {WAVE_BARS.map((i) => (
                      <span key={i} className="vrec__bar" style={{ ['--i' as string]: i }} />
                    ))}
                  </div>
                  {elapsedS >= 50 && <span className="vrec__count">{60 - elapsedS}s</span>}
                </div>
              </div>
              <div className="vrec__cancelzone">
                <span className="vrec__cancel-blob" aria-hidden>
                  ×
                </span>
                <span className="vrec__cancel-hint">{cancelArmed ? '松开手指，取消发送' : '上滑取消'}</span>
              </div>
              <div className="vrec__talkzone">
                <span className="vrec__talk-label">{cancelArmed ? '松开 取消' : '松开 转文字'}</span>
              </div>
            </>
          ) : (
            <div className="vrec__stage">
              <div className="vrec__bubble vrec__bubble--busy">
                <span className="vrec__transcribing">
                  转写中
                  <span className="vrec__dot" />
                  <span className="vrec__dot" />
                  <span className="vrec__dot" />
                </span>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** 13 bars, symmetric stagger — enough to read as a live waveform. */
const WAVE_BARS = Array.from({ length: 13 }, (_, i) => i);
