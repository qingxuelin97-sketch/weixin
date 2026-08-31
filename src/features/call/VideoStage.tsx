/**
 * 视频通话的"画面" (M-J6b).
 *
 * Honest fakery: there is no video of her, so the stage COMPOSES one — her
 * avatar photo blown up full-bleed with a slow Ken Burns drift, a breathing
 * scale, a speaking glow synced to the TTS pipeline, and a vignette/grain
 * layer that reads as a phone camera in a dim room. All CSS animations on
 * transform/opacity only (禁 rAF — the screenshot gate can freeze CSS/WAAPI,
 * and a JS-driven loop would flicker every golden that ever mounts this).
 *
 * Your own camera is REAL (getUserMedia PiP, front lens). Camera failure or
 * denial degrades to a quiet placeholder card — never an error screen; the
 * call itself is the point and it works without any camera at all.
 */
import { useEffect, useRef, useState } from 'react';
import type { ContactVM } from '../../data/types';
import { useMedia } from '../../components/useMedia';
import { resolveImageRef } from '../../data/moments-images';
import { logError } from '../../lib/errlog';

export function PeerStage({ peer, speaking }: { peer: ContactVM; speaking: boolean }) {
  // useMedia only PRIMES the lazy registry (and re-renders on materialize);
  // the URL itself comes from resolveImageRef — same split as Avatar.
  useMedia([peer.avatarRef]);
  const url = peer.avatarRef ? resolveImageRef(peer.avatarRef).url : undefined;
  return (
    <div className={`vstage${speaking ? ' vstage--speaking' : ''}`} aria-hidden>
      {url ? (
        <img className="vstage__img" src={url} alt="" />
      ) : (
        <div className="vstage__fallback" style={{ background: peer.avatarColor }}>
          <span>{peer.avatarText}</span>
        </div>
      )}
      <div className="vstage__vignette" />
      <div className="vstage__grain" />
      <div className="vstage__glow" />
    </div>
  );
}

export function SelfCam({ on }: { on: boolean }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!on) return;
    let stream: MediaStream | null = null;
    let dead = false;
    setFailed(false);
    void navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: 'user' }, audio: false })
      .then((s) => {
        if (dead) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        const el = videoRef.current;
        if (el) {
          el.srcObject = s;
          void el.play().catch(() => {});
        }
      })
      .catch((e) => {
        if (!dead) setFailed(true);
        logError('call.selfcam', e);
      });
    return () => {
      // Stopping the tracks is what releases the camera; the <video> element
      // unmounts with this component (`!on` renders null), so no ref cleanup.
      dead = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [on]);

  if (!on) return null;
  return (
    <div className="selfcam">
      {failed ? (
        <div className="selfcam__off">摄像头不可用</div>
      ) : (
        <video ref={videoRef} muted playsInline className="selfcam__video" />
      )}
    </div>
  );
}
