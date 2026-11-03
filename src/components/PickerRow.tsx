import { useState } from 'react';
import { Sheet } from './Sheet';
import { IconCheck } from './icons';
import './picker-row.css';

export interface PickerOption<T extends string> {
  value: T;
  label: string;
}

/**
 * 选择器行 (M-K6)：替掉浏览器原生的 `<select>`（系统下拉框，样式与微信完全不搭）。
 * 外形仍是表单里的「标签 + 值」两行，点它弹出底部 Sheet，列出全部选项，当前项打绿勾。
 * 选项是受控的：调用方给出 value 与 options，这里不持有业务状态。
 */
export function PickerRow<T extends string>({
  label,
  value,
  options,
  onChange,
  title,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<PickerOption<T>>;
  onChange: (v: T) => void;
  /** 底部面板的标题；缺省用 label。 */
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  return (
    <>
      <div className="field field--divided picker-row" role="button" onClick={() => setOpen(true)}>
        <span className="field__label">{label}</span>
        <span className="picker-row__value">
          <span>{current?.label ?? String(value)}</span>
          <span className="picker-row__chevron" aria-hidden>
            ›
          </span>
        </span>
      </div>
      <Sheet open={open} onClose={() => setOpen(false)} title={title ?? label}>
        <div className="picker-row__list" role="listbox" aria-label={title ?? label}>
          {options.map((o) => {
            const on = o.value === value;
            return (
              <div
                key={o.value}
                role="option"
                aria-selected={on}
                className="settings__row settings__row--divided picker-row__option"
                onClick={() => {
                  setOpen(false);
                  if (!on) onChange(o.value);
                }}
              >
                <span className="settings__label">{o.label}</span>
                {on && (
                  <span className="picker-row__check">
                    <IconCheck />
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </Sheet>
    </>
  );
}
