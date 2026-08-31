/**
 * The toggle (M-I0).
 *
 * Twenty copy-pasted `<span className="switch…">` blocks across seven files,
 * none of them focusable, none announcing state. Same markup, one component:
 * the CSS classes are kept byte-identical so the 22 golden screenshots do not
 * move — this is a semantics migration, not a redesign.
 */

export interface SwitchProps {
  on: boolean;
  onChange?: (on: boolean) => void;
  disabled?: boolean;
  /** Announced to assistive tech; falls back to nothing (row label usually covers it). */
  label?: string;
}

export function Switch({ on, onChange, disabled, label }: SwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className={`switch${on ? ' switch--on' : ''}`}
      onClick={(e) => {
        // Rows often carry their own onClick that ALSO toggles; stop the
        // bubble so a tap flips the value exactly once.
        e.stopPropagation();
        onChange?.(!on);
      }}
    >
      <span className="switch__knob" />
    </button>
  );
}
