import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Switch } from '../../components/Switch';

/**
 * 设置页的两种行 (M-K4)。设置树拆成五页之后，同一个「标签 + 值 + ›」写了二十多遍；
 * 收成两个组件，行高、分割线、按下态只有一处定义。
 */
export function LinkRow({
  label,
  value,
  to,
  onClick,
  last,
}: {
  label: string;
  value?: ReactNode;
  /** 点了去哪；与 onClick 二选一。 */
  to?: string;
  onClick?: () => void;
  /** 组里最后一行不画分割线。 */
  last?: boolean;
}) {
  const navigate = useNavigate();
  return (
    <div
      className={`settings__row${last ? '' : ' settings__row--divided'}`}
      role="button"
      onClick={() => (to ? navigate(to) : onClick?.())}
    >
      <span className="settings__label">{label}</span>
      {value != null && value !== '' && <span className="settings__value">{value}</span>}
      <span className="settings__chevron">›</span>
    </div>
  );
}

export function SwitchRow({
  label,
  on,
  onToggle,
  last,
}: {
  label: string;
  on: boolean;
  onToggle: () => void;
  last?: boolean;
}) {
  return (
    <div className={`settings__row${last ? '' : ' settings__row--divided'}`} onClick={onToggle}>
      <span className="settings__label">{label}</span>
      <Switch on={on} onChange={onToggle} />
    </div>
  );
}
