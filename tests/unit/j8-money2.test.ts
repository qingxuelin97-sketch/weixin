import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDB, _closeDbForTests } from '../../src/db/idb';
import { repo, SETTINGS_KEY_CASCADE } from '../../src/db/repo';
import { SCHEDULED_ACTION_KINDS } from '../../src/db/schema';
import { splitEvenPacket, splitLuckyPacket } from '../../src/lib/money';
import { claimShare, rpModeOf } from '../../src/lib/wallet';
import {
  sendRedPacket,
  sendTransfer,
  claimRedPacket,
  returnRedPacket,
  receiveTransfer,
  returnTransfer,
  RP_EXPIRE_MS,
  type MoneyHooks,
} from '../../src/ai/money-service';
import {
  planTransferReception,
  acceptThresholdFen,
  planBillPayment,
  planGroupBill,
} from '../../src/ai/money-motive';
import {
  createGroupBill,
  payBill,
  billOf,
  billsKey,
  considerGroupBill,
  startAiBill,
} from '../../src/ai/bill-service';
import { handleBillPay, handleRpReturn, handleAiMoney, type HandlerDeps } from '../../src/ai/handlers';
import { ACTION_LLM_BOUND } from '../../src/ai/cost-gate';
import { pendingActions, actionStatus, type ScheduledAction } from '../../src/ai/scheduler';
import { renderMessageBody } from '../../src/ai/render-msg';
import { previewOf } from '../../src/store/appStore';
import { makePersona } from '../../src/data/persona-defaults';
import type { ConversationVM, MessageVM, PersonaVM, RedPacketVM } from '../../src/data/types';

/**
 * J8 钱二期：均分/专属红包、红包 24h 过期退还、群收款/AA、账单游标分页、
 * AI 拒收转账。每一块都有「故意改坏即转红」的断言——守的不是行数，是不变量：
 * 份额守恒（整数分）、专属只有本人能领、过期退款分毫不差且只退一次、
 * 结算幂等、拒收可回放。
 */

const T0 = 1_756_100_000_000;

function hooksAt(now: number): MoneyHooks & { appended: MessageVM[] } {
  const appended: MessageVM[] = [];
  return {
    appended,
    appendMessage: async (m) => {
      const row = await repo.addMessage(m);
      appended.push(row);
      return row;
    },
    updateMessage: (m) => repo.updateMessage(m),
    now: () => now,
  };
}

const persona = (id: string, over: Partial<PersonaVM> = {}): PersonaVM =>
  makePersona({ contactId: id, core: 'c', ...over });

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  _closeDbForTests();
  await openDB();
});

/* ================================================================== */
/* 1. 均分与专属                                                        */
/* ================================================================== */

