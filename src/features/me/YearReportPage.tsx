/**
 * 聊天年度报告 (M-I14; multi-dimension + year switching M-J12) — a WeChat-
 * annual-report style full-screen scroll story, computed entirely on device.
 *
 * Data flow: visible conversations (hidden ones are dropped HERE as defense in
 * depth, and again inside computeReport — the real guarantee) → the WHOLE
 * history per conversation via `scanAllMessages` (paged, capped at 20k rows
 * per thread — hitting the cap shows「统计截断」, never a silently wrong
 * number) → moments + social rows, wallet ledger and story saves → one pure
 * `computeReport` pass per selected year. `?year=` picks the year; the chips
 * list every year the data actually touches.
 *
 * story_saves is read through src/ai/story-gm's own idb accessor — that module
 * bypasses the Repo (known debt, M-J12 reads it but does not re-architect).
 *
 * Motion discipline: scroll-snap for the paging, IntersectionObserver toggling
 * a class, CSS transitions/keyframes for everything that moves. No rAF.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAppStore } from '../../store/appStore';
import { repo } from '../../db/repo';
import {
  computeReport,
  scanAllMessages,
  scanTruncatedForYear,
  yearsWithData,
  type MessageScan,
  type ReportInput,
  type ReportStorySave,
  type YearReport,
} from '../../lib/report';
import {
  renderReportImage,
  reportImageLines,
  type ReportImagePalette,
} from '../../lib/report-image';
import { saveBlobFile } from '../../lib/save-file';
import { listSaves } from '../../ai/story-gm';
import { fenToYuan } from '../../lib/money';
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

/** Everything the page pulled once; year switching recomputes without refetch. */
interface ReportPool {
  scan: MessageScan;
  base: Omit<ReportInput, 'year'>;
}

export function YearReportPage() {
  const navigate = useNavigate();
  const conversations = useAppStore((s) => s.conversations);
  const contacts = useAppStore((s) => s.contacts);
  const [pool, setPool] = useState<ReportPool | null>(null);
  const [failed, setFailed] = useState(false);

  const [params, setParams] = useSearchParams();

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        // Defense in depth: hidden conversations are excluded before we even
        // fetch. computeReport filters again — that inner filter is the tested
        // guarantee; this one just avoids reading rows we will never use.
        const visible = conversations.filter((c) => !c.isHidden);
        const scan = await scanAllMessages(
          visible.map((c) => c.id),
          { page: (convId, beforeId, limit) => repo.getMessages(convId, { beforeId, limit }) },
        );
        const [walletTxs, moments] = await Promise.all([
          repo.getWalletTxs(),
          repo.getMoments({ limit: 100_000 }),
        ]);
        const { likes, comments } = await repo.getMomentSocial(moments.map((m) => m.id));
        const storySaves: ReportStorySave[] = (await listSaves()).map((s) => ({
          scriptId: s.scriptId,
          endingId: s.endingId,
          endedAt: s.endedAt,
        }));
        if (!alive) return;
        setPool({
          scan,
          base: {
            conversations: visible,
            messagesByConv: scan.messagesByConv,
            contacts,
            walletTxs,
            now: Date.now(),
            moments,
            momentLikes: Object.values(likes).flat(),
            momentComments: Object.values(comments).flat(),
            storySaves,
          },
        });
      } catch (e) {
        logError('report.compute', e);
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [conversations, contacts]);

  const years = useMemo(() => (pool ? yearsWithData(pool.base) : []), [pool]);

  // ?year= picks the year; anything unknown falls back to the newest.
  const yearParam = Number(params.get('year'));
  const year = years.includes(yearParam) ? yearParam : (years[0] ?? new Date().getFullYear());

  const report = useMemo(
    () => (pool ? computeReport({ ...pool.base, year }) : null),
    [pool, year],
  );
  const truncated = pool ? scanTruncatedForYear(pool.scan, year) : false;

  return (
    <div className="report">
      <button className="report__close" onClick={() => navigate(-1)} aria-label="关闭">
        ✕
      </button>
      {truncated && (
        <div className="report__truncated" role="status">
          部分会话超过 20000 条消息，本年统计已截断
        </div>
      )}
      {failed ? (
        <div className="report__loading">统计失败了，回去再试一次吧</div>
      ) : !report ? (
        <div className="report__loading">正在翻你们的聊天记录…</div>
      ) : (
        <ReportBody
          r={report}
          years={years}
          onPickYear={(y) => setParams({ year: String(y) }, { replace: true })}
        />
      )}
    </div>
  );
}

/* ==================================================================== */

