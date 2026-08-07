import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { SubNav } from '../../components/SubNav';
import { useAppStore } from '../../store/appStore';
import { yuanToFen, fenToYuan } from '../../lib/money';
import { sendTransfer } from '../../ai/money-service';
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

  const fen = yuanToFen(amount || '0') ?? 0;
  const valid = fen > 0;
  const peer = conv?.peerId ? contactById(conv.peerId) : undefined;

  const submit = async () => {
    if (!conv?.peerId || !valid || busy) return;
    setBusy(true);
    await sendTransfer(convId, conv.peerId, fen, note, {
      appendMessage,
      updateMessage,
      now: () => Date.now(),
    });
    navigate(-1);
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

        <button className="btn-money" disabled={!valid || busy} onClick={submit}>
          {busy ? '处理中…' : '转账'}
        </button>
      </div>
    </>
  );
}
