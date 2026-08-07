/**
 * The composer's bottom-inset state machine — the project's hardest UI point.
 *
 * Goal: switching between keyboard ⇄ emoji/+ panel produces ZERO layout jump.
 * The trick: the input bar's bottom offset is always `max(keyboardH, panelH)`,
 * and the panel's height is LOCKED to the most recently measured keyboard height,
 * so raising a panel exactly backfills the space the keyboard vacated.
 *
 * Height source:
 *  - Native (Capacitor Keyboard, resize:none): keyboardWillShow/Hide events.
 *  - Web/WKWebView: visualViewport resize (the keyboard shrinks the viewport).
 * Callers get one number (`bottomInset`) and one `mode`; they never touch either source.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

export type ComposerMode = 'none' | 'keyboard' | 'emoji' | 'plus';

const DEFAULT_PANEL_HEIGHT = 280; // fallback until a real keyboard height is measured
const PANEL_HEIGHT_KEY = 'composer.lastKeyboardHeight';

interface ComposerState {
  mode: ComposerMode;
  /** Space to reserve below the input bar (keyboard or panel height), in px. */
  bottomInset: number;
  panelHeight: number;
  openKeyboard: () => void;
  toggleEmoji: () => void;
  togglePlus: () => void;
  closeAll: () => void;
  /** Attach to the text field to coordinate focus with the state machine. */
  inputRef: React.RefObject<HTMLTextAreaElement>;
}

function readStoredPanelHeight(): number {
  try {
    const v = Number(localStorage.getItem(PANEL_HEIGHT_KEY));
    return v > 120 && v < 500 ? v : DEFAULT_PANEL_HEIGHT;
  } catch {
    return DEFAULT_PANEL_HEIGHT;
  }
}

export function useComposerPanel(): ComposerState {
  const [mode, setMode] = useState<ComposerMode>('none');
  const [keyboardH, setKeyboardH] = useState(0);
  const [panelHeight, setPanelHeight] = useState(readStoredPanelHeight);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  // --- Measure keyboard height (web via visualViewport) ---
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      // Keyboard height ≈ layout viewport height − visual viewport height − offsetTop.
      const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      setKeyboardH(kb);
      if (kb > 120) {
        // Lock panel height to the real keyboard so keyboard⇄panel never jumps.
        setPanelHeight(kb);
        try {
          localStorage.setItem(PANEL_HEIGHT_KEY, String(kb));
        } catch {
          /* ignore */
        }
        if (modeRef.current !== 'keyboard') setMode('keyboard');
      } else if (kb === 0 && modeRef.current === 'keyboard') {
        // Keyboard dismissed by the OS (e.g. back gesture) with no panel open.
        setMode('none');
      }
    };
    vv.addEventListener('resize', onResize);
    vv.addEventListener('scroll', onResize);
    return () => {
      vv.removeEventListener('resize', onResize);
      vv.removeEventListener('scroll', onResize);
    };
  }, []);

  const openKeyboard = useCallback(() => {
    setMode('keyboard');
    inputRef.current?.focus();
  }, []);

  const blurInput = useCallback(() => {
    // Hide the keyboard WITHOUT losing the caret selection (so re-focus is seamless).
    inputRef.current?.blur();
  }, []);

  const toggleEmoji = useCallback(() => {
    setMode((m) => {
      if (m === 'emoji') {
        return 'none';
      }
      blurInput();
      return 'emoji';
    });
  }, [blurInput]);

  const togglePlus = useCallback(() => {
    setMode((m) => {
      if (m === 'plus') {
        return 'none';
      }
      blurInput();
      return 'plus';
    });
  }, [blurInput]);

  const closeAll = useCallback(() => {
    blurInput();
    setMode('none');
  }, [blurInput]);

  const panelOpen = mode === 'emoji' || mode === 'plus';
  const bottomInset = mode === 'keyboard' ? keyboardH || panelHeight : panelOpen ? panelHeight : 0;

  return {
    mode,
    bottomInset,
    panelHeight,
    openKeyboard,
    toggleEmoji,
    togglePlus,
    closeAll,
    inputRef,
  };
}
