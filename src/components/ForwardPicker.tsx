/**
 * 转发：「选择一个聊天」整页 (M-L2)。
 *
 * 取代 M-J12 的 ForwardSheet（半屏面板、只有名字）。微信的转发是从底部升起的整页：搜索、
 * 「最近聊天」、带头像的会话；点一个会话不会立刻发出去，而是弹一张确认卡——发给谁、发的
 * 是什么、可以顺手「给朋友留言」，然后 取消 / 发送。聊天页与收藏页共用这一个选择器
 * （聊天页此前还留着一份自己的内联面板，手写着同一条隐藏会话过滤——那是两份）。
 *
 * 隐藏会话铁律：候选列表只经 `forwardableConversations`（src/lib/favorites.ts），isHidden 行
 * 在 helper 内部被排除——调用方忘了也漏不出去，AI↔AI 私信永远不会成为转发目的地。
 */
import { useMemo, useState } from 'react';
import { useAppStore } from '../store/appStore';
import { forwardableConversations } from '../lib/favorites';
import { useDismissable } from '../app/useDismissable';
import { ConvAvatar } from './ConvAvatar';
import { IconClose, IconSearch } from './icons';
import type { ConversationVM } from '../data/types';
import './chat-picker.css';

export interface ForwardPickerProps {
  open: boolean;
  onClose: () => void;
  /** Confirmed: send to `conv`; `note` is the optional「给朋友留言」. */
  onSend: (conv: ConversationVM, note: string | undefined) => void;
  /** One line describing what is being forwarded, shown on the confirm card. */
  preview: string;
  /** The thread being forwarded FROM, if any — never offered as a target. */
  excludeConvId?: string;
}

export function ForwardPicker(props: ForwardPickerProps) {
  // Mounted only while open, so the search box and the pending choice reset
  // every time the picker comes up.
  return props.open ? <ForwardPickerBody {...props} /> : null;
}

function ForwardPickerBody({ onClose, onSend, preview, excludeConvId }: ForwardPickerProps) {
  // Stable store reference (constitution §3.5); the derived list is computed
  // in render, not in the selector.
  const conversations = useAppStore((s) => s.conversations);
  const [q, setQ] = useState('');
  const [target, setTarget] = useState<ConversationVM | null>(null);
  const [note, setNote] = useState('');

  // Back closes the confirm card first, then the picker.
  useDismissable(true, onClose);
  useDismissable(target != null, () => setTarget(null));

  const rows = useMemo(() => {
    const all = forwardableConversations(conversations, excludeConvId);
    const k = q.trim().toLowerCase();
    return k ? all.filter((c) => c.title.toLowerCase().includes(k)) : all;
  }, [conversations, excludeConvId, q]);

  return (
    <div className="cpick" role="dialog" aria-label="选择一个聊天">
      <header className="cpick__nav">
        <button className="cpick__close" aria-label="关闭" onClick={onClose}>
          <IconClose />
        </button>
        <span className="cpick__title">选择一个聊天</span>
      </header>
      <label className="cpick__search">
        <IconSearch size={16} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索" />
      </label>
      <div className="cpick__body">
        {!q.trim() && <div className="cpick__section">最近聊天</div>}
        {rows.length === 0 ? (
          <div className="cpick__empty">没有找到「{q.trim()}」</div>
        ) : (
          rows.map((c) => (
            <button key={c.id} className="cpick__row" onClick={() => setTarget(c)}>
              <ConvAvatar conv={c} size={40} />
              <span className="cpick__name">{c.title}</span>
            </button>
          ))
        )}
      </div>

      {target && (
        <div className="cpick__scrim" onClick={() => setTarget(null)}>
          <div className="cpick__confirm" role="alertdialog" onClick={(e) => e.stopPropagation()}>
            <div className="cpick__confirm-body">
              <div className="cpick__confirm-label">发送给：</div>
              <div className="cpick__confirm-to">
                <ConvAvatar conv={target} size={36} />
                <span className="cpick__name">{target.title}</span>
              </div>
              <div className="cpick__preview">{preview}</div>
              <input
                className="cpick__note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="给朋友留言"
              />
            </div>
            <div className="cpick__actions">
              <button className="cpick__cancel" onClick={() => setTarget(null)}>
                取消
              </button>
              <button
                className="cpick__send"
                onClick={() => {
                  const t = target;
                  const n = note.trim() || undefined;
                  onClose();
                  onSend(t, n);
                }}
              >
                发送
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
