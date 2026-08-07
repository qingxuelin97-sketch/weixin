import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { SubNav } from '../../components/SubNav';
import { useAppStore } from '../../store/appStore';
import { yuanToFen, fenToYuan } from '../../lib/money';
import { sendRedPacket } from '../../ai/money-service';
import './money.css';

export function RedPacketSendPage() {
  const { convId = '' } = useParams();
  const navigate = useNavigate();
  const conv = useAppStore((s) => s.conversationById(convId));
  const personaFor = useAppStore((s) => s.personaFor);
  const appendMessage = useAppStore((s) => s.appendMessage);
  const updateMessage = useAppStore((s) => s.updateMessage);

  const isGroup = conv?.type === 'group';
  const [amount, setAmount] = useState('');
  const [count, setCount] = useState('1');
  const [greeting, setGreeting] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const fen = yuanToFen(amount || '0') ?? 0;
  const n = Math.max(1, Number(count) || 1);
  const valid = fen >= n && fen > 0 && n >= 1 && n <= 20;

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
      await sendRedPacket(convId, fen, n, greeting, grabbers, {
        appendMessage,
        updateMessage,
        now: () => Date.now(),
      });
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
        <div className="money-form">
          {isGroup && (
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

        {isGroup && <div className="money-hint">拼手气红包，金额随机分配给群里前 {n} 位领取的人</div>}
        {error && <div className="money-error">{error}</div>}
        {!error && !valid && amount !== '' && (
          <div className="money-error">
            {fen <= 0 ? '请输入金额' : fen < n ? '金额太少，每个红包至少 1 分' : '红包个数 1-20'}
          </div>
        )}

        <button className="btn-money" disabled={!valid || busy} onClick={submit}>
          {busy ? '发送中…' : `塞钱进红包`}
        </button>
      </div>
    </>
  );
}
