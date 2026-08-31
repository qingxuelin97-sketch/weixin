/**
 * 聊天年度报告 (M-I14; specs/year-report.md) — a WeChat-annual-report style
 * full-screen scroll story, computed entirely on device.
 *
 * Data flow: visible conversations (hidden ones are dropped HERE as defense in
 * depth, and again inside computeReport — the real guarantee) → up to 2000
 * messages per conversation from the repo → one pure `computeReport` pass.
 *
 * Motion discipline: scroll-snap for the paging, IntersectionObserver toggling
 * a class, CSS transitions/keyframes for everything that moves. No rAF.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAppStore } from '../../store/appStore';
import { repo } from '../../db/repo';
import { computeReport, type YearReport } from '../../lib/report';
import { fenToYuan } from '../../lib/money';
import type { MessageVM } from '../../data/types';
import { logError } from '../../lib/errlog';
import './report.css';

const HOUR_LABELS = ['凌晨', '早上', '下午', '深夜'];

function hourWord(h: number): string {
  if (h < 6) return HOUR_LABELS[0];
  if (h < 12) return HOUR_LABELS[1];
  if (h < 19) return HOUR_LABELS[2];
  return HOUR_LABELS[3];
}

function fmtDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

function fmtDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${Math.max(1, min)} 分钟`;
  return `${Math.floor(min / 60)} 小时 ${min % 60} 分钟`;
}

export function YearReportPage() {
  const navigate = useNavigate();
  const conversations = useAppStore((s) => s.conversations);
  const contacts = useAppStore((s) => s.contacts);
  const [report, setReport] = useState<YearReport | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        // Defense in depth: hidden conversations are excluded before we even
        // fetch. computeReport filters again — that inner filter is the tested
        // guarantee; this one just avoids reading rows we will never use.
        const visible = conversations.filter((c) => !c.isHidden);
        const messagesByConv: Record<string, MessageVM[]> = {};
        for (const conv of visible) {
          messagesByConv[conv.id] = await repo.getMessages(conv.id, { limit: 2000 });
        }
        const walletTxs = await repo.getWalletTxs();
        if (!alive) return;
        setReport(
          computeReport({
            conversations: visible,
            messagesByConv,
            contacts,
            walletTxs,
            now: Date.now(),
          }),
        );
      } catch (e) {
        logError('report.compute', e);
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [conversations, contacts]);

  return (
    <div className="report">
      <button className="report__close" onClick={() => navigate(-1)} aria-label="关闭">
        ✕
      </button>
      {failed ? (
        <div className="report__loading">统计失败了，回去再试一次吧</div>
      ) : !report ? (
        <div className="report__loading">正在翻你们的聊天记录…</div>
      ) : (
        <ReportBody r={report} />
      )}
    </div>
  );
}

/* ==================================================================== */

