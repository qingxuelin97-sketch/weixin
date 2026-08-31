/**
 * 发起群收款面板 (M-J8) — a bottom sheet, not a route: the flow is two fields
 * and a button, and a route would cost a golden + smoke row for what is
 * structurally the location-prompt tier of UI.
 *
 * The user enters the TOTAL; the split is `splitEvenPacket` (integer fen,
 * remainder front-loaded) over every AI member of the group — the same
 * function the bill service itself uses, so the preview per-head can never
 * disagree with what the card will say.
 */
import { useState } from 'react';
import { Sheet } from '../../components/Sheet';
import { useAppStore } from '../../store/appStore';
import { yuanToFen, fenToYuan, splitEvenPacket } from '../../lib/money';
import { createGroupBill } from '../../ai/bill-service';
import { logError } from '../../lib/errlog';
// Reuses the money feature's form vocabulary (money-form/money-hint/btn-money)
// — shared USE is fine; only defining a block's __children in two features is
// banned (css-ownership). The bill-specific blocks live in chat.css.
import '../money/money.css';

export function BillSheet({
  convId,
  open,
  onClose,
}: {
  convId: string;
  open: boolean;
  onClose: () => void;
}) {
  const conv = useAppStore((s) => s.conversationById(convId));
  const contactById = useAppStore((s) => s.contactById);
  const personaFor = useAppStore((s) => s.personaFor);
  const appendMessage = useAppStore((s) => s.appendMessage);
  const updateMessage = useAppStore((s) => s.updateMessage);
  const showToast = useAppStore((s) => s.showToast);

  const [amount, setAmount] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);

  const memberIds = (conv?.memberIds ?? []).filter((id) => personaFor(id));
  const fen = yuanToFen(amount || '0') ?? 0;
  const valid = conv?.type === 'group' && memberIds.length > 0 && fen >= memberIds.length;
  const perFen = valid ? splitEvenPacket(fen, memberIds.length)[0] : 0;

  const submit = async () => {
    if (!conv || !valid || busy) return;
    setBusy(true);
    try {
      await createGroupBill({
        convId,
        initiatorId: 'self',
        totalFen: fen,
        title: title.trim() || 'AA收款',
        participants: memberIds.map((id) => {
          const c = contactById(id);
          return { contactId: id, name: c?.remark ?? c?.name ?? id, persona: personaFor(id) };
        }),
        hooks: { appendMessage, updateMessage, now: () => Date.now() },
      });
      setAmount('');
      setTitle('');
      onClose();
    } catch (e) {
      logError('bill.create', e);
      showToast(e instanceof Error ? e.message : '发起失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={open} onClose={onClose} title="发起群收款">
      <div className="bill-sheet">
        <div className="money-form">
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
            <span className="money-form__label">收款用途</span>
            <input
              className="money-form__input"
              placeholder="例：昨晚的饭钱"
              value={title}
              onChange={(e) => setTitle(e.target.value.slice(0, 12))}
            />
          </div>
        </div>
        <div className="money-hint">
          {valid
            ? `${memberIds.length} 人平摊，每人 ${fenToYuan(perFen)} 元（余数前置）`
            : '输入总金额，向群里每位成员平摊收款'}
        </div>
        <button className="btn-money" disabled={!valid || busy} onClick={() => void submit()}>
          {busy ? '发起中…' : '发起收款'}
        </button>
      </div>
    </Sheet>
  );
}
