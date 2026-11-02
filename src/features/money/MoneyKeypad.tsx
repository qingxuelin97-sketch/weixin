import { useEffect } from 'react';
import { IconBackspace } from '../../components/icons';
import type { AmountKey } from './keypad';

/**
 * 微信转账页的数字键盘 (M-K3)：三列数字 + 右侧一列（退格、一个跨三行的绿色确认键）。
 *
 *   [1][2][3][⌫]
 *   [4][5][6][  ]
 *   [7][8][9][转]
 *   [  0 ][.][账]
 *
 * 桌面浏览器上也接实体键盘（数字、小数点、退格、回车），方便测试与 Web 端使用。
 */
export function MoneyKeypad({
  onKey,
  onConfirm,
  confirmLabel,
  disabled,
}: {
  onKey: (k: AmountKey) => void;
  onConfirm: () => void;
  confirmLabel: string;
  disabled: boolean;
}) {
  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (/^[0-9]$/.test(e.key)) onKey(e.key as AmountKey);
      else if (e.key === '.') onKey('.');
      else if (e.key === 'Backspace') onKey('del');
      else if (e.key === 'Enter' && !disabled) onConfirm();
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onDown);
    return () => window.removeEventListener('keydown', onDown);
  }, [onKey, onConfirm, disabled]);

  const digit = (k: AmountKey, extra = '') => (
    <button key={k} type="button" className={`keypad__key${extra}`} onClick={() => onKey(k)}>
      {k}
    </button>
  );
  return (
    <div className="keypad" role="group" aria-label="金额键盘">
      {digit('1')}
      {digit('2')}
      {digit('3')}
      <button type="button" className="keypad__key" aria-label="删除" onClick={() => onKey('del')}>
        <IconBackspace size={26} />
      </button>
      {digit('4')}
      {digit('5')}
      {digit('6')}
      <button
        type="button"
        className="keypad__confirm"
        disabled={disabled}
        onClick={() => !disabled && onConfirm()}
      >
        {confirmLabel}
      </button>
      {digit('7')}
      {digit('8')}
      {digit('9')}
      {digit('0', ' keypad__key--zero')}
      {digit('.')}
    </div>
  );
}
