/**
 * One stack of "what closes when you press back" (M-I0).
 *
 * Android's hardware back button and every overlay in the app have to agree
 * on a single order: topmost overlay first, then the page stack, then — at a
 * tab root with nothing open — minimize. Before this module none of that
 * existed: the back button wasn't handled at all (grep `backButton` found
 * nothing), and each of the 8 hand-written overlays closed only via its own
 * scrim tap.
 *
 * Overlays register a close handler on mount and unregister on unmount; the
 * back handler pops the top. Deliberately module-level, not React context:
 * the scheduler's incoming-call overlay and imperative dialogs (`showConfirm`)
 * open from outside the component tree, and a context would wall them out.
 */

import { logError } from '../lib/errlog';

type Dismiss = () => void;

const stack: Array<{ id: number; close: Dismiss }> = [];
let nextId = 1;

/** Register an open overlay. Returns the unregister function — call it on close/unmount. */
export function pushDismiss(close: Dismiss): () => void {
  const id = nextId++;
  stack.push({ id, close });
  return () => {
    const i = stack.findIndex((e) => e.id === id);
    if (i >= 0) stack.splice(i, 1);
  };
}

/**
 * Close the topmost overlay, if any. Returns whether something was closed —
 * false tells the back handler to fall through to page navigation.
 */
export function popDismiss(): boolean {
  const top = stack.pop();
  if (!top) return false;
  try {
    top.close();
  } catch (e) {
    // A throwing close handler must not eat the back press chain — but it IS a
    // bug in that overlay, and swallowing it silently presents as "back button
    // does nothing here", the least diagnosable symptom there is.
    logError('dismiss.close', e);
  }
  return true;
}

/** Anything open? (The back handler asks before deciding to navigate.) */
export function hasDismissable(): boolean {
  return stack.length > 0;
}

/** Test seam. */
export function clearDismissStack(): void {
  stack.length = 0;
}
