import { useEffect, useState } from 'react';
import { SubNav } from '../../components/SubNav';
import { repo } from '../../db/repo';
import { fenToYuan } from '../../lib/money';
import { currentBalance } from '../../lib/wallet';
import type { WalletTxVM } from '../../data/types';
import './money.css';

/** 零钱: balance + ledger. Every red packet and transfer lands here. */
export function WalletPage() {
  const [txs, setTxs] = useState<WalletTxVM[]>([]);

  useEffect(() => {
    void repo.getWalletTxs().then(setTxs);
  }, []);

  const balance = currentBalance(txs);
  const recent = [...txs].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <>
      <SubNav title="零钱" />
      <div className="page-body money-page">
        <div className="wallet__balance">
          <div className="wallet__label">零钱余额（元）</div>
          <div className="wallet__value">{fenToYuan(balance)}</div>
        </div>

        <div className="wallet__list">
          <div className="wallet__title">零钱明细</div>
          {recent.length === 0 ? (
            <div className="wallet__empty">暂无交易记录</div>
          ) : (
            recent.map((t) => (
              <div key={t.id} className="wallet__row">
                <div>
                  <div className="wallet__row-title">{t.title}</div>
                  <div className="wallet__row-time">{formatTime(t.createdAt)}</div>
                </div>
                <div className={`wallet__amount${t.amountFen > 0 ? ' wallet__amount--in' : ''}`}>
                  {t.amountFen > 0 ? '+' : '-'}
                  {fenToYuan(Math.abs(t.amountFen))}
                </div>
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}
