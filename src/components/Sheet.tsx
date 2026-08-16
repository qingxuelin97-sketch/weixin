/**
 * Bottom sheet container (M-I0, drag-to-close landed M-I8).
 *
 * The controlled counterpart to the imperative `showActionSheet`: feature
 * panels with real content (the forward picker, the cover picker, the member
 * picker) render children inside a sheet instead of each hand-rolling a mask +
 * panel pair — the app had three of those, each with its own z-index and none
 * of them closable by the back button.
 *
 * M-I8 fills in the stub M-I0 left: the sheet is now DRAGGABLE. Pushing it back
 * down with a thumb closes it, a short flick closes it, and letting go halfway
 * springs it back. The gesture rides `useSheetDrag`, which is the same spring
 * machinery as the swipe row and the edge-back — one vocabulary of physics
 * rather than three.
 *
 * Closing semantics stay singular whichever way you close it: scrim tap, drag,
 * and the hardware back button all end at the same `onClose`, and the sheet is
 * registered with the dismiss stack so back closes IT rather than the page
 * underneath (specs/motion.md rule 4).
 */
import { useRef, type ReactNode } from 'react';
import { useDismissable } from '../app/useDismissable';
import { useSheetDrag } from './useSheetDrag';
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
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  // Registered while open, so the hardware back button closes the sheet
  // instead of leaving the page underneath it.
  useDismissable(open, onClose);
  // The drag only arms while the body is scrolled to its top — a sheet whose
  // list is scrolled must scroll, not drag (see useSheetDrag).
  const drag = useSheetDrag({ ref: panelRef, onClose, scrollRef: bodyRef });

  if (!open) return null;
  return (
    <div
      className="ovl ovl--bottom ovl--sheet"
      onClick={() => {
        // A drag that ended over the scrim must not ALSO count as a scrim tap:
        // the drag already decided (close or spring back), and firing onClose
        // here would close a sheet the user just chose to keep.
        if (drag.dragging()) return;
        onClose();
      }}
    >
      <div
        ref={panelRef}
        className="sheet"
        role="dialog"
        aria-modal
        style={{ maxHeight }}
        onClick={(e) => e.stopPropagation()}
        {...drag.handlers}
      >
        {/* The grabber is what advertises the gesture. Without it drag-to-close
            is a feature only the person who wrote it knows about. */}
        <div className="sheet__grabber" aria-hidden />
        {title && <div className="sheet__title">{title}</div>}
        <div className="sheet__body" ref={bodyRef}>
          {children}
        </div>
      </div>
    </div>
  );
}
