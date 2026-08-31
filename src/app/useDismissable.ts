/**
 * Declarative bridge onto the dismiss stack (M-I0).
 *
 * A conditionally-rendered overlay calls `useDismissable(open, close)` and the
 * hardware back button closes it before doing anything else. The close handler
 * goes through a ref so an inline arrow (the common case — `() => setMenu(null)`)
 * doesn't re-register on every render and shuffle the stack order.
 */
import { useEffect, useRef } from 'react';
import { pushDismiss } from './dismiss-stack';

export function useDismissable(open: boolean, close: () => void) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    return pushDismiss(() => closeRef.current());
  }, [open]);
}
