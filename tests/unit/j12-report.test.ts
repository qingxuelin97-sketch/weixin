import { describe, it, expect } from 'vitest';
import {
  computeReport,
  scanAllMessages,
  scanTruncatedForYear,
  yearsWithData,
  yearRange,
  REPORT_SCAN_CAP,
  type ReportInput,
} from '../../src/lib/report';
import { reportImageLines } from '../../src/lib/report-image';
import type {
  ContactVM,
  ConversationVM,
  MessageVM,
  MomentCommentVM,
  MomentLikeVM,
  MomentVM,
} from '../../src/data/types';

/**
 * 年度报告多维 (M-J12) 的红线：
 *   1. 年份隔离——往年数据只入对应年，跨年一条都不许串；
 *   2. 新维度（朋友圈/通话/剧情/表情游戏）各自的口径；
 *   3. 截断条件——20k 上限打断的年份必须亮牌，扫完整的大会话不许误报。
 */

const at = (y: number, m: number, d: number, h = 12, min = 0) =>
  new Date(y, m - 1, d, h, min).getTime();
const NOW = at(2026, 12, 20);

let nextId = 1;
function msg(
  convId: string,
  senderId: string,
  createdAt: number,
  over: Partial<MessageVM> = {},
): MessageVM {
  return {
    id: nextId++,
    convId,
    senderId,
    type: 'text',
    content: '一句话',
    status: 'sent',
    createdAt,
    ...over,
  };
}

const conv = (id: string, title: string, extra: Partial<ConversationVM> = {}): ConversationVM => ({
  id,
  type: 'single',
  title,
  avatarColor: '',
  avatarText: '',
  isPinned: false,
  isMuted: false,
  unreadCount: 0,
  mentionMe: false,
  lastMsgPreview: '',
  lastMsgAt: 0,
  ...extra,
});

const contacts: ContactVM[] = [
  { id: 'self', type: 'self', name: '我', avatarColor: '', avatarText: '我' },
  { id: 'ai_ada', type: 'ai', name: 'Ada', avatarColor: '', avatarText: 'A' },
  { id: 'ai_bo', type: 'ai', name: '阿波', remark: '波波', avatarColor: '', avatarText: 'B' },
];

function baseInput(over: Partial<ReportInput> = {}): ReportInput {
  return {
    conversations: [conv('c1', 'Ada')],
    messagesByConv: { c1: [] },
    contacts,
    walletTxs: [],
    now: NOW,
    ...over,
  };
}

/* ==================================================================== */

describe('年份隔离（转红：往年数据只入对应年）', () => {
  const msgs2025 = [
    msg('c1', 'self', at(2025, 3, 1), { content: '旧年火锅 旧年火锅' }),
    msg('c1', 'ai_ada', at(2025, 3, 1, 12, 3)),
  ];
  const msgs2026 = [
    msg('c1', 'self', at(2026, 5, 1), { content: '新年咖啡' }),
    msg('c1', 'ai_ada', at(2026, 5, 1, 12, 2)),
    msg('c1', 'self', at(2026, 5, 1, 12, 4)),
  ];

  it('选 2025 只见 2025，选 2026 只见 2026', () => {
    const input = baseInput({ messagesByConv: { c1: [...msgs2025, ...msgs2026] } });
    const r25 = computeReport({ ...input, year: 2025 });
    const r26 = computeReport({ ...input, year: 2026 });
    expect(r25.year).toBe(2025);
    expect(r25.totalMessages).toBe(2);
    expect(r26.totalMessages).toBe(3);
    expect(r25.topWords.map((w) => w.word).join('')).toContain('火锅');
    expect(r26.topWords.map((w) => w.word).join('')).not.toContain('火锅');
  });

  it('往年数据的加入不改变本年报告——逐字段 deep-equal', () => {
    const only2026 = computeReport(baseInput({ messagesByConv: { c1: msgs2026 } }));
    const with2025 = computeReport(
      baseInput({ messagesByConv: { c1: [...msgs2025, ...msgs2026] } }),
    );
    // year 缺省 = now 的年份 (2026)。
    expect(with2025).toEqual(only2026);
  });

  it('钱包流水同样按年过滤（金额保持整数分）', () => {
    const input = baseInput({
      walletTxs: [
        { id: 't1', kind: 'rp_out', amountFen: -100, title: '', balanceAfterFen: 0, createdAt: at(2025, 2, 1) },
        { id: 't2', kind: 'rp_in', amountFen: 66, title: '', balanceAfterFen: 0, createdAt: at(2026, 2, 1) },
      ],
    });
    const r26 = computeReport(input);
    expect(r26.money).toEqual({ sentFen: 0, receivedFen: 66, sentCount: 0, receivedCount: 1 });
    const r25 = computeReport({ ...input, year: 2025 });
    expect(r25.money.sentFen).toBe(100);
    expect(r25.money.receivedFen).toBe(0);
  });

  it('yearsWithData 列出所有出现过数据的年份，含当前年，降序', () => {
    const input = baseInput({
      messagesByConv: { c1: [...msgs2025, ...msgs2026] },
      storySaves: [{ scriptId: 's1', endingId: 'e1', endedAt: at(2024, 6, 1) }],
    });
    expect(yearsWithData(input)).toEqual([2026, 2025, 2024]);
  });

  it('隐藏会话不参与年份枚举（一个只有 AI 私信的年份不许成为可选项）', () => {
    const input = baseInput({
      conversations: [conv('c1', 'Ada'), conv('h1', '秘密', { isHidden: true })],
      messagesByConv: { c1: msgs2026, h1: [msg('h1', 'ai_ada', at(2019, 1, 1))] },
    });
    expect(yearsWithData(input)).toEqual([2026]);
  });
});

