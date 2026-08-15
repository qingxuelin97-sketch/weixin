import { describe, it, expect } from 'vitest';
import { computeReport, SESSION_GAP_MS, type ReportInput } from '../../src/lib/report';
import type { ContactVM, ConversationVM, MessageVM, WalletTxVM } from '../../src/data/types';

/**
 * M-I14 年度报告 statistics — and THE red test of this milestone: a hidden
 * conversation (AI↔AI DM) must contribute exactly zero to every number.
 * Remove the isHidden filter inside computeReport and this file goes red.
 */

/** Local-time constructor so hour-based assertions hold in any TZ. */
const at = (m: number, d: number, h: number, min = 0) => new Date(2026, m - 1, d, h, min).getTime();

const NOW = at(12, 20, 12);

let nextId = 1;
function msg(convId: string, senderId: string, content: string, createdAt: number, type: MessageVM['type'] = 'text'): MessageVM {
  return { id: nextId++, convId, senderId, type, content, status: 'sent', createdAt };
}

const contacts: ContactVM[] = [
  { id: 'self', type: 'self', name: '我', avatarColor: '', avatarText: '我' },
  { id: 'ai_ada', type: 'ai', name: 'Ada', avatarColor: '', avatarText: 'A' },
  { id: 'ai_bo', type: 'ai', name: '阿波', remark: '波波', avatarColor: '', avatarText: 'B' },
  { id: 'ai_secret', type: 'ai', name: '隐藏人', avatarColor: '', avatarText: 'S' },
];

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

function fixture(): { input: ReportInput; hidden: { conv: ConversationVM; msgs: MessageVM[] } } {
  const c1 = conv('c1', 'Ada');
  const c2 = conv('c2', '周末小分队', { type: 'group', memberIds: ['ai_ada', 'ai_bo'] });
  const hiddenConv = conv('h1', '秘密频道', { isHidden: true });

  const msgs1: MessageVM[] = [
    // A 6-message session at 20:00, gaps of 4 min (< SESSION_GAP_MS).
    msg('c1', 'self', '今晚吃火锅吗', at(6, 10, 20, 0)),
    msg('c1', 'ai_ada', '火锅可以', at(6, 10, 20, 4)),
    msg('c1', 'self', '火锅走起', at(6, 10, 20, 8)),
    msg('c1', 'ai_ada', '几点', at(6, 10, 20, 12)),
    msg('c1', 'self', '八点 那家火锅店', at(6, 10, 20, 16)),
    msg('c1', 'ai_ada', '好', at(6, 10, 20, 20)),
    // Isolated late-night self message at 02:30.
    msg('c1', 'self', '睡不着', at(6, 12, 2, 30)),
    // A recalled message and a system line must not count into words/talkers.
    { ...msg('c1', 'self', '打错了的火锅', at(6, 13, 20, 0)), isRecalled: true },
    msg('c1', 'ai_ada', '你撤回了一条消息', at(6, 13, 20, 1), 'system'),
  ];

  // A 10-message burst in the group — the longest session, 1-minute gaps.
  const msgs2: MessageVM[] = [];
  for (let i = 0; i < 10; i++) {
    msgs2.push(msg('c2', i % 2 === 0 ? 'ai_bo' : 'self', `第${i}条`, at(7, 1, 21, i)));
  }

  // Hidden AI↔AI DM: a distinctive sender, a distinctive word, huge volume,
  // deep-night times, everything designed to distort every stat if leaked.
  const hiddenMsgs: MessageVM[] = [];
  for (let i = 0; i < 50; i++) {
    hiddenMsgs.push(msg('h1', 'ai_secret', '绝密暗号 绝密暗号', at(8, 2, 3, i)));
    hiddenMsgs.push(msg('h1', 'self', '绝密暗号', at(8, 2, 3, i)));
  }

  const walletTxs: WalletTxVM[] = [
    { id: 't1', kind: 'rp_out', amountFen: -888, title: '', balanceAfterFen: 0, createdAt: at(6, 1, 10) },
    { id: 't2', kind: 'transfer_out', amountFen: -1200, title: '', balanceAfterFen: 0, createdAt: at(6, 2, 10) },
    { id: 't3', kind: 'rp_in', amountFen: 66, title: '', balanceAfterFen: 0, createdAt: at(6, 3, 10) },
    { id: 't4', kind: 'transfer_in', amountFen: 5000, title: '', balanceAfterFen: 0, createdAt: at(6, 4, 10) },
    { id: 't5', kind: 'adjust', amountFen: 999_999, title: '', balanceAfterFen: 0, createdAt: at(6, 5, 10) },
  ];

  return {
    input: {
      conversations: [c1, c2],
      messagesByConv: { c1: msgs1, c2: msgs2 },
      contacts,
      walletTxs,
      now: NOW,
    },
    hidden: { conv: hiddenConv, msgs: hiddenMsgs },
  };
}

