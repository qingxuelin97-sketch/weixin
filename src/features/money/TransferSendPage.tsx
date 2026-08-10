import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { SubNav } from '../../components/SubNav';
import { useAppStore } from '../../store/appStore';
import { yuanToFen, fenToYuan } from '../../lib/money';
import { sendTransfer } from '../../ai/money-service';
import { logError } from '../../lib/errlog';
import './money.css';

export function TransferSendPage() {
  const { convId = '' } = useParams();
  const navigate = useNavigate();
  const conv = useAppStore((s) => s.conversationById(convId));
  const contactById = useAppStore((s) => s.contactById);
  const appendMessage = useAppStore((s) => s.appendMessage);
  const updateMessage = useAppStore((s) => s.updateMessage);

  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const fen = yuanToFen(amount || '0') ?? 0;
  const valid = fen > 0;
  const peer = conv?.peerId ? contactById(conv.peerId) : undefined;

  const submit = async () => {
    if (!conv?.peerId || !valid || busy) return;
    setBusy(true);
    setError('');
    try {
      await sendTransfer(convId, conv.peerId, fen, note, {
        appendMessage,
        updateMessage,
        now: () => Date.now(),
      });
      navigate(-1);
    } catch (e) {
      // Money must never fail invisibly. Unguarded, a throw left the button
      // disabled forever with no message — indistinguishable, from the user's
      // side, from a transfer that went through.
      logError('transfer.send', e);
      setError(e instanceof Error ? e.message : '转账失败，请重试');
      setBusy(false);
    }
  };

  return (
    <>
      <SubNav title="转账" />
      <div className="page-body money-page">
        <div className="money-hint">转账给 {peer?.remark ?? peer?.name ?? ''}</div>
        <div className="money-form">
          <div className="money-form__row">
            <span className="money-form__label">金额</span>
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
            <span className="money-form__label">说明</span>
            <input
              className="money-form__input"
              placeholder="添加转账说明"
              value={note}
              onChange={(e) => setNote(e.target.value.slice(0, 20))}
            />
          </div>
        </div>

        <div className="amount-display">
          <div className="amount-display__label">转账金额</div>
          <div className="amount-display__value">¥{fenToYuan(fen)}</div>
        </div>

        {error && <div className="money-error">{error}</div>}

        <button className="btn-money" disabled={!valid || busy} onClick={() => void submit()}>
          {busy ? '处理中…' : '转账'}
        </button>
      </div>
    </>
  );
}