function ReportBody({
  r,
  years,
  onPickYear,
}: {
  r: YearReport;
  years: number[];
  onPickYear: (y: number) => void;
}) {
  const maxHour = Math.max(1, ...r.hourHistogram);
  const maxWord = Math.max(1, ...r.topWords.map((w) => w.count));
  const maxTalker = Math.max(1, ...r.topTalkers.map((t) => t.count));
  const rootRef = useRef<HTMLDivElement>(null);
  const [saving, setSaving] = useState(false);

  const saveLongImage = async () => {
    if (saving) return;
    setSaving(true);
    try {
      // Canvas cannot read var(); resolve the report tokens at runtime so the
      // image follows the SAME palette the page renders with (rule #1: the
      // literals stay in tokens.css).
      const cs = getComputedStyle(rootRef.current ?? document.documentElement);
      const token = (name: string) => cs.getPropertyValue(name).trim();
      const palette: ReportImagePalette = {
        bgA: token('--color-report-bg-a'),
        bgB: token('--color-report-bg-b'),
        text: token('--color-report-text'),
        dim: token('--color-report-dim'),
        accent: token('--color-report-accent'),
        hairline: token('--color-report-hairline'),
      };
      const canvas = document.createElement('canvas');
      renderReportImage(canvas, reportImageLines(r), palette);
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
      if (!blob) throw new Error('图片导出失败');
      await saveBlobFile(`聊天年度报告-${r.year}.png`, blob, '保存年度报告长图');
    } catch (e) {
      logError('report.longImage', e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="report__scroll" ref={rootRef}>
      <Section className="report__cover">
        <div className="report__year">{r.year}</div>
        <div className="report__title">聊天年度报告</div>
        <div className="report__sub">你和你的朋友们，这一年都聊了什么</div>
        {years.length > 1 && (
          <div className="report__years" role="tablist" aria-label="选择年份">
            {years.map((y) => (
              <button
                key={y}
                role="tab"
                aria-selected={y === r.year}
                className={`report__year-chip${y === r.year ? ' report__year-chip--on' : ''}`}
                onClick={() => onPickYear(y)}
              >
                {y}
              </button>
            ))}
          </div>
        )}
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

      {(r.momentsStat.posts > 0 ||
        r.momentsStat.likesReceived > 0 ||
        r.momentsStat.commentsReceived > 0) && (
        <Section>
          <div className="report__lead">朋友圈的一年</div>
          <div className="report__big">
            {r.momentsStat.posts}
            <span className="report__unit">条动态</span>
          </div>
          <div className="report__line">
            收到 <em>{r.momentsStat.likesReceived}</em> 个赞、
            <em>{r.momentsStat.commentsReceived}</em> 条评论
          </div>
          {r.momentsStat.topCommenters.length > 0 && (
            <div className="report__line">
              评论你最多的是 <em>{r.momentsStat.topCommenters[0].name}</em>（
              {r.momentsStat.topCommenters[0].count} 条）
            </div>
          )}
        </Section>
      )}

      {(r.callsStat.count > 0 || r.callsStat.missed > 0) && (
        <Section>
          <div className="report__lead">打过的电话</div>
          <div className="report__big">
            {r.callsStat.count}
            <span className="report__unit">通</span>
          </div>
          <div className="report__line">
            加起来聊了 <em>{fmtDuration(r.callsStat.totalMs)}</em>
          </div>
          {r.callsStat.longest && (
            <div className="report__line">
              最长的一通在 <em>{fmtDate(r.callsStat.longest.at)}</em>，和{' '}
              {r.callsStat.longest.convTitle} 聊了 {fmtDuration(r.callsStat.longest.ms)}
            </div>
          )}
          {r.callsStat.missed > 0 && (
            <div className="report__line">还有 {r.callsStat.missed} 通没有接上</div>
          )}
        </Section>
      )}

      {r.storyStat.runsCompleted > 0 && (
        <Section>
          <div className="report__lead">走完的剧情</div>
          <div className="report__big">
            {r.storyStat.runsCompleted}
            <span className="report__unit">个周目</span>
          </div>
          <div className="report__line">
            解锁了 <em>{r.storyStat.endingsSeen}</em> 个结局
          </div>
        </Section>
      )}

      {r.gameStat.diceThrows + r.gameStat.rpsThrows > 0 && (
        <Section>
          <div className="report__lead">表情游戏战绩</div>
          <div className="report__big">
            {r.gameStat.wins}
            <span className="report__unit">胜</span> {r.gameStat.losses}
            <span className="report__unit">负</span> {r.gameStat.draws}
            <span className="report__unit">平</span>
          </div>
          <div className="report__line">
            掷了 <em>{r.gameStat.diceThrows}</em> 次骰子，六点开出 {r.gameStat.sixes} 回
          </div>
          <div className="report__line">
            猜拳出手 <em>{r.gameStat.rpsThrows}</em> 次
          </div>
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
        <button className="report__save" disabled={saving} onClick={() => void saveLongImage()}>
          {saving ? '正在生成…' : '保存长图'}
        </button>
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