/* ==================================================================== */

describe('朋友圈维度', () => {
  const moments: MomentVM[] = [
    { id: 'm_self_25', authorId: 'self', text: '旧帖', imageRefs: [], isNsfw: false, createdAt: at(2025, 6, 1) },
    { id: 'm_self_26', authorId: 'self', text: '新帖', imageRefs: [], isNsfw: false, createdAt: at(2026, 6, 1) },
    { id: 'm_ada', authorId: 'ai_ada', text: '别人的帖', imageRefs: [], isNsfw: false, createdAt: at(2026, 6, 2) },
  ];
  const likes: MomentLikeVM[] = [
    // 2026 的赞落在 2025 的帖上：按赞的年份计入 2026。
    { id: 'l1', momentId: 'm_self_25', contactId: 'ai_ada', createdAt: at(2026, 6, 3) },
    { id: 'l2', momentId: 'm_self_26', contactId: 'ai_bo', createdAt: at(2026, 6, 4) },
    // 自己给自己点的赞不算「获赞」。
    { id: 'l3', momentId: 'm_self_26', contactId: 'self', createdAt: at(2026, 6, 4) },
    // 给别人的帖点的赞与我无关。
    { id: 'l4', momentId: 'm_ada', contactId: 'ai_bo', createdAt: at(2026, 6, 5) },
    // 往年的赞不进本年。
    { id: 'l5', momentId: 'm_self_25', contactId: 'ai_ada', createdAt: at(2025, 6, 5) },
  ];
  const comments: MomentCommentVM[] = [
    { id: 'c1', momentId: 'm_self_26', authorId: 'ai_ada', text: '好看', createdAt: at(2026, 6, 6) },
    { id: 'c2', momentId: 'm_self_26', authorId: 'ai_ada', text: '再来一张', createdAt: at(2026, 6, 7) },
    { id: 'c3', momentId: 'm_self_26', authorId: 'ai_bo', text: '哈哈', createdAt: at(2026, 6, 8) },
    // 我自己的评论不算「收到评论」。
    { id: 'c4', momentId: 'm_self_26', authorId: 'self', text: '谢', createdAt: at(2026, 6, 9) },
    // 评在别人帖下的不算。
    { id: 'c5', momentId: 'm_ada', authorId: 'ai_bo', text: '围观', createdAt: at(2026, 6, 10) },
  ];

  it('发帖按帖年份、获赞/评论按反应年份，TOP 评论人有名有姓', () => {
    const r = computeReport(baseInput({ moments, momentLikes: likes, momentComments: comments }));
    expect(r.momentsStat.posts).toBe(1); // 只有 m_self_26
    expect(r.momentsStat.likesReceived).toBe(2); // l1 + l2
    expect(r.momentsStat.commentsReceived).toBe(3); // c1..c3
    expect(r.momentsStat.topCommenters[0]).toMatchObject({ contactId: 'ai_ada', name: 'Ada', count: 2 });
    expect(r.momentsStat.topCommenters[1]).toMatchObject({ contactId: 'ai_bo', name: '波波', count: 1 });
  });

  it('2025 视角：发帖 1、获赞只有当年那一个', () => {
    const r = computeReport(
      baseInput({ moments, momentLikes: likes, momentComments: comments, year: 2025 }),
    );
    expect(r.momentsStat.posts).toBe(1);
    expect(r.momentsStat.likesReceived).toBe(1); // l5
    expect(r.momentsStat.commentsReceived).toBe(0);
  });
});