describe('splitEvenPacket（整数分、余数前置、确定性）', () => {
  it('conserves the total exactly and front-loads the remainder', () => {
    expect(splitEvenPacket(10, 3)).toEqual([4, 3, 3]);
    expect(splitEvenPacket(100, 4)).toEqual([25, 25, 25, 25]);
    expect(splitEvenPacket(1_001, 3)).toEqual([334, 334, 333]);
    for (const [total, n] of [
      [999, 7],
      [888_88, 13],
      [5, 5],
    ] as const) {
      const shares = splitEvenPacket(total, n);
      expect(shares).toHaveLength(n);
      expect(shares.reduce((a, b) => a + b, 0)).toBe(total);
      expect(shares.every((s) => Number.isInteger(s) && s >= 1)).toBe(true);
      // 余数前置：非升序（前面的份额 >= 后面的）。
      for (let i = 1; i < shares.length; i++) expect(shares[i - 1]).toBeGreaterThanOrEqual(shares[i]);
      // 均分：任意两份差不超过 1 分——这是它与拼手气的本质区别。
      expect(Math.max(...shares) - Math.min(...shares)).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic (no rng at all) and rejects impossible splits', () => {
    expect(splitEvenPacket(77, 6)).toEqual(splitEvenPacket(77, 6));
    expect(() => splitEvenPacket(2, 3)).toThrow();
    expect(() => splitEvenPacket(10.5, 2)).toThrow();
    expect(() => splitEvenPacket(10, 0)).toThrow();
  });
});

describe('专属红包的领取守卫是纯规则，不是 UI 礼貌', () => {
  const rp = (over: Partial<RedPacketVM> = {}): RedPacketVM => ({
    id: 'rp_x',
    convId: 'g1',
    senderId: 'self',
    totalFen: 500,
    count: 1,
    kind: 'lucky',
    mode: 'exclusive',
    exclusiveId: 'ai_lin',
    greeting: 'g',
    sharesFen: [500],
    status: 'active',
    createdAt: T0,
    ...over,
  });

  it('rpModeOf reads legacy rows (no field) as lucky', () => {
    expect(rpModeOf({} as RedPacketVM)).toBe('lucky');
    expect(rpModeOf({ mode: 'even' } as RedPacketVM)).toBe('even');
  });

  it('only the designated recipient can claim; everyone else gets null', () => {
    expect(claimShare(rp(), [], 'ai_ada', T0)).toBeNull();
    expect(claimShare(rp(), [], 'self', T0)).toBeNull();
    const ok = claimShare(rp(), [], 'ai_lin', T0);
    expect(ok?.amountFen).toBe(500);
  });
});

describe('sendRedPacket 的三种玩法', () => {
  const grabbers = [
    { contactId: 'ai_lin', persona: persona('ai_lin') },
    { contactId: 'ai_ada', persona: persona('ai_ada') },
  ];

  it('even mode pre-splits evenly and keeps the legacy kind column honest', async () => {
    const h = hooksAt(T0);
    const rp = await sendRedPacket('g1', 100, 3, '', grabbers, h, { mode: 'even' });
    expect(rp.mode).toBe('even');
    expect(rp.kind).toBe('normal');
    expect(rp.sharesFen).toEqual([34, 33, 33]);
    expect(rp.sharesFen.reduce((a, b) => a + b, 0)).toBe(rp.totalFen);
  });

  it('default stays lucky — an old caller sees exactly the old behavior', async () => {
    const h = hooksAt(T0);
    const rp = await sendRedPacket('g1', 100, 3, '', grabbers, h);
    expect(rp.mode).toBeUndefined();
    expect(rp.sharesFen).toEqual(splitLuckyPacket(100, 3, rp.id));
  });

  it('exclusive: one share, only the recipient queued to grab, bystanders refused', async () => {
    const h = hooksAt(T0);
    const rp = await sendRedPacket('g1', 5_20, 3, '', grabbers, h, {
      mode: 'exclusive',
      exclusiveId: 'ai_lin',
      exclusiveName: '林小雨',
    });
    expect(rp.count).toBe(1);
    expect(rp.sharesFen).toEqual([5_20]);

    // AI 抢包尊重 mode：只有 ai_lin 的 rp_grab 入队——旁观者连排都不排。
    const grabs = (await pendingActions()).filter((a) => a.kind === 'rp_grab');
    expect(grabs).toHaveLength(1);
    expect(JSON.parse(grabs[0].payloadJson).contactId).toBe('ai_lin');

    // 第二道守卫：就算有人硬点，也领不走。
    expect(await claimRedPacket(rp.id, 'ai_ada', 'Ada', h)).toBeNull();
    expect(await claimRedPacket(rp.id, 'self', '我', h)).toBeNull();
    const mine = await claimRedPacket(rp.id, 'ai_lin', '林小雨', h);
    expect(mine?.amountFen).toBe(5_20);

    // 气泡 meta 带上玩法与定格的名字（投影/卡片都读它）。
    const bubble = (await repo.getMessages('g1', { limit: 50 })).find((m) => m.type === 'rp');
    expect(bubble?.meta?.mode).toBe('exclusive');
    expect(bubble?.meta?.exclusiveName).toBe('林小雨');
    expect(renderMessageBody(bubble as MessageVM)).toContain('专属红包');
    expect(renderMessageBody(bubble as MessageVM)).toContain('林小雨');
  });
});

/* ================================================================== */
/* 2. 红包 24h 过期退还                                                  */
/* ================================================================== */

describe('rp_return 走唯一时间演化路径', () => {
  it('is a registered kind with a declared (zero) LLM cost', () => {
    expect(SCHEDULED_ACTION_KINDS).toContain('rp_return');
    expect(ACTION_LLM_BOUND.rp_return).toBe(false);
    expect(SCHEDULED_ACTION_KINDS).toContain('bill_pay');
    expect(ACTION_LLM_BOUND.bill_pay).toBe(false);
  });

  it('sending writes expiresAt AND queues exactly one return under the stable id', async () => {
    const h = hooksAt(T0);
    const rp = await sendRedPacket('conv_lin', 8_88, 1, '', [], h);
    expect(rp.expiresAt).toBe(T0 + RP_EXPIRE_MS);
    expect((await repo.getRedPacket(rp.id))?.expiresAt).toBe(T0 + RP_EXPIRE_MS);
    const rows = (await pendingActions()).filter((a) => a.kind === 'rp_return');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(`rp_return_${rp.id}`);
    expect(rows[0].fireAt).toBe(T0 + RP_EXPIRE_MS);
  });

  it('过期未领 → 未领余额整数分回账 + 灰条 + 气泡转已过期', async () => {
    const h = hooksAt(T0);
    await repo.putWalletTx({
      id: 'seed',
      kind: 'adjust',
      amountFen: 100_00,
      title: '初始',
      balanceAfterFen: 100_00,
      createdAt: T0 - 1,
    });
    const rp = await sendRedPacket(
      'g1',
      10_00,
      3,
      '',
      [{ contactId: 'ai_lin', persona: persona('ai_lin') }],
      h,
    );
    // 一个 AI 抢走一份，剩两份没人领。
    await claimRedPacket(rp.id, 'ai_lin', '林', hooksAt(T0 + 5_000));
    const claimed = (await repo.getClaims(rp.id))[0].amountFen;

    const at = T0 + RP_EXPIRE_MS;
    await returnRedPacket(rp.id, hooksAt(at), at);

    expect((await repo.getRedPacket(rp.id))?.status).toBe('expired');
    const txs = await repo.getWalletTxs();
    const back = txs.at(-1)!;
    expect(back.kind).toBe('rp_in');
    expect(back.refId).toBe(`${rp.id}_ret`);
    expect(back.amountFen).toBe(10_00 - claimed);
    expect(Number.isInteger(back.amountFen)).toBe(true);
    // 铁律 3：发出 10 元、被抢走 claimed、退回其余——余额分毫不差。
    expect(back.balanceAfterFen).toBe(100_00 - claimed);

    const bubble = (await repo.getMessages('g1', { limit: 50 })).find((m) => m.type === 'rp');
    expect(bubble?.meta?.statusText).toBe('已过期');
    const sys = (await repo.getMessages('g1', { limit: 50 })).filter((m) => m.type === 'system');
    expect(sys.some((m) => m.content?.includes('红包已过期，退回'))).toBe(true);

    // 过期后再点 → 领不走（claimRedPacket 只认 active）。
    expect(await claimRedPacket(rp.id, 'self', '我', hooksAt(at + 1))).toBeNull();
  });

  it('已领完 → 零动作：不退款、不发灰条、状态不动', async () => {
    const h = hooksAt(T0);
    const rp = await sendRedPacket('conv_lin', 5_00, 1, '', [], h);
    await claimRedPacket(rp.id, 'self', '我', hooksAt(T0 + 1_000));
    expect((await repo.getRedPacket(rp.id))?.status).toBe('done');
    const txsBefore = await repo.getWalletTxs();
    const sysBefore = (await repo.getMessages('conv_lin', { limit: 50 })).filter(
      (m) => m.type === 'system',
    ).length;

    await returnRedPacket(rp.id, hooksAt(T0 + RP_EXPIRE_MS), T0 + RP_EXPIRE_MS);

    expect((await repo.getRedPacket(rp.id))?.status).toBe('done');
    expect(await repo.getWalletTxs()).toEqual(txsBefore);
    expect(
      (await repo.getMessages('conv_lin', { limit: 50 })).filter((m) => m.type === 'system').length,
    ).toBe(sysBefore);
  });

  it('跑两次只退一次（幂等），回填不倒挂时间戳', async () => {
    const h = hooksAt(T0);
    const rp = await sendRedPacket('conv_lin', 6_00, 2, '', [], h);
    // 会话在过期点之后还活着。
    const later = T0 + 3 * RP_EXPIRE_MS;
    await repo.addMessage({
      convId: 'conv_lin',
      senderId: 'self',
      type: 'text',
      content: '在忙',
      status: 'sent',
      createdAt: later,
    } as Omit<MessageVM, 'id'>);

    await returnRedPacket(rp.id, hooksAt(later + 1_000), T0 + RP_EXPIRE_MS);
    await returnRedPacket(rp.id, hooksAt(later + 2_000), T0 + RP_EXPIRE_MS);

    const rets = (await repo.getWalletTxs()).filter((t) => t.refId === `${rp.id}_ret`);
    expect(rets).toHaveLength(1);
    const rows = await repo.getMessages('conv_lin', { limit: 50 });
    const times = rows.map((m) => m.createdAt);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('the handler reads rpId + at off the payload (malformed rows are inert)', async () => {
    const calls: string[] = [];
    const deps = {
      returnRedPacket: (id: string, _h: unknown, at?: number) => {
        calls.push(`${id}:${at ?? '-'}`);
        return Promise.resolve();
      },
      hooks: hooksAt(T0),
    } as never;
    await handleRpReturn(deps, {});
    await handleRpReturn(deps, { rpId: 42 });
    expect(calls).toEqual([]);
    await handleRpReturn(deps, { rpId: 'rp_1', at: T0 });
    expect(calls).toEqual([`rp_1:${T0}`]);
  });
});

/* ================================================================== */
/* 3. AI 拒收/退还转账                                                   */
/* ================================================================== */

describe('planTransferReception（收钱侧动机，纯函数）', () => {
  const base = { persona: persona('ai_lin'), valence: 0, transferId: 'tr_1' };

  it('高金额 + 低关系 → 拒收；同金额 + 高关系 → 收下', () => {
    const big = planTransferReception({ ...base, amountFen: 200_00, affinity: 10 });
    expect(big.action).toBe('refuse');
    if (big.action === 'refuse') {
      expect(big.reason).toBe('too_much');
      expect(big.line.length).toBeGreaterThan(2);
      expect(big.returnDelayMs).toBeGreaterThanOrEqual(20_000);
      expect(big.returnDelayMs).toBeLessThanOrEqual(60_000);
    }
    expect(planTransferReception({ ...base, amountFen: 200_00, affinity: 90 }).action).toBe(
      'accept',
    );
  });

  it('近期 affect 恶劣 → 金额不大也不收', () => {
    const upset = planTransferReception({ ...base, amountFen: 50_00, affinity: 80, valence: -0.5 });
    expect(upset.action).toBe('refuse');
    if (upset.action === 'refuse') expect(upset.reason).toBe('upset');
    // 一分钱的玩笑金额不值得赌气退。
    expect(
      planTransferReception({ ...base, amountFen: 1, affinity: 80, valence: -0.9 }).action,
    ).toBe('accept');
  });

  it('阈值随关系与大方度单调上升，且决策可回放（同种子同结果）', () => {
    expect(acceptThresholdFen(80, 0.35)).toBeGreaterThan(acceptThresholdFen(10, 0.35));
    expect(acceptThresholdFen(50, 1)).toBeGreaterThan(acceptThresholdFen(50, 0));
    const a = planTransferReception({ ...base, amountFen: 200_00, affinity: 10 });
    const b = planTransferReception({ ...base, amountFen: 200_00, affinity: 10 });
    expect(a).toEqual(b);
  });
});

describe('receiveTransfer（队列侧的收/拒编排）', () => {
  const reads = (affinity: number, valence = 0) => ({
    personaFor: (id: string) => (id.startsWith('ai_') ? persona(id) : undefined),
    affinityOf: async () => affinity,
    valenceOf: async () => valence,
  });

  it('拒收：她说一句人设化解释，24h 的退还行被拉到几十秒内', async () => {
    const h = hooksAt(T0);
    const t = await sendTransfer('conv_lin', 'ai_lin', 200_00, '拿去花', h);
    const floorRow = (await pendingActions()).find((a) => a.id === `tr_return_${t.id}`)!;
    expect(floorRow.fireAt).toBe(T0 + 24 * 3_600_000);

    const h2 = hooksAt(T0 + 6_000);
    expect(await receiveTransfer(t.id, h2, reads(10))).toBe('refused');

    // 她的解释消息上屏（senderId 是她，不是系统）。
    expect(h2.appended.some((m) => m.senderId === 'ai_lin' && m.type === 'text')).toBe(true);
    // 同一个稳定 id 的行被前移，而不是叠出第二行。
    const moved = (await pendingActions()).filter((a) => a.id === `tr_return_${t.id}`);
    expect(moved).toHaveLength(1);
    expect(moved[0].fireAt).toBeGreaterThan(T0 + 6_000);
    expect(moved[0].fireAt).toBeLessThanOrEqual(T0 + 6_000 + 60_000);

    // 退还行照常结账：钱回来、气泡转已退还。
    await returnTransfer(t.id, hooksAt(moved[0].fireAt), moved[0].fireAt);
    expect((await repo.getTransfer(t.id))?.status).toBe('returned');
    // 转账仍未被 accept——拒收路径绝不落一笔收款。
    const txKinds = (await repo.getWalletTxs()).map((x) => x.kind);
    expect(txKinds.filter((k) => k === 'transfer_in')).toHaveLength(1); // 只有退款那笔
  });

  it('小额高关系照常收下；用户侧口径（toId=self）不走动机', async () => {
    const h = hooksAt(T0);
    const t = await sendTransfer('conv_lin', 'ai_lin', 20_00, '', h);
    expect(await receiveTransfer(t.id, hooksAt(T0 + 5_000), reads(90))).toBe('accepted');
    expect((await repo.getTransfer(t.id))?.status).toBe('accepted');
  });
});

/* ================================================================== */
/* 4. 群收款/AA                                                          */
/* ================================================================== */

describe('planBillPayment / planGroupBill（seeded 决策）', () => {
  it('大方的人必付、且同种子同延迟；铁公鸡群里必有装死的', () => {
    const generous = persona('ai_a', { generosity: 1 });
    for (let i = 0; i < 20; i++) {
      expect(planBillPayment(`b${i}`, 'ai_a', generous)).not.toBeNull();
    }
    const a1 = planBillPayment('b1', 'ai_a', generous);
    expect(a1).toEqual(planBillPayment('b1', 'ai_a', generous));
    expect(a1!.delayMs).toBeGreaterThanOrEqual(2 * 60_000);

    const stingy = persona('ai_s', { generosity: 0 });
    const outcomes = Array.from({ length: 40 }, (_, i) => planBillPayment(`b${i}`, 'ai_s', stingy));
    expect(outcomes.some((o) => o === null)).toBe(true);
    expect(outcomes.some((o) => o !== null)).toBe(true);
  });

  it('planGroupBill 每周掷一次骰子，死群不收款', () => {
    const members = [
      { contactId: 'ai_a', persona: persona('ai_a') },
      { contactId: 'ai_b', persona: persona('ai_b') },
    ];
    expect(planGroupBill({ now: T0, convId: 'g_dead', members, lastMsgAt: undefined })).toBeNull();
    expect(
      planGroupBill({ now: T0, convId: 'g_dead', members, lastMsgAt: T0 - 30 * 86_400_000 }),
    ).toBeNull();
    // 扫多个群总会有中签的一周；且同群同周结果可回放。
    let hit = 0;
    for (let i = 0; i < 30; i++) {
      const p = planGroupBill({ now: T0, convId: `g${i}`, members, lastMsgAt: T0 });
      if (p) {
        hit++;
        expect(p.perFen).toBeGreaterThan(0);
        expect(Number.isInteger(p.perFen)).toBe(true);
        expect(['ai_a', 'ai_b']).toContain(p.initiatorId);
        expect(p.fireAt).toBeGreaterThan(T0);
        expect(p).toEqual(planGroupBill({ now: T0, convId: `g${i}`, members, lastMsgAt: T0 }));
      }
    }
    expect(hit).toBeGreaterThan(0);
    expect(hit).toBeLessThan(30);
  });
});

describe('createGroupBill / payBill（结算真源 + 幂等 + 钱包）', () => {
  const parts = () => [
    { contactId: 'ai_a', name: '阿呆', persona: persona('ai_a', { generosity: 1 }) },
    { contactId: 'ai_b', name: '阿瓜', persona: persona('ai_b', { generosity: 1 }) },
  ];

  it('创建：份额守恒进 settings 真源，bill_pay 行按人错峰入队', async () => {
    const h = hooksAt(T0);
    const bill = await createGroupBill({
      convId: 'g1',
      initiatorId: 'self',
      totalFen: 101,
      title: '昨晚的饭钱',
      participants: parts(),
      hooks: h,
    });
    expect(bill.parts.map((p) => p.oweFen)).toEqual([51, 50]);
    expect(bill.parts.reduce((a, p) => a + p.oweFen, 0)).toBe(101);
    expect(await billOf('g1', bill.billId)).toEqual(bill);
    // settings 键形状 = bill:<convId>（级联能命中的那种），且台账已登记。
    expect(billsKey('g1')).toBe('bill:g1');
    expect(SETTINGS_KEY_CASCADE['bill:']).toMatchObject({ scope: 'conv', row: 'cascade' });

    const pays = (await pendingActions()).filter((a) => a.kind === 'bill_pay');
    expect(pays.map((a) => a.id).sort()).toEqual([
      `bill_pay_${bill.billId}_ai_a`,
      `bill_pay_${bill.billId}_ai_b`,
    ]);
    // 人设 seeded 延迟：两人必不同（同一红包不同人延迟必不同的老纪律）。
    expect(pays[0].fireAt).not.toBe(pays[1].fireAt);

    // 卡片 meta：投影与预览都不是 [object]。
    const card = (await repo.getMessages('g1', { limit: 50 })).find(
      (m) => m.type === 'group_bill',
    )!;
    const body = renderMessageBody(card);
    expect(body).toContain('群收款');
    expect(body).toContain('昨晚的饭钱');
    expect(body).toContain('¥1.01');
    expect(body).toContain('¥0.51');
    expect(body).toContain('未付：阿呆、阿瓜');
    expect(body).not.toContain('object');
    expect(body).not.toContain('ai_a'); // ids never leak
    expect(previewOf(card)).toBe('[群收款]');
  });

  it('AI 付款：只付一次，钱进发起人（用户）钱包；收齐后来一条灰条', async () => {
    const h = hooksAt(T0);
    const bill = await createGroupBill({
      convId: 'g1',
      initiatorId: 'self',
      totalFen: 100,
      title: 'AA',
      participants: parts(),
      hooks: h,
    });
    expect(await payBill(bill.billId, 'g1', 'ai_a', hooksAt(T0 + 60_000), T0 + 60_000)).toBe('paid');
    expect(await payBill(bill.billId, 'g1', 'ai_a', hooksAt(T0 + 61_000), T0 + 61_000)).toBe('noop');
    expect(await payBill(bill.billId, 'g1', 'ai_x', hooksAt(T0 + 62_000))).toBe('noop');

    const ins = (await repo.getWalletTxs()).filter((t) => t.kind === 'bill_in');
    expect(ins).toHaveLength(1);
    expect(ins[0].amountFen).toBe(50);
    expect(ins[0].peerId).toBe('ai_a');

    // 卡片镜像已更新。
    const card = (await repo.getMessages('g1', { limit: 50 })).find(
      (m) => m.type === 'group_bill',
    )!;
    expect(card.meta?.paidIds).toEqual(['ai_a']);
    expect(renderMessageBody(card)).toContain('已付 1/2');

    // 最后一人付清 → 完成灰条恰好一条。
    await payBill(bill.billId, 'g1', 'ai_b', hooksAt(T0 + 120_000), T0 + 120_000);
    const sys = (await repo.getMessages('g1', { limit: 50 })).filter((m) => m.type === 'system');
    expect(sys.filter((m) => m.content?.includes('群收款已完成'))).toHaveLength(1);
    expect(renderMessageBody(card && (await repo.getMessages('g1', { limit: 50 })).find((m) => m.type === 'group_bill')!)).toContain('已收齐');
  });

  it('用户付 AI 发起的收款：startAiBill 把「你」列进账单，payBill(self) 扣钱包', async () => {
    await repo.putWalletTx({
      id: 'seed',
      kind: 'adjust',
      amountFen: 50_00,
      title: '初始',
      balanceAfterFen: 50_00,
      createdAt: T0 - 1,
    });
    const conv: ConversationVM = {
      id: 'g1',
      type: 'group',
      title: '群',
      avatarColor: 'c',
      avatarText: 'g',
      memberIds: ['ai_a', 'ai_b'],
      isPinned: false,
      isMuted: false,
      unreadCount: 0,
      mentionMe: false,
      lastMsgPreview: '',
      lastMsgAt: T0,
    };
    const h = hooksAt(T0);
    await startAiBill(
      { convId: 'g1', contactId: 'ai_a', perFen: 15_00, title: '奶茶拼单' },
      {
        conversationById: (id) => (id === 'g1' ? conv : undefined),
        contactById: (id) => ({ id, type: 'ai', name: id, avatarColor: 'c', avatarText: 'x' }),
        personaFor: (id) => (id.startsWith('ai_') ? persona(id, { generosity: 1 }) : undefined),
        hooks: h,
      },
    );
    const card = (await repo.getMessages('g1', { limit: 50 })).find(
      (m) => m.type === 'group_bill',
    )!;
    const bill = await billOf('g1', card.meta!.billId as string);
    expect(bill).toBeDefined();
    // 参与人 = 除发起人外的 AI + 用户本人；发起人不欠自己钱。
    expect(bill!.parts.map((p) => p.id).sort()).toEqual(['ai_b', 'self']);
    expect(bill!.initiatorId).toBe('ai_a');
    expect(bill!.totalFen).toBe(30_00);

    expect(await payBill(bill!.billId, 'g1', 'self', hooksAt(T0 + 5_000))).toBe('paid');
    const out = (await repo.getWalletTxs()).find((t) => t.kind === 'bill_out')!;
    expect(out.amountFen).toBe(-15_00);
    expect(out.peerId).toBe('ai_a');
    expect(out.balanceAfterFen).toBe(50_00 - 15_00);
    // AI 发起、AI 付款 → 不动用户钱包（她们的钱是虚构的）。
    await payBill(bill!.billId, 'g1', 'ai_b', hooksAt(T0 + 6_000));
    expect((await repo.getWalletTxs()).filter((t) => t.kind === 'bill_in')).toHaveLength(0);
  });

  it('considerGroupBill：actionExists 守卫 + ai_money(kind=bill) 行；handleAiMoney 路由到 runBill', async () => {
    const members = [
      { contactId: 'ai_a', persona: persona('ai_a') },
      { contactId: 'ai_b', persona: persona('ai_b') },
    ];
    // 找一个本周中签的群 id（seeded，找得到就永远找得到）。
    let convId = '';
    for (let i = 0; i < 60 && !convId; i++) {
      if (planGroupBill({ now: T0, convId: `g${i}`, members, lastMsgAt: T0 })) convId = `g${i}`;
    }
    expect(convId).not.toBe('');
    const conv = { id: convId, type: 'group', lastMsgAt: T0 } as ConversationVM;
    expect(await considerGroupBill({ conv, members, now: T0 })).toBe(true);
    // 同周再问：id 已存在 → 不再入队（enqueue 会 upsert 复活已完成的行）。
    expect(await considerGroupBill({ conv, members, now: T0 + 3_600_000 })).toBe(false);

    const row = (await pendingActions()).find(
      (a: ScheduledAction) => a.kind === 'ai_money' && a.payloadJson.includes('"bill"'),
    )!;
    expect(row).toBeDefined();
    const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;
    expect(payload.kind).toBe('bill');

    // handler 分流到 runBill，而不是把它当红包发出去。
    const calls: string[] = [];
    const deps = {
      conversationExists: () => true,
      contactById: () => ({ id: 'x' }),
      personaFor: () => persona('x'),
      runBill: async (p: { convId: string; contactId: string; perFen: number; title: string }) =>
        void calls.push(`bill:${p.convId}:${p.perFen}:${p.title}`),
      runGift: async () => void calls.push('gift'),
      playMessageSound: () => {},
      now: () => T0,
    } as unknown as HandlerDeps;
    await handleAiMoney(deps, payload);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^bill:/);
  });

  it('handleBillPay：会话/联系人蒸发后装作无事发生', async () => {
    const calls: string[] = [];
    const deps = {
      conversationExists: (id: string) => id === 'g1',
      contactById: (id: string) => (id === 'ai_a' ? { id } : undefined),
      payBill: async (billId: string, convId: string, contactId: string) =>
        void calls.push(`${billId}:${convId}:${contactId}`),
    } as unknown as HandlerDeps;
    await handleBillPay(deps, { billId: 'b1', convId: 'gone', contactId: 'ai_a' });
    await handleBillPay(deps, { billId: 'b1', convId: 'g1', contactId: 'ai_gone' });
    await handleBillPay(deps, { billId: '', convId: 'g1', contactId: 'ai_a' });
    expect(calls).toEqual([]);
    await handleBillPay(deps, { billId: 'b1', convId: 'g1', contactId: 'ai_a' });
    expect(calls).toEqual(['b1:g1:ai_a']);
  });
});

/* ================================================================== */
/* 5. 账单游标分页                                                       */
/* ================================================================== */

describe('getWalletTxs 的游标分页（向后兼容）', () => {
  it('newest page first, ascending inside the page, cursor pages back exactly', async () => {
    for (let i = 0; i < 75; i++) {
      await repo.putWalletTx({
        id: `t${String(i).padStart(3, '0')}`,
        kind: 'adjust',
        amountFen: 1,
        title: `x${i}`,
        balanceAfterFen: i + 1,
        createdAt: T0 + i * 1_000,
      });
    }
    const all = await repo.getWalletTxs();
    expect(all).toHaveLength(75); // 无参调用 = 老契约，一分不少

    const page1 = await repo.getWalletTxs({ limit: 30 });
    expect(page1).toHaveLength(30);
    expect(page1[0].id).toBe('t045'); // 最新 30 条，页内升序
    expect(page1.at(-1)!.id).toBe('t074');
    const page2 = await repo.getWalletTxs({ limit: 30, before: page1[0].createdAt });
    expect(page2[0].id).toBe('t015');
    expect(page2.at(-1)!.id).toBe('t044');
    const page3 = await repo.getWalletTxs({ limit: 30, before: page2[0].createdAt });
    expect(page3.map((t) => t.id)).toEqual(all.slice(0, 15).map((t) => t.id));
    // 三页拼起来 == 全量（无重无漏）。
    expect([...page3, ...page2, ...page1].map((t) => t.id)).toEqual(all.map((t) => t.id));
  });

  it('recordWalletTx 之后余额推进仍然正确（它现在只读最新一行）', async () => {
    const h = hooksAt(T0);
    await repo.putWalletTx({
      id: 'seed',
      kind: 'adjust',
      amountFen: 10_00,
      title: '初始',
      balanceAfterFen: 10_00,
      createdAt: T0 - 5,
    });
    await sendTransfer('conv_lin', 'ai_lin', 3_00, '', h);
    const newest = (await repo.getWalletTxs({ limit: 1 }))[0];
    expect(newest.kind).toBe('transfer_out');
    expect(newest.balanceAfterFen).toBe(7_00);
    expect(newest.peerId).toBe('ai_lin');
  });
});

/* ================================================================== */
/* 6. 接线守卫（写了没接线 = 没做）                                        */
/* ================================================================== */

describe('J8 的接线真的存在', () => {
  const runtime = readFileSync(
    resolve(__dirname, '../../src/app/useSchedulerRuntime.ts'),
    'utf8',
  );

  it('rp_return / bill_pay 已注册；收款计划器与收钱动机都被消费', () => {
    expect(runtime).toContain("registerHandler('rp_return'");
    expect(runtime).toContain("registerHandler('bill_pay'");
    expect(runtime).toContain('considerGroupBill(');
    expect(runtime).toContain('receiveTransfer(');
  });

  it('聊天页真的能发起与支付（面板项 + 卡片 tap）', () => {
    const chat = readFileSync(resolve(__dirname, '../../src/features/chat/ChatPage.tsx'), 'utf8');
    expect(chat).toContain("key === 'groupbill'");
    expect(chat).toContain('onBillTap');
    expect(chat).toContain('payBill(');
    const panels = readFileSync(
      resolve(__dirname, '../../src/features/chat/ComposerPanels.tsx'),
      'utf8',
    );
    expect(panels).toContain("key: 'groupbill'");
  });

  it('rp/send 页有三选；开包页认得专属与过期', () => {
    const send = readFileSync(
      resolve(__dirname, '../../src/features/money/RedPacketSendPage.tsx'),
      'utf8',
    );
    expect(send).toContain('专属红包');
    expect(send).toContain("mode: 'even'");
    const open = readFileSync(
      resolve(__dirname, '../../src/features/money/RedPacketOpenPage.tsx'),
      'utf8',
    );
    expect(open).toContain('专属红包');
    expect(open).toContain('红包已过期');
  });

  it('一次性 rp_return 的守卫问的是「有没有过」(actionExists)', async () => {
    // 行为面：发一个包 → 行存在；就算把它标 cancel 再发同一个包也不复活。
    const h = hooksAt(T0);
    const rp = await sendRedPacket('conv_lin', 2_00, 1, '', [], h);
    expect(await actionStatus(`rp_return_${rp.id}`)).toBe('pending');
    const svc = readFileSync(resolve(__dirname, '../../src/ai/money-service.ts'), 'utf8');
    expect(svc).toMatch(/actionExists\(returnId\)/);
  });
});
