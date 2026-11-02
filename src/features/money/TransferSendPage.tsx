import { useCallback, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { SubNav } from '../../components/SubNav';
import { Avatar } from '../../components/Avatar';
import { showPrompt } from '../../components/dialog';
import { useAppStore } from '../../store/appStore';
import { yuanToFen } from '../../lib/money';
import { sendTransfer } from '../../ai/money-service';
import { logError } from '../../lib/errlog';
import { MoneyKeypad } from './MoneyKeypad';
import { applyAmountKey, type AmountKey } from './keypad';
import './money.css';

/**
 * 转账 (M-K3)：微信 8.0 的版式——对方头像与名字在上，白卡片里「转账金额 ¥___」，
 * 「添加转账说明」是一行链接，底部是自己的数字键盘，绿色「转账」键跨三行。
 *
 * 此前是系统输入框 + 一颗**橙色**按钮，而且金额输入框整个被挤在屏幕外
 * （K0 修 flex 收缩时才发现）。金额仍是整数「分」（铁律 3），解析照旧走 yuanToFen。
 */
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

  const onKey = useCallback((k: AmountKey) => setAmount((a) => applyAmountKey(a, k)), []);

  const editNote = async () => {
    const v = await showPrompt({
      title: '转账说明',
      placeholder: '最多 20 个字',
      initial: note,
      maxLength: 20,
      allowEmpty: true,
    });
    if (v != null) setNote(v.trim().slice(0, 20));
  };

  const submit = useCallback(async () => {
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
  }, [conv?.peerId, valid, busy, convId, fen, note, appendMessage, updateMessage, navigate]);

  return (
    <>
      <SubNav title="" />
      <div className="page-body transfer">
        <div className="transfer__peer">
          {peer && (
            <Avatar color={peer.avatarColor} text={peer.avatarText} imageRef={peer.avatarRef} size={48} />
          )}
          <div className="transfer__to">转账给 {peer?.remark ?? peer?.name ?? ''}</div>
          {peer?.wxid && <div className="transfer__wxid">微信号：{peer.wxid}</div>}
        </div>
        <div className="transfer__card">
          <div className="transfer__label">转账金额</div>
          <div className="transfer__amount" aria-label="转账金额" aria-live="polite">
            <span className="transfer__yen">¥</span>
            <span className="transfer__digits">{amount}</span>
            <span className="transfer__caret" aria-hidden />
          </div>
          <button className="transfer__note" onClick={() => void editNote()}>
            {note ? `转账说明：${note}` : '添加转账说明'}
          </button>
          {error && <div className="money-error">{error}</div>}
        </div>
      </div>
      <MoneyKeypad onKey={onKey} onConfirm={() => void submit()} confirmLabel={busy ? '处理中' : '转账'} disabled={!valid || busy} />
    </>
  );
}
