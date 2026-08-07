import type { ComposerMode } from './useComposerPanel';

// A small emoji set stands in for WeChat's yellow-face pack (V1 uses emoji mapping).
const EMOJIS = [
  '😊', '😂', '😍', '😭', '😅', '😳', '😘', '🤔',
  '👍', '🙏', '👌', '💪', '🎉', '❤️', '🔥', '🌹',
  '😴', '🤣', '😎', '😏', '😢', '😡', '🥰', '😋',
];

const PLUS_ITEMS = [
  { key: 'album', label: '相册', color: 'var(--color-brand)' },
  { key: 'camera', label: '拍摄', color: 'var(--color-link)' },
  { key: 'call', label: '视频通话', color: 'var(--wx-gold)' },
  { key: 'location', label: '位置', color: 'var(--color-brand)' },
  { key: 'redpacket', label: '红包', color: 'var(--wx-rp-red)' },
  { key: 'transfer', label: '转账', color: 'var(--wx-gold)' },
  { key: 'voiceinput', label: '语音输入', color: 'var(--color-link)' },
  { key: 'fav', label: '收藏', color: 'var(--color-brand)' },
];

/**
 * The emoji / + panel. Its height is locked to the measured keyboard height by
 * the composer hook so swapping keyboard⇄panel never shifts the layout.
 */
export function ComposerPanels({ mode, height }: { mode: ComposerMode; height: number }) {
  if (mode !== 'emoji' && mode !== 'plus') return null;
  return (
    <div className="composer-panel" style={{ height }}>
      {mode === 'emoji' ? (
        <div className="emoji-grid">
          {EMOJIS.map((e, i) => (
            <button key={i} className="emoji-grid__item">
              {e}
            </button>
          ))}
        </div>
      ) : (
        <div className="plus-grid">
          {PLUS_ITEMS.map((it) => (
            <div key={it.key} className="plus-grid__item">
              <div className="plus-grid__icon" style={{ background: it.color }} />
              <span className="plus-grid__label">{it.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