/* ==================================================================== */

describe('通话维度', () => {
  it('接通数/总时长/最长/未接各归各；隐藏会话的通话为零', () => {
    const input = baseInput({
      conversations: [conv('c1', 'Ada'), conv('h1', '秘密', { isHidden: true })],
      messagesByConv: {
        c1: [
          msg('c1', 'self', at(2026, 4, 1), { type: 'call', content: undefined, meta: { direction: 'out', durationMs: 65_000 } }),
          msg('c1', 'ai_ada', at(2026, 4, 2), { type: 'call', content: undefined, meta: { direction: 'in', durationMs: 600_000 } }),
          msg('c1', 'ai_ada', at(2026, 4, 3), { type: 'call', content: '未接听', meta: { direction: 'in' } }),
          // 往年的通话不进本年。
          msg('c1', 'self', at(2025, 4, 1), { type: 'call', meta: { direction: 'out', durationMs: 999_999 } }),
        ],
        h1: [msg('h1', 'ai_ada', at(2026, 4, 4), { type: 'call', meta: { direction: 'in', durationMs: 1 } })],
      },
    });
    const r = computeReport(input);
    expect(r.callsStat.count).toBe(2);
    expect(r.callsStat.totalMs).toBe(665_000);
    expect(r.callsStat.missed).toBe(1);
    expect(r.callsStat.longest).toMatchObject({ ms: 600_000, convTitle: 'Ada' });
  });
});

/* ==================================================================== */

describe('剧情维度', () => {
  it('只数走到结局的周目，结局数按 (剧本, 结局) 去重，按 endedAt 归年', () => {
    const r = computeReport(
      baseInput({
        storySaves: [
          { scriptId: 's1', endingId: 'good', endedAt: at(2026, 3, 1) },
          { scriptId: 's1', endingId: 'good', endedAt: at(2026, 4, 1) }, // 二周目同结局
          { scriptId: 's1', endingId: 'bad', endedAt: at(2026, 5, 1) },
          { scriptId: 's2', endingId: 'good', endedAt: at(2026, 6, 1) }, // 另一剧本的同名结局
          { scriptId: 's1', endingId: 'good', endedAt: at(2025, 3, 1) }, // 往年
          { scriptId: 's1' }, // 没走完的不算
          { scriptId: 's1', endedAt: at(2026, 7, 1) }, // 有时间没结局也不算
        ],
      }),
    );
    expect(r.storyStat.runsCompleted).toBe(4);
    expect(r.storyStat.endingsSeen).toBe(3); // s1#good / s1#bad / s2#good
  });
});

/* ==================================================================== */

describe('表情游戏战绩', () => {
  const game = (
    convId: string,
    senderId: string,
    createdAt: number,
    kind: 'dice' | 'rps',
    result: number,
  ) => msg(convId, senderId, createdAt, { type: 'game', content: '', meta: { game: kind, result } });

  it('相邻两掷成一局：猜拳按胜负平，骰子比大小；六点计数', () => {
    const t = at(2026, 8, 1);
    const input = baseInput({
      messagesByConv: {
        c1: [
          // 猜拳：我出石头(0)，对方出剪刀(1) → 我赢。
          game('c1', 'self', t, 'rps', 0),
          game('c1', 'ai_ada', t + 1000, 'rps', 1),
          // 骰子：我 6，对方 2 → 我赢；且六点 +1。
          game('c1', 'self', t + 2000, 'dice', 6),
          game('c1', 'ai_ada', t + 3000, 'dice', 2),
          // 骰子：对方 5，我 3 → 我输（对方先手也算一局）。
          game('c1', 'ai_ada', t + 4000, 'dice', 5),
          game('c1', 'self', t + 5000, 'dice', 3),
          // 猜拳平局。
          game('c1', 'self', t + 6000, 'rps', 2),
          game('c1', 'ai_ada', t + 7000, 'rps', 2),
          // 落单的一掷：有掷数、无胜负。
          game('c1', 'self', t + 8000, 'dice', 1),
        ],
      },
    });
    const r = computeReport(input);
    expect(r.gameStat).toEqual({
      diceThrows: 3,
      rpsThrows: 2,
      wins: 2,
      losses: 1,
      draws: 1,
      sixes: 1,
    });
  });

  it('不同游戏相邻不成局；AI 对 AI 的局不进我的战绩', () => {
    const t = at(2026, 8, 2);
    const input = baseInput({
      conversations: [conv('g1', '小群', { type: 'group', memberIds: ['ai_ada', 'ai_bo'] })],
      messagesByConv: {
        g1: [
          game('g1', 'self', t, 'dice', 6),
          game('g1', 'ai_ada', t + 1000, 'rps', 0), // 游戏不同，不配对
          game('g1', 'ai_ada', t + 2000, 'dice', 4),
          game('g1', 'ai_bo', t + 3000, 'dice', 2), // AI 对 AI
        ],
      },
    });
    const r = computeReport(input);
    expect(r.gameStat.wins + r.gameStat.losses + r.gameStat.draws).toBe(0);
    expect(r.gameStat.diceThrows).toBe(1);
  });
});

