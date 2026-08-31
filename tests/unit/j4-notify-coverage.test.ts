/**
 * 通知表态台账 (M-J4a) red-guards — M-J 侦察结论 #3 的永久修复：
 * 「17 种排期动作里只有 4 种出通知；她转账/打电话/群里说话在 App 关闭时全部无声」。
 *
 *   1. 台账完备：NOTIFY_STANCE 的键集合 == SCHEDULED_ACTION_KINDS（新 kind
 *      不表态即转红）；每条 silent 都有像样的理由。
 *   2. 动作即内容类（ai_money/ai_call/bill_pay）：正文按 payload 分支定死、
 *      reaction 档、路由进聊天页（来电也进聊天页——几小时后点开的"来电"落在
 *      响铃页是陷阱）。
 *   3. 群标题类（group_msg/group_chatter）：标题走 groupTitleOf、followup 档；
 *      解析不到群名（含隐藏会话）静默出局。
 *   4. followup 归并：同一会话的多条「[你收到一条消息]」只留最早那条。
 *   5. 泄漏红测：agent_dm 带全须全尾的 payload 也产不出任何通知。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  NOTIFY_STANCE,
  toNotifiable,
  buildNotifications,
  MONEY_NOTIFY_BODY,
  CALL_NOTIFY_BODY,
  BILL_PAY_NOTIFY_BODY,
} from '../../src/ai/notify-service';
import { SCHEDULED_ACTION_KINDS } from '../../src/db/schema';
import type { ScheduledAction, ActionKind } from '../../src/ai/scheduler';

const NOW = new Date(2025, 7, 6, 12, 0, 0).getTime();
const HOUR = 3_600_000;

function action(
  kind: ActionKind,
  payload: unknown,
  over: Partial<ScheduledAction> = {},
): ScheduledAction {
  return {
    id: `${kind}_t`,
    fireAt: NOW + HOUR,
    kind,
    payloadJson: JSON.stringify(payload),
    status: 'pending',
    createdAt: NOW,
    ...over,
  };
}

const nameOf = (id: string) => (id === 'ai_a' ? '林小雨' : undefined);
const groupTitleOf = (convId: string) => (convId === 'conv_g' ? '露营小分队' : undefined);

describe('台账完备性', () => {
  it('键集合 == SCHEDULED_ACTION_KINDS（新 kind 不表态即转红）', () => {
    expect(Object.keys(NOTIFY_STANCE).sort()).toEqual([...SCHEDULED_ACTION_KINDS].sort());
  });

  it('每条 silent 都写了像样的理由（≥15 字）', () => {
    for (const [kind, stance] of Object.entries(NOTIFY_STANCE)) {
      if (stance.via === 'silent') {
        expect(stance.why.length, `${kind} 的理由太敷衍`).toBeGreaterThanOrEqual(15);
      }
    }
  });

  it('侦察结论 #3 点名的三类（她转账/打电话/群里说话）都已 eligible', () => {
    expect(NOTIFY_STANCE.ai_money.via).toBe('eligible');
    expect(NOTIFY_STANCE.ai_call.via).toBe('eligible');
    expect(NOTIFY_STANCE.group_msg.via).toBe('eligible');
    expect(NOTIFY_STANCE.group_chatter.via).toBe('eligible');
  });
});

describe('动作即内容类', () => {
  it('ai_money 按 payload.kind 出正文，reaction 档，路由进聊天页', () => {
    const rows = toNotifiable([
      action('ai_money', { contactId: 'ai_a', convId: 'c1', amountFen: 888 }),
      action('ai_money', { contactId: 'ai_a', convId: 'c1', kind: 'transfer', amountFen: 500 }, { id: 'm2' }),
      action('ai_money', { contactId: 'ai_a', convId: 'conv_g', kind: 'bill', amountFen: 300 }, { id: 'm3' }),
    ]);
    expect(rows.map((r) => r.body)).toEqual([
      MONEY_NOTIFY_BODY.rp,
      MONEY_NOTIFY_BODY.transfer,
      MONEY_NOTIFY_BODY.bill,
    ]);
    expect(rows.every((r) => r.notifyKind === 'reaction')).toBe(true);
    expect(rows[0].route).toBe('aiwx://chat/c1');
  });

  it('ai_call 过去式正文，路由进聊天页而不是响铃页', () => {
    const [row] = toNotifiable([action('ai_call', { contactId: 'ai_a', convId: 'c1' })]);
    expect(row.body).toBe(CALL_NOTIFY_BODY);
    expect(CALL_NOTIFY_BODY).toContain('打过'); // 过去式措辞是契约的一部分
    expect(row.route).toBe('aiwx://chat/c1');
    expect(row.route).not.toContain('call');
  });

  it('bill_pay 出「支付了群收款」', () => {
    const [row] = toNotifiable([
      action('bill_pay', { contactId: 'ai_a', convId: 'conv_g', billId: 'b1' }),
    ]);
    expect(row.body).toBe(BILL_PAY_NOTIFY_BODY);
    expect(row.notifyKind).toBe('reaction');
  });

  it('金额从不进通知正文（锁屏不该报数）', () => {
    const rows = toNotifiable([
      action('ai_money', { contactId: 'ai_a', convId: 'c1', amountFen: 88_888 }),
    ]);
    expect(rows[0].body).not.toMatch(/\d/);
  });
});

describe('群标题类', () => {
  it('标题走 groupTitleOf，followup 档', () => {
    const rows = toNotifiable([action('group_chatter', { convId: 'conv_g', at: NOW + HOUR })], {
      groupTitleOf,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('露营小分队');
    expect(rows[0].notifyKind).toBe('followup');
    const built = buildNotifications(rows, nameOf, NOW);
    expect(built[0].title).toBe('露营小分队');
  });

  it('解析不到群名（隐藏会话或无上下文）静默出局', () => {
    expect(
      toNotifiable([action('group_msg', { contactId: 'ai_a', convId: 'conv_hidden' })], {
        groupTitleOf,
      }),
    ).toEqual([]);
    // 连 opts 都没传（无会话上下文的调用方）也一样安全。
    expect(toNotifiable([action('group_msg', { contactId: 'ai_a', convId: 'conv_g' })])).toEqual(
      [],
    );
  });
});

describe('followup 归并', () => {
  it('同一会话的多条无正文 followup 只留最早那条；不同会话互不影响', () => {
    const rows = toNotifiable(
      [
        action('group_chatter', { convId: 'conv_g' }, { id: 'g1', fireAt: NOW + 3 * HOUR }),
        action('group_chatter', { convId: 'conv_g' }, { id: 'g2', fireAt: NOW + 1 * HOUR }),
        action('heartbeat', { contactId: 'ai_a', convId: 'c_solo' }, { id: 'h1', fireAt: NOW + 2 * HOUR }),
      ],
      { groupTitleOf },
    );
    const built = buildNotifications(rows, nameOf, NOW);
    const groupOnes = built.filter((b) => b.title === '露营小分队');
    expect(groupOnes).toHaveLength(1);
    expect(groupOnes[0].fireAt).toBe(NOW + 1 * HOUR); // 最早那条
    expect(built.some((b) => b.title === '林小雨')).toBe(true);
  });

  it('有正文的（reaction/greeting）各是各的信息，不归并', () => {
    const rows = toNotifiable([
      action('ai_money', { contactId: 'ai_a', convId: 'c1', amountFen: 100 }, { id: 'a1', fireAt: NOW + HOUR }),
      action('ai_money', { contactId: 'ai_a', convId: 'c1', kind: 'transfer', amountFen: 200 }, { id: 'a2', fireAt: NOW + 2 * HOUR }),
    ]);
    expect(buildNotifications(rows, nameOf, NOW)).toHaveLength(2);
  });
});

describe('原生硬件面 (M-J4b)', () => {
  const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');

  it('manifest 声明精确闹钟——不声明 = 预调度通知在 Android 12+ 全部退化不精确', () => {
    const m = read('android/app/src/main/AndroidManifest.xml');
    expect(m).toContain('android.permission.SCHEDULE_EXACT_ALARM');
    expect(m).toContain('android.permission.USE_EXACT_ALARM');
  });

  it('锁屏来电走动态 flag，绝不在 manifest 里静态声明（那是把整个 App 抬到锁屏之上）', () => {
    const m = read('android/app/src/main/AndroidManifest.xml');
    expect(m).not.toContain('showWhenLocked');
    const act = read('android/app/src/main/java/com/personal/weixinai/MainActivity.kt');
    expect(act).toContain('setShowWhenLocked(isIncomingCall)');
    expect(act).toContain('setTurnScreenOn(isIncomingCall)');
    // 非来电 intent 必须复位——singleTask 实例活得比一次来电久。
    expect(act).toContain('onNewIntent');
  });
});

describe('泄漏红测', () => {
  it('agent_dm 带全须全尾的 payload 也产不出任何通知（隐藏面永不出锁屏）', () => {
    const rows = toNotifiable(
      [
        action('agent_dm', {
          contactId: 'ai_a',
          convId: 'conv_g',
          body: '这条要是出现在锁屏上就是穿帮',
        }),
      ],
      { groupTitleOf },
    );
    expect(rows).toEqual([]);
  });

  it("表态 silent 的 kind 一律产不出通知（抽查 story_tick / recall / joint_plan）", () => {
    for (const kind of ['story_tick', 'recall', 'joint_plan'] as const) {
      expect(
        toNotifiable([action(kind, { contactId: 'ai_a', convId: 'conv_g', body: 'x' })], {
          groupTitleOf,
        }),
        kind,
      ).toEqual([]);
    }
  });
});