describe('computeReport — the numbers', () => {
  const r = computeReport(fixture().input);

  it('counts totals and self share', () => {
    expect(r.year).toBe(2026);
    expect(r.totalMessages).toBe(19);
    // self: 3 session texts + 1 night + 1 recalled in c1, plus 5 in the group.
    expect(r.selfMessages).toBe(10);
  });

  it('activeDays counts distinct local days', () => {
    // 6/10, 6/12, 6/13, 7/1
    expect(r.activeDays).toBe(4);
    expect(r.spanDays).toBeGreaterThan(0);
  });

  it('topTalkers ranks AI senders by count, resolves remark over name, excludes system lines', () => {
    expect(r.topTalkers[0]).toMatchObject({ contactId: 'ai_bo', name: '波波', count: 5 });
    expect(r.topTalkers[1]).toMatchObject({ contactId: 'ai_ada', count: 3 });
    expect(r.topTalkers.map((t) => t.contactId)).not.toContain('self');
  });

  it('hour histogram peaks where the user actually talks', () => {
    expect(r.hourHistogram).toHaveLength(24);
    expect(r.peakHour).toBe(21); // 5 group messages at 21:0x
    expect(r.hourHistogram[21]).toBe(5);
    expect(r.hourHistogram[20]).toBe(4); // 3 session texts + 1 recalled
    expect(r.hourHistogram[2]).toBe(1);
  });

  it('money aggregates stay integer fen (rule #3), adjust rows excluded', () => {
    expect(r.money).toEqual({ sentFen: 2088, receivedFen: 5066, sentCount: 2, receivedCount: 2 });
    for (const v of [r.money.sentFen, r.money.receivedFen]) expect(Number.isInteger(v)).toBe(true);
  });

  it('longest session finds the 10-message group burst, not the shorter 1:1 run', () => {
    expect(r.longestSession).toMatchObject({ convId: 'c2', convTitle: '周末小分队', count: 10 });
    expect(r.longestSession!.durationMs).toBe(9 * 60_000);
  });

  it('session breaks on a gap larger than SESSION_GAP_MS', () => {
    const input = fixture().input;
    const c1msgs = input.messagesByConv.c1.filter((m) => m.type !== 'system' && !m.isRecalled);
    // The 02:30 message is isolated — it must not extend the 20:00 session.
    const sessionMsgs = c1msgs.filter((m) => m.createdAt >= at(6, 10, 20, 0) && m.createdAt <= at(6, 10, 20, 20));
    expect(sessionMsgs.length).toBe(6);
    expect(at(6, 12, 2, 30) - at(6, 10, 20, 20)).toBeGreaterThan(SESSION_GAP_MS);
  });

  it('top words mine the user own texts: bigrams counted, recalled text ignored', () => {
    const huoguo = r.topWords.find((w) => w.word === '火锅');
    expect(huoguo).toBeDefined();
    expect(huoguo!.count).toBe(3); // 吃火锅/火锅走起/那家火锅店 — recalled one excluded
    expect(r.topWords[0].word).toBe('火锅');
  });

  it('finds the latest deep-night message', () => {
    expect(r.latestNight).toMatchObject({ at: at(6, 12, 2, 30), convTitle: 'Ada' });
  });

  it('busiest day is the group-burst day', () => {
    expect(r.busiestDay).toMatchObject({ dayStart: at(7, 1, 0), count: 10 });
  });
});

describe('hidden conversations: ZERO statistics (the irreversible-tell guard)', () => {
  it('adding a hidden conversation changes NOTHING — every field deep-equal', () => {
    const { input } = fixture();
    const baseline = computeReport(input);

    const { input: input2, hidden } = fixture();
    const withHidden = computeReport({
      ...input2,
      conversations: [...input2.conversations, hidden.conv],
      messagesByConv: { ...input2.messagesByConv, h1: hidden.msgs },
    });

    // Deliberately a full deep-equal, not per-field: any future stat added to
    // YearReport is automatically covered, or this line goes red.
    expect(withHidden).toEqual(baseline);
  });

  it('the hidden sender, word and volume never surface', () => {
    const { input, hidden } = fixture();
    const r = computeReport({
      ...input,
      conversations: [...input.conversations, hidden.conv],
      messagesByConv: { ...input.messagesByConv, h1: hidden.msgs },
    });
    expect(r.topTalkers.map((t) => t.contactId)).not.toContain('ai_secret');
    expect(r.topWords.map((w) => w.word).join('')).not.toContain('绝密');
    expect(r.topWords.map((w) => w.word).join('')).not.toContain('暗号');
    expect(r.totalMessages).toBe(19);
    // The hidden thread's 03:xx flood must not fake a night-owl user.
    expect(r.peakHour).toBe(21);
  });

  it('a message smuggled under a visible key but claiming a hidden convId is dropped', () => {
    const { input, hidden } = fixture();
    const r = computeReport({
      ...input,
      conversations: [...input.conversations, hidden.conv],
      // Malicious/buggy caller: hidden rows handed over inside the c1 bucket.
      messagesByConv: { ...input.messagesByConv, c1: [...input.messagesByConv.c1, ...hidden.msgs] },
    });
    expect(r.totalMessages).toBe(19);
    expect(r.topWords.map((w) => w.word).join('')).not.toContain('绝密');
  });
});
