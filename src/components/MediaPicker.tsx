/**
 * Modal grid picker over the runtime media library. Dumb by design: it reads
 * the in-memory registry (no repo access) and reports the chosen ref upward —
 * importing/deleting lives in 设置 → 素材库.
 */
import { listRegisteredMedia } from '../data/media-registry';
import './media-picker.css';

interface MediaPickerProps {
  kind: 'avatar' | 'photo';
  title: string;
  /** Called with `idb:<id>`, or '' when the user clears the assignment. */
  onPick: (ref: string) => void;
  onClose: () => void;
  /** Show a "恢复默认" action that picks ''. */
  allowClear?: boolean;
}

export function MediaPicker({ kind, title, onPick, onClose, allowClear }: MediaPickerProps) {
  const items = listRegisteredMedia(kind);
  return (
    <div className="media-picker" onClick={onClose}>
      <div className="media-picker__panel" onClick={(e) => e.stopPropagation()}>
        <div className="media-picker__title">{title}</div>
        {items.length === 0 ? (
          <div className="media-picker__empty">
            素材库还没有{kind === 'avatar' ? '头像' : '照片'}——先到 设置 → 素材库 导入图片
          </div>
        ) : (
          <div className="media-picker__grid">
            {items.map((m) => (
              <img
                key={m.id}
                className="media-picker__thumb"
                src={m.url}
                alt=""
                onClick={() => onPick(`idb:${m.id}`)}
              />
            ))}
          </div>
        )}
        <div className="media-picker__actions">
          {allowClear && (
            <button className="btn-ghost" style={{ margin: 0 }} onClick={() => onPick('')}>
              恢复默认
            </button>
          )}
          <button className="btn-ghost" style={{ margin: 0 }} onClick={onClose}>
            取消
          </button>
        </div>
      </div>
    </div>
  );
}
