/**
 * 用量明细 (M-I11). EnvDiagPage shows today's total; this page answers the
 * question that总数 cannot: "which day spiked, and what caused it" — the
 * background kinds (heartbeats, memory, moments, scheduling) spend the user's
 * own key with nobody pressing anything, so a per-day per-kind breakdown is
 * the difference between an honest system and a mysterious bill.
 *
 * Deliberately still CALLS, not tokens — see src/lib/usage.ts for why a wrong
 * number about money is worse than an honest count.
 */
import { useEffect, useState } from 'react';
import { SubNav } from '../../components/SubNav';
import { getUsage, clearUsage, KIND_LABELS, type DayUsage, type UsageKind } from '../../lib/usage';
import { useAppStore } from '../../store/appStore';
import './settings.css';

function dayLabel(day: number): string {
  const d = new Date(day * 86_400_000);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** Kinds of one day, largest first, labels resolved. */
function kindRows(u: DayUsage): Array<{ label: string; n: number }> {
  return Object.entries(u.counts)
    .map(([kind, n]) => ({ label: KIND_LABELS[kind as UsageKind] ?? kind, n }))
    .sort((a, b) => b.n - a.n);
}

export function UsagePage() {
  const showToast = useAppStore((s) => s.showToast);
  const [usage, setUsage] = useState<{ today: DayUsage; history: DayUsage[] } | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  const refresh = () => {
    void getUsage(Date.now())
      .then(setUsage)
      .catch(() => {});
  };
  useEffect(refresh, []);

  const history = usage?.history ?? [];
  const max = Math.max(1, ...history.map((d) => d.total));
  const total = history.reduce((n, d) => n + d.total, 0);

  return (
    <>
      <SubNav title="用量明细" />
      <div className="page-body settings">
        <div className="settings__group">
          <div className="settings__group-title">
            最近 {history.length || 0} 天 · 共 {total} 次调用
          </div>
          {history.length === 0 && (
            <p className="settings__hint">还没有任何调用记录。</p>
          )}
          {history.map((d) => (
            <div key={d.day}>
              <div
                className="settings__row settings__row--divided"
                onClick={() => setOpen(open === d.day ? null : d.day)}
              >
                <span className="settings__label">{dayLabel(d.day)}</span>
                <span className="usage-bar" aria-hidden>
                  <span
                    className="usage-bar__fill"
                    style={{ width: `${Math.round((d.total / max) * 100)}%` }}
                  />
                </span>
                <span className="settings__value">{d.total} 次</span>
              </div>
              {open === d.day &&
                kindRows(d).map((r) => (
                  <div className="settings__row settings__row--divided usage-detail" key={r.label}>
                    <span className="settings__label usage-detail__label">{r.label}</span>
                    <span className="settings__value">{r.n} 次</span>
                  </div>
                ))}
            </div>
          ))}
          <p className="settings__hint">
            按天计次，保留 14 天。点一天可展开按用途的拆分。心跳、记忆整理、朋友圈、
            群聊调度这些没人按按钮也会发生——用的是你自己的 key。
          </p>
        </div>
        {history.length > 0 && (
          <button
            className="btn-ghost"
            onClick={() => {
              void (async () => {
                await clearUsage();
                refresh();
                showToast('用量已清空');
              })();
            }}
          >
            清空用量记录
          </button>
        )}
      </div>
    </>
  );
}
