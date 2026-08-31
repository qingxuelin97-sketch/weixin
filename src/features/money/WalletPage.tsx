import { useEffect, useMemo, useState } from 'react';
import { SubNav } from '../../components/SubNav';
import { repo } from '../../db/repo';
import { useAppStore } from '../../store/appStore';
import { fenToYuan } from '../../lib/money';
import { currentBalance } from '../../lib/wallet';
import type { WalletTxVM } from '../../data/types';
import './money.css';

/**
 * 零钱 (rebuilt M-J8): balance + a PAGED ledger.
 *
 * The pre-J8 page read the whole `wallet_tx` store on every open — the ledger
 * only ever grows, so the bill page got slower for the life of the install
 * while showing the same screen (the moments lesson, one store over). Now the
 * first screen costs one page (`getWalletTxs({limit})`, cursor-paged through
 * the v10 byCreatedAt index; perf-budget pins it), 加载更多 walks history on
 * demand, and the rows group by month with per-month in/out subtotals plus
 * type / counterparty filter chips.
 *
 * Balance still comes from the FIRST page only: `currentBalance` needs the
 * newest row's running total, which the newest page contains by construction.
 */
export function WalletPage() {
  const contactById = useAppStore((s) => s.contactById);
  const [txs, setTxs] = useState<WalletTxVM[]>([]); // ascending, as the repo serves
  const [balance, setBalance] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('all');
  const [peerFilter, setPeerFilter] = useState<string>('all');

  useEffect(() => {
    void repo.getWalletTxs({ limit: PAGE }).then((page) => {
      setTxs(page);
      setBalance(currentBalance(page));
      setHasMore(page.length === PAGE);
    });
  }, []);

  const loadMore = async () => {
    if (busy || txs.length === 0) return;
    setBusy(true);
    try {
      const older = await repo.getWalletTxs({ limit: PAGE, before: txs[0].createdAt });
      setTxs((cur) => [...older, ...cur]);
      setHasMore(older.length === PAGE);
    } finally {
      setBusy(false);
    }
  };

  // Counterparty chips: the distinct peerIds of what is LOADED (old rows have
  // none and only match 全部). Names resolve through contacts; a deleted
  // contact's id degrades to itself rather than hiding the money.
  const peers = useMemo(() => {
    const ids = [...new Set(txs.flatMap((t) => (t.peerId ? [t.peerId] : [])))];
    return ids.map((id) => ({ id, name: contactById(id)?.remark ?? contactById(id)?.name ?? id }));
  }, [txs, contactById]);

  const shown = useMemo(() => {
    const newestFirst = [...txs].reverse();
    return newestFirst.filter(
      (t) =>
        (typeFilter === 'all' || KIND_GROUP[t.kind] === typeFilter) &&
        (peerFilter === 'all' || t.peerId === peerFilter),
    );
  }, [txs, typeFilter, peerFilter]);

  // 按月分组 + 月度小计 (of the loaded/filtered rows — the subtotal labels the
  // group it renders, never pretends to cover unloaded history).
  const months = useMemo(() => {
    const out: Array<{ label: string; inFen: number; outFen: number; rows: WalletTxVM[] }> = [];
    for (const t of shown) {
      const d = new Date(t.createdAt);
      const label = `${d.getFullYear()}年${d.getMonth() + 1}月`;
      let g = out.at(-1);
      if (!g || g.label !== label) {
        g = { label, inFen: 0, outFen: 0, rows: [] };
        out.push(g);
      }
      if (t.amountFen > 0) g.inFen += t.amountFen;
      else g.outFen += -t.amountFen;
      g.rows.push(t);
    }
    return out;
  }, [shown]);

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

          <div className="wallet__filters">
            {TYPE_TABS.map((t) => (
              <button
                key={t.key}
                className={`wallet__chip${typeFilter === t.key ? ' wallet__chip--on' : ''}`}
                onClick={() => setTypeFilter(t.key)}
              >
                {t.label}
              </button>
            ))}
          </div>
          {peers.length > 0 && (
            <div className="wallet__filters">
              <button
                className={`wallet__chip${peerFilter === 'all' ? ' wallet__chip--on' : ''}`}
                onClick={() => setPeerFilter('all')}
              >
                所有人
              </button>
              {peers.map((p) => (
                <button
                  key={p.id}
                  className={`wallet__chip${peerFilter === p.id ? ' wallet__chip--on' : ''}`}
                  onClick={() => setPeerFilter(peerFilter === p.id ? 'all' : p.id)}
                >
                  {p.name}
                </button>
              ))}
            </div>
          )}

          {shown.length === 0 ? (
            <div className="wallet__empty">暂无交易记录</div>
          ) : (
            months.map((m) => (
              <div key={m.label}>
                <div className="wallet__month">
                  <span>{m.label}</span>
                  <span className="wallet__month-sum">
                    支出 ¥{fenToYuan(m.outFen)} · 收入 ¥{fenToYuan(m.inFen)}
                  </span>
                </div>
                {m.rows.map((t) => (
                  <div key={t.id} className="wallet__row">
                    <div>
                      <div className="wallet__row-title">{t.title}</div>
                      <div className="wallet__row-time">
                        {formatTime(t.createdAt)}
                        {t.peerId && ` · ${contactById(t.peerId)?.remark ?? contactById(t.peerId)?.name ?? ''}`}
                      </div>
                    </div>
                    <div className={`wallet__amount${t.amountFen > 0 ? ' wallet__amount--in' : ''}`}>
                      {t.amountFen > 0 ? '+' : '-'}
                      {fenToYuan(Math.abs(t.amountFen))}
                    </div>
                  </div>
                ))}
              </div>
            ))
          )}

          {hasMore && (
            <button className="wallet__more" disabled={busy} onClick={() => void loadMore()}>
              {busy ? '加载中…' : '加载更多'}
            </button>
          )}
        </div>
      </div>
    </>
  );
}

/** First-screen (and per-fetch) page size. perf-budget pins reads ≤ this. */
const PAGE = 30;

type TypeFilter = 'all' | 'rp' | 'transfer' | 'bill' | 'other';

const TYPE_TABS: Array<{ key: TypeFilter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'rp', label: '红包' },
  { key: 'transfer', label: '转账' },
  { key: 'bill', label: '群收款' },
];

const KIND_GROUP: Record<WalletTxVM['kind'], TypeFilter> = {
  rp_in: 'rp',
  rp_out: 'rp',
  transfer_in: 'transfer',
  transfer_out: 'transfer',
  bill_in: 'bill',
  bill_out: 'bill',
  adjust: 'other',
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}
