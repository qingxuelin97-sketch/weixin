/**
 * 转发选择器 (M-J12) — the "发送给" conversation picker, extracted so a second
 * surface (favorites → forward back into a chat) reuses the exact sheet the
 * chat page has offered since M-I6 instead of inventing a sibling.
 *
 * Hidden-conversation rule: the candidate list goes through
 * `forwardableConversations` (src/lib/favorites.ts), which drops isHidden rows
 * INSIDE the helper — a caller cannot forget the filter, so an AI↔AI DM can
 * never be offered as a forward destination. tests/unit/j12-favorites.test.ts
 * holds that red.
 */
import { Sheet } from './Sheet';
import { useAppStore } from '../store/appStore';
import { forwardableConversations } from '../lib/favorites';
import type { ConversationVM } from '../data/types';

export interface ForwardSheetProps {
  open: boolean;
  onClose: () => void;
  /** Tapping a row hands the chosen conversation over and closes the sheet. */
  onPick: (conv: ConversationVM) => void;
  /** The thread being forwarded FROM, if any — never offered as a target. */
  excludeConvId?: string;
  title?: string;
}

export function ForwardSheet({
  open,
  onClose,
  onPick,
  excludeConvId,
  title = '发送给',
}: ForwardSheetProps) {
  // Stable store reference (constitution §3.5); the derived list is computed
  // in render, not in the selector.
  const conversations = useAppStore((s) => s.conversations);
  if (!open) return null;
  const rows = forwardableConversations(conversations, excludeConvId);
  return (
    <Sheet open onClose={onClose} title={title}>
      {rows.map((c) => (
        <div
          key={c.id}
          className="settings__row settings__row--divided"
          role="button"
          onClick={() => {
            onClose();
            onPick(c);
          }}
        >
          <span className="settings__label">{c.title}</span>
        </div>
      ))}
    </Sheet>
  );
}
