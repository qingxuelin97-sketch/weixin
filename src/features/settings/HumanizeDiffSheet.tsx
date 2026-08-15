/**
 * Per-field review of a humanize patch (M-I2).
 *
 * The model's rewrite is a PROPOSAL: every field shows 旧/新 side by side with
 * its own accept switch, and only the accepted subset becomes the final patch.
 * This is the difference between "the AI touched my character" and "I chose
 * two of its four suggestions" — for a card the user may have spent an hour
 * writing, that difference is the feature.
 */
import { useEffect, useState } from 'react';
import { Sheet } from '../../components/Sheet';
import { Switch } from '../../components/Switch';
import type { PersonaVM } from '../../data/types';

const FIELD_LABELS: Record<string, string> = {
  core: '核心人设',
  speechStyle: '说话风格',
  catchphrases: '口头禅',
  fewShots: '示例消息',
  greeting: '开场白',
};

const show = (v: unknown): string =>
  Array.isArray(v) ? v.join(' ／ ') : v == null || v === '' ? '（空）' : String(v);

interface Props {
  open: boolean;
  original: PersonaVM;
  patch: Partial<PersonaVM>;
  onClose: () => void;
  /** Called with the ACCEPTED subset of the patch (may be empty). */
  onApply: (accepted: Partial<PersonaVM>) => void;
}

export function HumanizeDiffSheet({ open, original, patch, onClose, onApply }: Props) {
  const keys = Object.keys(patch).filter((k) => k in FIELD_LABELS);
  const [accepted, setAccepted] = useState<Record<string, boolean>>({});
  // Re-arm the switches for each new proposal; everything starts accepted.
  useEffect(() => {
    if (open) setAccepted(Object.fromEntries(keys.map((k) => [k, true])));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the proposal itself
  }, [open, patch]);

  return (
    <Sheet open={open} onClose={onClose} title="拟人化建议" maxHeight="75vh">
      <div className="settings" style={{ padding: '0 0 8px' }}>
        {keys.map((k) => (
          <div key={k} className="field field--divided">
            <span className="field__label">
              {FIELD_LABELS[k]}
              <Switch
                on={accepted[k] ?? true}
                onChange={() => setAccepted((a) => ({ ...a, [k]: !(a[k] ?? true) }))}
              />
            </span>
            <div className="field__hint">旧：{show(original[k as keyof PersonaVM])}</div>
            <div className="field__hint">新：{show(patch[k as keyof PersonaVM])}</div>
          </div>
        ))}
        <button
          className="btn-primary"
          onClick={() => {
            const out: Partial<PersonaVM> = {};
            for (const k of keys) {
              if (accepted[k] ?? true) (out as Record<string, unknown>)[k] = patch[k as keyof PersonaVM];
            }
            onApply(out);
          }}
        >
          应用勾选的改动
        </button>
        <button className="btn-ghost" onClick={onClose}>
          放弃
        </button>
      </div>
    </Sheet>
  );
}
