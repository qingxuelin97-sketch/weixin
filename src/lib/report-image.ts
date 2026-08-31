/**
 * 年度报告长图 (M-J12) — compose the report into one 390-wide shareable PNG.
 *
 * Split in two on purpose:
 *   - `reportImageLines(report)` is PURE: it decides what the image SAYS
 *     (every number, every label), so tests can hold the content without a
 *     canvas — the year, the fen formatting, the section set.
 *   - `renderReportImage(canvas, lines, palette)` only draws. Colors arrive as
 *     a palette the PAGE resolves from the CSS tokens at runtime
 *     (getComputedStyle) — this file holds zero literals, keeping constitution
 *     rule #1 intact even though canvas cannot read var() itself.
 */
import { fenToYuan } from './money';
import type { YearReport } from './report';

export interface ReportImagePalette {
  bgA: string;
  bgB: string;
  text: string;
  dim: string;
  accent: string;
  hairline: string;
}

export type ReportImageLine =
  | { kind: 'title'; text: string }
  | { kind: 'head'; text: string }
  | { kind: 'big'; text: string }
  | { kind: 'line'; text: string }
  | { kind: 'gap' }
  | { kind: 'foot'; text: string };

function fmtDuration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${Math.max(1, min)} 分钟`;
  return `${Math.floor(min / 60)} 小时 ${min % 60} 分钟`;
}

/** Everything the long image says, top to bottom. Pure — unit-locked. */
export function reportImageLines(r: YearReport): ReportImageLine[] {
  const out: ReportImageLine[] = [
    { kind: 'title', text: `${r.year} 聊天年度报告` },
    { kind: 'gap' },
    { kind: 'head', text: '这一年，你们聊了' },
    { kind: 'big', text: `${r.totalMessages} 条` },
    { kind: 'line', text: `你发出 ${r.selfMessages} 条 · 聊了 ${r.activeDays} 天` },
  ];
  if (r.topTalkers.length > 0) {
    out.push({ kind: 'gap' }, { kind: 'head', text: '话最多的是' });
    out.push({ kind: 'big', text: r.topTalkers[0].name });
    out.push({ kind: 'line', text: `${r.topTalkers[0].count} 条消息` });
  }
  if (r.peakHour != null) {
    out.push({ kind: 'gap' }, { kind: 'head', text: '你最爱说话的时刻' });
    out.push({ kind: 'big', text: `${r.peakHour} 点` });
  }
  out.push(
    { kind: 'gap' },
    { kind: 'head', text: '红包与转账' },
    {
      kind: 'line',
      text: `发出 ￥${fenToYuan(r.money.sentFen)}（${r.money.sentCount} 笔） · 收到 ￥${fenToYuan(r.money.receivedFen)}（${r.money.receivedCount} 笔）`,
    },
  );
  if (r.momentsStat.posts > 0 || r.momentsStat.likesReceived > 0 || r.momentsStat.commentsReceived > 0) {
    out.push({ kind: 'gap' }, { kind: 'head', text: '朋友圈' });
    out.push({
      kind: 'line',
      text: `发了 ${r.momentsStat.posts} 条 · 收到 ${r.momentsStat.likesReceived} 个赞 · ${r.momentsStat.commentsReceived} 条评论`,
    });
    if (r.momentsStat.topCommenters.length > 0) {
      out.push({
        kind: 'line',
        text: `评论你最多的是 ${r.momentsStat.topCommenters[0].name}`,
      });
    }
  }
  if (r.callsStat.count > 0) {
    out.push({ kind: 'gap' }, { kind: 'head', text: '通话' });
    out.push({
      kind: 'line',
      text: `${r.callsStat.count} 次 · 共 ${fmtDuration(r.callsStat.totalMs)}`,
    });
    if (r.callsStat.longest) {
      out.push({
        kind: 'line',
        text: `最长的一通 ${fmtDuration(r.callsStat.longest.ms)}，和 ${r.callsStat.longest.convTitle}`,
      });
    }
  }
  if (r.storyStat.runsCompleted > 0) {
    out.push({ kind: 'gap' }, { kind: 'head', text: '剧情' });
    out.push({
      kind: 'line',
      text: `完成 ${r.storyStat.runsCompleted} 个周目 · 解锁 ${r.storyStat.endingsSeen} 个结局`,
    });
  }
  const g = r.gameStat;
  if (g.diceThrows + g.rpsThrows > 0) {
    out.push({ kind: 'gap' }, { kind: 'head', text: '表情游戏战绩' });
    out.push({
      kind: 'line',
      text: `${g.wins} 胜 ${g.losses} 负 ${g.draws} 平 · 骰子 ${g.diceThrows} 次（六点 ${g.sixes} 回）· 猜拳 ${g.rpsThrows} 次`,
    });
  }
  out.push({ kind: 'gap' }, { kind: 'foot', text: '纯本地统计，未上传任何数据' });
  return out;
}

/** CSS-pixel geometry of the long image. Width is the device baseline, 390. */
export const REPORT_IMAGE_WIDTH = 390;
const PAD_X = 28;
const LINE_H: Record<ReportImageLine['kind'], number> = {
  title: 44,
  head: 30,
  big: 46,
  line: 24,
  gap: 18,
  foot: 40,
};

/**
 * Draw the lines onto `canvas` at 2× for sharpness. Returns nothing; the
 * caller exports the canvas. All colors come from `palette` — resolved from
 * the report tokens by the page, never hardcoded here.
 */
export function renderReportImage(
  canvas: HTMLCanvasElement,
  lines: ReportImageLine[],
  palette: ReportImagePalette,
): void {
  const scale = 2;
  const height = lines.reduce((h, l) => h + LINE_H[l.kind], 0) + 72;
  canvas.width = REPORT_IMAGE_WIDTH * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d unavailable');
  ctx.scale(scale, scale);

  const grad = ctx.createLinearGradient(0, 0, REPORT_IMAGE_WIDTH, height);
  grad.addColorStop(0, palette.bgA);
  grad.addColorStop(1, palette.bgB);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, REPORT_IMAGE_WIDTH, height);

  const sans =
    '-apple-system, "PingFang SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif';
  let y = 48;
  for (const l of lines) {
    switch (l.kind) {
      case 'title':
        ctx.fillStyle = palette.accent;
        ctx.font = `700 24px ${sans}`;
        ctx.fillText(l.text, PAD_X, y + 24);
        break;
      case 'head':
        ctx.fillStyle = palette.dim;
        ctx.font = `400 14px ${sans}`;
        ctx.fillText(l.text, PAD_X, y + 16);
        break;
      case 'big':
        ctx.fillStyle = palette.accent;
        ctx.font = `700 30px ${sans}`;
        ctx.fillText(l.text, PAD_X, y + 32);
        break;
      case 'line':
        ctx.fillStyle = palette.text;
        ctx.font = `400 13px ${sans}`;
        ctx.fillText(l.text, PAD_X, y + 15);
        break;
      case 'gap':
        ctx.strokeStyle = palette.hairline;
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(PAD_X, y + LINE_H.gap / 2);
        ctx.lineTo(REPORT_IMAGE_WIDTH - PAD_X, y + LINE_H.gap / 2);
        ctx.stroke();
        break;
      case 'foot':
        ctx.fillStyle = palette.dim;
        ctx.font = `400 11px ${sans}`;
        ctx.fillText(l.text, PAD_X, y + 20);
        break;
    }
    y += LINE_H[l.kind];
  }
}
