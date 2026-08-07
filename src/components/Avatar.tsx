/**
 * Placeholder avatar: rounded-SQUARE (WeChat is not a circle — radius ~5px),
 * tinted with a data color and a 1-2 char label. Swapped for real PNGs from the
 * user's generated avatar library once available (avatarRef on the contact).
 */
import './avatar.css';

interface AvatarProps {
  color: string;
  text: string;
  size?: number;
  /** Group avatar: up to 9 sub-avatars composited in a grid, like WeChat. */
  members?: Array<{ color: string; text: string }>;
}

export function Avatar({ color, text, size = 48, members }: AvatarProps) {
  if (members && members.length > 1) {
    const shown = members.slice(0, 9);
    const cols = shown.length <= 4 ? 2 : 3;
    return (
      <div
        className="avatar avatar--group"
        style={{ width: size, height: size, gridTemplateColumns: `repeat(${cols}, 1fr)` }}
      >
        {shown.map((mm, i) => (
          <div key={i} className="avatar__cell" style={{ background: mm.color }}>
            <span style={{ fontSize: size / cols / 2 }}>{mm.text}</span>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="avatar" style={{ width: size, height: size, background: color }}>
      <span style={{ fontSize: size * 0.42 }}>{text}</span>
    </div>
  );
}
