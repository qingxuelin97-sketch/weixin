import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { SubNav } from '../../components/SubNav';
import { useAppStore } from '../../store/appStore';
import { yuanToFen, fenToYuan } from '../../lib/money';
import { sendRedPacket, type RpOptions } from '../../ai/money-service';
import './money.css';

/** 群里的三种玩法 (M-J8)；单聊没有选择器（一份红包无所谓拆法）。 */
type RpMode = 'lucky' | 'even' | 'exclusive';

const MODE_TABS: Array<{ key: RpMode; label: string }> = [
  { key: 'lucky', label: '拼手气红包' },
  { key: 'even', label: '普通红包' },
  { key: 'exclusive', label: '专属红包' },
];

export function RedPacketSendPage() {
  const { convId = '' } = useParams();
  const navigate = useNavigate();
  const conv = useAppStore((s) => s.conversationById(convId));
  const contactById = useAppStore((s) => s.contactById);
  const personaFor = useAppStore((s) => s.personaFor);
  const appendMessage = useAppStore((s) => s.appendMessage);
  const updateMessage = useAppStore((s) => s.updateMessage);

  const isGroup = conv?.type === 'group';
  const [mode, setMode] = useState<RpMode>('lucky');
  const [amount, setAmount] = useState('');
  const [count, setCount] = useState('1');
  const [exclusiveId, setExclusiveId] = useState('');
  const [greeting, setGreeting] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const members = isGroup ? (conv?.memberIds ?? []).filter((id) => contactById(id)) : [];
  const nameOf = (id: string) => {
    const c = contactById(id);
    return c?.remark ?? c?.name ?? id;
  };

  const fen = yuanToFen(amount || '0') ?? 0;
  // 专属包永远一份；单聊也永远一份。
  const exclusive = isGroup && mode === 'exclusive';
  const n = exclusive || !isGroup ? 1 : Math.max(1, Number(count) || 1);
  const valid =
    fen >= n && fen > 0 && n >= 1 && n <= 20 && (!exclusive || members.includes(exclusiveId));

  const submit = async () => {
    if (!conv || !valid || busy) return;
    setBusy(true);
    setError('');
    try {
      const grabbers = isGroup
        ? (conv.memberIds ?? []).map((id) => ({ contactId: id, persona: personaFor(id) }))
        : conv.peerId
          ? [{ contactId: conv.peerId, persona: personaFor(conv.peerId) }]
          : [];
      const opts: RpOptions | undefined = !isGroup
        ? undefined
        : mode === 'even'
          ? { mode: 'even' }
          : mode === 'exclusive'
            ? { mode: 'exclusive', exclusiveId, exclusiveName: nameOf(exclusiveId) }
            : undefined;
      await sendRedPacket(convId, fen, n, greeting, grabbers, {
        appendMessage,
        updateMessage,
        now: () => Date.now(),
      }, opts);
      navigate(-1);
    } catch (e) {
      setError(e instanceof Error ? e.message : '发送失败');
      setBusy(false);
    }
  };

  return (
    <>
      <SubNav title="发红包" />
      <div className="page-body money-page">
        {isGroup && (
          <div className="rp-mode" role="tablist">
            {MODE_TABS.map((t) => (
              <button
                key={t.key}
                role="tab"
                aria-selected={mode === t.key}
                className={`rp-mode__tab${mode === t.key ? ' rp-mode__tab--on' : ''}`}
                onClick={() => setMode(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>
        )}
        <div className="money-form">
          {isGroup && !exclusive && (
            <div className="money-form__row">
              <span className="money-form__label">红包个数</span>
              <input
                className="money-form__input"
                inputMode="numeric"
                value={count}
                onChange={(e) => setCount(e.target.value.replace(/\D/g, '').slice(0, 2))}
              />
              <span className="money-form__unit">个</span>
            </div>
          )}
          {exclusive && (
            <div className="money-form__row">
              <span className="money-form__label">给谁</span>
              <select
                className="money-form__input rp-mode__who"
                value={exclusiveId}
                onChange={(e) => setExclusiveId(e.target.value)}
              >
                <option value="">选择领取人</option>
                {members.map((id) => (
                  <option key={id} value={id}>
                    {nameOf(id)}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="money-form__row">
            <span className="money-form__label">总金额</span>
            <input
              className="money-form__input money-form__input--amount"
              inputMode="decimal"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, '').slice(0, 9))}
            />
            <span className="money-form__unit">元</span>
          </div>
          <div className="money-form__row">
            <span className="money-form__label">留言</span>
            <input
              className="money-form__input"
              placeholder="恭喜发财，大吉大利"
              value={greeting}
              onChange={(e) => setGreeting(e.target.value.slice(0, 20))}
            />
          </div>
        </div>

        <div className="amount-display">
          <div className="amount-display__label">¥</div>
          <div className="amount-display__value">{fenToYuan(fen)}</div>
        </div>

        {isGroup && mode === 'lucky' && (
          <div className="money-hint">拼手气红包，金额随机分配给群里前 {n} 位领取的人</div>
        )}
        {isGroup && mode === 'even' && (
          <div className="money-hint">普通红包，{n} 份均分（整数分，余数前置）</div>
        )}
        {exclusive && (
          <div className="money-hint">
            专属红包，仅{exclusiveId ? ` ${nameOf(exclusiveId)} ` : '指定的人'}可领取
          </div>
        )}
        {error && <div className="money-error">{error}</div>}
        {!error && !valid && amount !== '' && (
          <div className="money-error">
            {fen <= 0
              ? '请输入金额'
              : exclusive && !exclusiveId
                ? '请选择领取人'
                : fen < n
                  ? '金额太少，每个红包至少 1 分'
                  : '红包个数 1-20'}
          </div>
        )}

        <button className="btn-money" disabled={!valid || busy} onClick={submit}>
          {busy ? '发送中…' : `塞钱进红包`}
        </button>
      </div>
    </>
  );
}
