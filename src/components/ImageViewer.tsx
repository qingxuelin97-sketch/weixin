/**
 * Full-screen image viewer (V1 promise "图片查看" finally made real). WeChat
 * gestures, minimum viable set: tap anywhere closes, double-tap toggles 2×
 * zoom, swipe down closes, swipe left/right pages through `refs`.
 */
import { useRef, useState } from 'react';
import { resolveImageRef } from '../data/moments-images';
import { useDismissable } from '../app/useDismissable';
import './image-viewer.css';

interface ImageViewerProps {
  refs: string[];
  index: number;
  onClose: () => void;
}

export function ImageViewer({ refs, index, onClose }: ImageViewerProps) {
  const [i, setI] = useState(Math.min(Math.max(index, 0), refs.length - 1));
  const [zoomed, setZoomed] = useState(false);
  // Mounted = open (callers render it conditionally), so back closes the viewer.
  useDismissable(true, onClose);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const lastTap = useRef(0);

  const { url, background } = resolveImageRef(refs[i] ?? '');

  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    touch.current = { x: t.clientX, y: t.clientY };
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const start = touch.current;
    touch.current = null;
    if (!start || zoomed) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - start.x;
    const dy = t.clientY - start.y;
    if (dy > 80 && Math.abs(dy) > Math.abs(dx)) return onClose(); // swipe down
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy)) {
      setI((cur) => Math.min(Math.max(cur + (dx < 0 ? 1 : -1), 0), refs.length - 1));
    }
  };
  const onTap = () => {
    // Manual double-tap detection: two taps within 300ms zoom instead of close.
    const now = performance.now();
    if (now - lastTap.current < 300) {
      setZoomed((z) => !z);
      lastTap.current = 0;
      return;
    }
    lastTap.current = now;
    setTimeout(() => {
      if (lastTap.current && performance.now() - lastTap.current >= 300) {
        lastTap.current = 0;
        onClose();
      }
    }, 320);
  };

  return (
    <div
      className="image-viewer"
      onClick={onTap}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
      role="dialog"
      aria-label="查看图片"
    >
      {url ? (
        <img
          className={`image-viewer__img${zoomed ? ' image-viewer__img--zoom' : ''}`}
          src={url}
          alt=""
        />
      ) : (
        <div className="image-viewer__ph" style={{ background }} />
      )}
      {refs.length > 1 && (
        <div className="image-viewer__count">
          {i + 1}/{refs.length}
        </div>
      )}
    </div>
  );
}
