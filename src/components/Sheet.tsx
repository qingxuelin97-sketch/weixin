/**
 * Bottom sheet container (M-I0).
 *
 * The controlled counterpart to the imperative `showActionSheet`: feature
 * panels with real content (the forward picker, later the member picker and
 * @-mention panel) render children inside a sheet instead of each hand-rolling
 * a mask + panel pair — the app had three of those, each with its own z-index
 * and none of them closable by the back button.
 *
 * Drag-to-close lands in I8 (the gesture rides the same spring machinery as
 * the swipe row); until then the scrim, the rise animation and the dismiss
 * stack registration are the contract.
 */
import type { ReactNode } from 'react';
import { useDismissable } from '../app/useDismissable';
import './overlay.css';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  /** Cap the sheet's height; content scrolls inside. */
  maxHeight?: string;
}

export function Sheet({ open, onClose, title, children, maxHeight = '60vh' }: SheetProps) {
  // Registered while open, so the hardware back button closes the sheet
  // instead of leaving the page underneath it.
  useDismissable(open, onClose);

  if (!open) return null;
  return (
    <div className="ovl ovl--bottom ovl--sheet" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal
        style={{ maxHeight }}
        onClick={(e) => e.stopPropagation()}
      >
        {title && <div className="sheet__title">{title}</div>}
        <div className="sheet__body">{children}</div>
      </div>
    </div>
  );
}
