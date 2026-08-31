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
import {
  getUsage,
  clearUsage,
  dayTokens,
  KIND_LABELS,
  type DayUsage,
  type UsageKind,
} from '../../lib/usage';
import { budgetStatus } from '../../ai/cost-gate';
import { useAppStore } from '../../store/appStore';
import './settings.css';

function dayLabel(day: number): string {
  const d = new Date(day * 86_400_000);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

/** 12345 → "1.2万"; below 10k, the raw number. */
function fmtTokens(n: number): string {
  return n >= 10_000 ? `${(n / 10_000).toFixed(1)}万` : String(n);
}

/** Kinds of one day, largest first, labels resolved (tokens best-effort). */
function kindRows(u: DayUsage): Array<{ label: string; n: number; tokens: number }> {
  return Object.entries(u.counts)
    .map(([kind, n]) => ({
      label: KIND_LABELS[kind as UsageKind] ?? kind,
      n,
      tokens: u.tokens?.[kind] ?? 0,
    }))
    .sort((a, b) => b.n - a.n);
}

export function UsagePage() {
  const showToast = useAppStore((s) => s.showToast);
  const [usage, setUsage] = useState<{ today: DayUsage; history: DayUsage[] } | null>(null);
  const [budget, setBudget] = useState<Awaited<ReturnType<typeof budgetStatus>> | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  const refresh = () => {
    void getUsage(Date.now())
      .then(setUsage)
      .catch(() => {});
    void budgetStatus(Date.now())
      .then(setBudget)
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
        {/* 成本闸 (M-J1)：今日消耗对着预算看，超了它会替你踩刹车。 */}
        {budget && (
          <div className="settings__group">
            <div className="settings__group-title">预算</div>
            <div className="settings__row settings__row--divided">
              <span className="settings__label">今日</span>
              <span className="settings__value">
                {budget.dayUsed} / {budget.dayBudget} 次
              </span>
            </div>
            <div className="settings__row settings__row--divided">
              <span className="settings__label">本小时</span>
              <span className="settings__value">
                {budget.hourUsed} / {budget.hourBudget} 次
              </span>
            </div>
            <p className="settings__hint">
              超出预算后：聊天里她会说累了晚点聊；后台动作原地等到下一个时段再跑，不会丢。
            </p>
          </div>
        )}
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
                <span className="settings__value">
                  {d.total} 次{dayTokens(d) > 0 ? ` · ${fmtTokens(dayTokens(d))} tok` : ''}
                </span>
              </div>
              {open === d.day &&
                kindRows(d).map((r) => (
                  <div className="settings__row settings__row--divided usage-detail" key={r.label}>
                    <span className="settings__label usage-detail__label">{r.label}</span>
                    <span className="settings__value">
                      {r.n} 次{r.tokens > 0 ? ` · ${fmtTokens(r.tokens)} tok` : ''}
                    </span>
                  </div>
                ))}
            </div>
          ))}
          <p className="settings__hint">
            按天计次，保留 14 天。点一天可展开按用途的拆分——语音合成/识别与图片生成
            也各自计次。心跳、记忆整理、朋友圈、群聊调度这些没人按按钮也会发生——
            用的是你自己的 key。token 数只在服务商返回 usage 字段时累计，拿不到就不估算，
            所以它是参考量级，不是账单。
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
