/**
 * 设置我的「状态」 (M-J7)。
 *
 * 路由是 `/status-set`，不是 `/status`：`/status/:contactId` 早在 M-G7 就被
 * 「她的状态」（智能体内在状态页）占了。两个功能中文同名，路由再撞一次就
 * 没人分得清了。
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SubNav } from '../../components/SubNav';
import { useAppStore } from '../../store/appStore';
import { useNow } from '../../lib/useNow';
import {
  STATUS_OPTIONS,
  STATUS_TEXT_MAX,
  liveStatus,
  statusLabel,
  statusRemainMs,
} from '../../lib/status';
import './me.css';

export function StatusSetPage() {
  const navigate = useNavigate();
  const now = useNow();
  const statuses = useAppStore((s) => s.statuses);
  const setStatusFor = useAppStore((s) => s.setStatusFor);
  const showToast = useAppStore((s) => s.showToast);
  const current = liveStatus(statuses, 'self', now);
  const [picked, setPicked] = useState(current?.optionId ?? '');
  const [text, setText] = useState(current?.text ?? '');

  const publish = async () => {
    if (!picked) {
      showToast('先选一个状态');
      return;
    }
    await setStatusFor('self', { optionId: picked, text: text.trim() || undefined, at: now }, now);
    navigate(-1);
  };

  return (
    <>
      <SubNav title="我的状态" />
      <div className="page-body status-set">
        {current && (
          <div className="status-set__current">
            <span
              className="status-chip"
              style={{ '--chip-tint': `var(${current.option.tint})` } as React.CSSProperties}
            >
              <span className="status-chip__emoji">{current.option.emoji}</span>
              {statusLabel(current)}
            </span>
            <span className="status-set__remain">
              {/* 微信在状态页明说什么时候消失。不说的话「状态怎么没了」
                  会被当成 bug——它其实是这个功能的定义。 */}
              {Math.max(1, Math.round(statusRemainMs(current, now) / 3_600_000))} 小时后结束
            </span>
            <button
              className="status-set__clear"
              onClick={() => void setStatusFor('self', null, now).then(() => navigate(-1))}
            >
              结束状态
            </button>
          </div>
        )}

        <div className="status-grid">
          {STATUS_OPTIONS.map((o) => (
            <button
              key={o.id}
              className={`status-tile${picked === o.id ? ' status-tile--on' : ''}`}
              style={{ '--chip-tint': `var(${o.tint})` } as React.CSSProperties}
              onClick={() => setPicked(o.id)}
            >
              <span className="status-tile__emoji">{o.emoji}</span>
              <span className="status-tile__label">{o.label}</span>
            </button>
          ))}
        </div>

        <div className="field">
          <label className="field__label" htmlFor="status-text">
            这一刻的想法（可留空）
          </label>
          <input
            id="status-text"
            className="field__input"
            value={text}
            maxLength={STATUS_TEXT_MAX}
            placeholder="想说点什么"
            onChange={(e) => setText(e.target.value)}
          />
        </div>

        <button className="btn-primary" onClick={() => void publish()}>
          就这样
        </button>
      </div>
    </>
  );
}
