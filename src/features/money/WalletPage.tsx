import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SubNav } from '../../components/SubNav';
import { showPrompt } from '../../components/dialog';
import { repo } from '../../db/repo';
import { useAppStore } from '../../store/appStore';
import { fenToYuan, yuanToFen } from '../../lib/money';
import { currentBalance } from '../../lib/wallet';
import { recordWalletTx } from '../../ai/money-service';
import { logError } from '../../lib/errlog';
import './money.css';

/**
 * 零钱 (M-K3)：微信 8.0 的样子——绿色钱包图标、「我的零钱」、一行大号余额、
 * 「充值」「提现」两个按钮；流水在右上角的「零钱明细」里（./WalletBillPage）。
 *
 * 这里的钱是**模拟的**（宪法：永不做真实支付通信），所以充值 / 提现就是给本机
 * 账本记一笔 `adjust`：用户想发个大红包、余额不够，自己充一点就行。金额照旧是
 * 整数「分」（铁律 3），提现不许超过余额。
 */
export function WalletPage() {
  const navigate = useNavigate();
  const showToast = useAppStore((s) => s.showToast);
  const [balance, setBalance] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    const page = await repo.getWalletTxs({ limit: 1 });
    setBalance(currentBalance(page));
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const adjust = async (dir: 1 | -1) => {
    const raw = await showPrompt({
      title: dir > 0 ? '充值金额（模拟）' : '提现金额（模拟）',
      placeholder: '0.00',
    });
    if (raw == null) return;
    const fen = yuanToFen(raw.trim()) ?? 0;
    if (fen <= 0) return showToast('请输入大于 0 的金额');
    if (dir < 0 && fen > (balance ?? 0)) return showToast('零钱余额不足');
    try {
      const now = Date.now();
      await recordWalletTx('adjust', dir * fen, dir > 0 ? '零钱充值' : '零钱提现', `adj_${now}`, now);
      await refresh();
      showToast(dir > 0 ? '充值成功' : '提现成功');
    } catch (e) {
      logError('wallet.adjust', e);
      showToast('操作失败，请重试');
    }
  };

  return (
    <>
      <SubNav
        title=""
        right={
          <button className="navbar__btn navbar__text-btn" onClick={() => navigate('/wallet/bill')}>
            零钱明细
          </button>
        }
      />
      <div className="page-body wallet-home">
        <div className="wallet-home__icon" aria-hidden>
          <svg width="34" height="34" viewBox="0 0 34 34" fill="none">
            <rect x="4" y="9" width="26" height="19" rx="3" stroke="currentColor" strokeWidth="2.2" />
            <path d="M8 9 22.5 4.5a2 2 0 0 1 2.5 1.9V9" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" />
            <circle cx="24" cy="18.5" r="1.9" fill="currentColor" />
          </svg>
        </div>
        <div className="wallet-home__label">我的零钱</div>
        <div className="wallet-home__value">¥{balance == null ? '' : fenToYuan(balance)}</div>
        <div className="wallet-home__actions">
          <button className="wallet-home__btn wallet-home__btn--primary" onClick={() => void adjust(1)}>
            充值
          </button>
          <button className="wallet-home__btn" onClick={() => void adjust(-1)}>
            提现
          </button>
        </div>
        <p className="wallet-home__note">本 App 的钱全部是模拟的，只在这台手机上有效</p>
      </div>
    </>
  );
}
