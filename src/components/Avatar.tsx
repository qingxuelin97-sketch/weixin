/**
 * Avatar: rounded-SQUARE (WeChat is not a circle — radius ~5px). Renders a real
 * image when the contact carries a media-library ref (`idb:<id>`), otherwise
 * the tinted 1-2 char placeholder. Group avatars composite up to 9 cells.
 */
import { resolveImageRef } from '../data/moments-images';
import './avatar.css';

interface AvatarProps {
  color: string;
  text: string;
  size?: number;
  /** Media ref (`idb:<id>` / `img:<name>`); falls back to color+text when unresolvable. */
  imageRef?: string;
  /** Group avatar: up to 9 sub-avatars composited in a grid, like WeChat. */
  members?: Array<{ color: string; text: string; imageRef?: string }>;
  /**
   * 状态圈 (M-J7): a colored ring + emoji badge when this person has a live
   * 「状态」. Pass the token NAME (e.g. `--color-wxstatus-blue`), not a color —
   * 铁律 1, and the catalog in src/lib/status.ts stores names for this reason.
   *
   * Undefined means no ring, which is what every existing call site gets — the
   * markup below is byte-identical without it, so no golden moves.
   */
  status?: { tint: string; emoji: string };
}

function refUrl(ref?: string): string | undefined {
  return ref ? resolveImageRef(ref).url : undefined;
}

export function Avatar({ color, text, size = 48, imageRef, members, status }: AvatarProps) {
  const inner = AvatarBody({ color, text, size, imageRef, members });
  if (!status) return inner;
  return (
    <span
      className="avatar-status"
      style={{ '--status-tint': `var(${status.tint})` } as React.CSSProperties}
    >
      {inner}
      <span className="avatar-status__badge" style={{ fontSize: Math.max(9, size * 0.28) }}>
        {status.emoji}
      </span>
    </span>
  );
}

function AvatarBody({ color, text, size = 48, imageRef, members }: AvatarProps) {
  if (members && members.length > 1) {
    const shown = members.slice(0, 9);
    const cols = shown.length <= 4 ? 2 : 3;
    return (
      <div
        className="avatar avatar--group"
        style={{ width: size, height: size, gridTemplateColumns: `repeat(${cols}, 1fr)` }}
      >
        {shown.map((mm, i) => {
          const url = refUrl(mm.imageRef);
          return url ? (
            <img key={i} className="avatar__cell avatar__img" src={url} alt="" />
          ) : (
            <div key={i} className="avatar__cell" style={{ background: mm.color }}>
              <span style={{ fontSize: size / cols / 2 }}>{mm.text}</span>
            </div>
          );
        })}
      </div>
    );
  }
  const url = refUrl(imageRef);
  if (url) {
    return (
      <div className="avatar" style={{ width: size, height: size }}>
        <img className="avatar__img" src={url} alt="" width={size} height={size} />
      </div>
    );
  }
  return (
    <div className="avatar" style={{ width: size, height: size, background: color }}>
      <span style={{ fontSize: size * 0.42 }}>{text}</span>
    </div>
  );
}