function ReportBody({ r }: { r: YearReport }) {
  const maxHour = Math.max(1, ...r.hourHistogram);
  const maxWord = Math.max(1, ...r.topWords.map((w) => w.count));
  const maxTalker = Math.max(1, ...r.topTalkers.map((t) => t.count));
  return (
    <div className="report__scroll">
      <Section className="report__cover">
        <div className="report__year">{r.year}</div>
        <div className="report__title">聊天年度报告</div>
        <div className="report__sub">你和你的朋友们，这一年都聊了什么</div>
        <div className="report__hint">往下滑 ↓</div>
      </Section>

      <Section>
        <div className="report__lead">这一年，你们一共聊了</div>
        <div className="report__big">
          {r.totalMessages}
          <span className="report__unit">条消息</span>
        </div>
        <div className="report__line">
          其中 <em>{r.selfMessages}</em> 条是你发出去的
        </div>
        <div className="report__line">
          有 <em>{r.activeDays}</em> 天，你们至少说上了一句话
        </div>
        {r.busiestDay && (
          <div className="report__line">
            聊得最凶的一天是 <em>{fmtDate(r.busiestDay.dayStart)}</em>，一天 {r.busiestDay.count} 条
          </div>
        )}
      </Section>

      {r.topTalkers.length > 0 && (
        <Section>
          <div className="report__lead">话最多的是</div>
          <div className="report__hero-name">{r.topTalkers[0].name}</div>
          <div className="report__bars">
            {r.topTalkers.map((t) => (
              <div key={t.contactId} className="report__bar-row">
                <span className="report__bar-label">{t.name}</span>
                <div className="report__bar-track">
                  <div
                    className="report__bar-fill"
                    style={{ width: `${Math.max(6, Math.round((t.count / maxTalker) * 100))}%` }}
                  />
                </div>
                <span className="report__bar-count">{t.count}</span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {r.peakHour != null && (
        <Section>
          <div className="report__lead">你最爱说话的时刻</div>
          <div className="report__big">
            {hourWord(r.peakHour)} {r.peakHour}
            <span className="report__unit">点</span>
          </div>
          <div className="report__hours" aria-hidden>
            {r.hourHistogram.map((n, h) => (
              <div key={h} className="report__hour-col">
                <div
                  className={`report__hour-bar${h === r.peakHour ? ' report__hour-bar--peak' : ''}`}
                  style={{ height: `${Math.max(3, Math.round((n / maxHour) * 100))}%` }}
                />
                {h % 6 === 0 && <span className="report__hour-tick">{h}</span>}
              </div>
            ))}
          </div>
          {r.latestNight && (
            <div className="report__line">
              最深的一夜：<em>{fmtDate(r.latestNight.at)}</em>{' '}
              {new Date(r.latestNight.at).getHours()}:
              {String(new Date(r.latestNight.at).getMinutes()).padStart(2, '0')}
              ，你还在和 {r.latestNight.convTitle} 聊
            </div>
          )}
        </Section>
      )}

      <Section>
        <div className="report__lead">红包与转账的往来</div>
        <div className="report__money">
          <div className="report__money-cell">
            <div className="report__money-num">￥{fenToYuan(r.money.sentFen)}</div>
            <div className="report__money-label">发出 {r.money.sentCount} 笔</div>
          </div>
          <div className="report__money-divider" />
          <div className="report__money-cell">
            <div className="report__money-num">￥{fenToYuan(r.money.receivedFen)}</div>
            <div className="report__money-label">收到 {r.money.receivedCount} 笔</div>
          </div>
        </div>
        <div className="report__line">
          {r.money.sentFen >= r.money.receivedFen
            ? '这一年，你是更舍得发的那一个'
            : '这一年，你是被偏爱的那一个'}
        </div>
      </Section>

      {r.longestSession && (
        <Section>
          <div className="report__lead">聊到停不下来的那次</div>
          <div className="report__hero-name">{r.longestSession.convTitle}</div>
          <div className="report__line">
            <em>{fmtDate(r.longestSession.startAt)}</em>，一口气 <em>{r.longestSession.count}</em>{' '}
            条来回
          </div>
          <div className="report__line">持续了 {fmtDuration(r.longestSession.durationMs)}</div>
        </Section>
      )}

      {r.topWords.length > 0 && (
        <Section>
          <div className="report__lead">你的年度常用词</div>
          <div className="report__hero-name">「{r.topWords[0].word}」</div>
          <div className="report__words">
            {r.topWords.map((w) => (
              <span
                key={w.word}
                className="report__word"
                style={{ fontSize: `${14 + Math.round((w.count / maxWord) * 14)}px` }}
              >
                {w.word}
              </span>
            ))}
          </div>
        </Section>
      )}

      <Section className="report__ending">
        <div className="report__title">聊天记录会过期</div>
        <div className="report__sub">说过的话不会</div>
        <div className="report__foot">
          {r.year} 聊天年度报告 · 纯本地统计，未上传任何数据
        </div>
      </Section>
    </div>
  );
}

/**
 * One snap page. Reveals its content (CSS transition) when ≥30% enters the
 * viewport — IntersectionObserver toggles a class; the browser animates.
 */
function Section({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) el.classList.add('report__sec--in');
      },
      { threshold: 0.3 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <section ref={ref} className={`report__sec ${className}`}>
      <div className="report__sec-inner">{children}</div>
    </section>
  );
}