/* ==================================================================== */

describe('20k 截断（转红：截断必须亮牌，扫完整不许误报）', () => {
  /** convId → rows，倒序分页器，模仿 repo.getMessages 的游标语义。 */
  function pagerOf(data: Record<string, MessageVM[]>) {
    return {
      page: async (convId: string, beforeId: number | undefined, limit: number) => {
        const rows = (data[convId] ?? [])
          .filter((m) => (beforeId == null ? true : m.id < beforeId))
          .sort((a, b) => b.id - a.id)
          .slice(0, limit);
        return rows.reverse();
      },
    };
  }

  function bulk(convId: string, count: number, startAt: number, stepMs = 60_000): MessageVM[] {
    return Array.from({ length: count }, (_, i) =>
      msg(convId, i % 2 ? 'self' : 'ai_ada', startAt + i * stepMs),
    );
  }

  it('超过上限：cappedAt 记录最老已读时间；命中年在窗口内 → 截断', async () => {
    // 1200 条全在 2026 年内，上限压到 1000（同一逻辑，测试不必真铺 2 万行）。
    const rows = bulk('c1', 1200, at(2026, 1, 10));
    const scan = await scanAllMessages(['c1'], pagerOf({ c1: rows }), 1000);
    expect(scan.messagesByConv.c1.length).toBeGreaterThanOrEqual(1000);
    expect(scan.messagesByConv.c1.length).toBeLessThan(1200);
    expect(scan.cappedAt.c1).toBeGreaterThanOrEqual(yearRange(2026).start);
    expect(scanTruncatedForYear(scan, 2026)).toBe(true);
  });

  it('会话很大但扫到了年界之前 → 本年完整，不亮牌；更早的年份亮牌', async () => {
    // 老的 1100 条在 2024，新的 300 条在 2026：cap 1000 会在 2024 段内停下，
    // 2026 的 300 条全部在手 → 2026 不截断，2024 截断。
    const rows = [...bulk('c1', 1100, at(2024, 1, 1)), ...bulk('c1', 300, at(2026, 1, 1))];
    const scan = await scanAllMessages(['c1'], pagerOf({ c1: rows }), 1000);
    expect(scanTruncatedForYear(scan, 2026)).toBe(false);
    expect(scanTruncatedForYear(scan, 2024)).toBe(true);
  });

  it('全量扫完绝不误报——哪怕最后那页短页把总数带过了上限', async () => {
    // 1300 条、上限 1200：第三页是 300 的短页，短页 = 历史见底 = 扫描完整，
    // 即便 rows 总数已越过上限也不得记 cappedAt（顺序错了就是误报截断）。
    const rows = bulk('c1', 1300, at(2026, 1, 1));
    const scan = await scanAllMessages(['c1'], pagerOf({ c1: rows }), 1200);
    expect(scan.messagesByConv.c1).toHaveLength(1300);
    expect(scan.cappedAt).toEqual({});
    expect(scanTruncatedForYear(scan, 2026)).toBe(false);
  });

  it('默认上限是 20k（口径写死在常量里，页面文案引用同一数字）', () => {
    expect(REPORT_SCAN_CAP).toBe(20_000);
  });
});

/* ==================================================================== */

describe('长图内容 (reportImageLines)', () => {
  it('年份、总量、金额（fen→yuan 格式化）都进画面；零数据的维度不画', () => {
    const r = computeReport(
      baseInput({
        messagesByConv: { c1: [msg('c1', 'self', at(2026, 5, 1), { content: '你好' })] },
        walletTxs: [
          { id: 't', kind: 'rp_out', amountFen: -12345, title: '', balanceAfterFen: 0, createdAt: at(2026, 2, 1) },
        ],
      }),
    );
    const text = reportImageLines(r)
      .map((l) => ('text' in l ? l.text : ''))
      .join('\n');
    expect(text).toContain('2026 聊天年度报告');
    expect(text).toContain('1 条');
    expect(text).toContain('￥123.45');
    expect(text).not.toContain('剧情');
    expect(text).not.toContain('通话');
    expect(text).toContain('纯本地统计');
  });
});
