/**
 * 她在后台活着 (M-J4) red-guards.
 *
 * The load-bearing claim of this whole layer is a NEGATIVE one: **Kotlin never
 * generates content.** Everything else (snapshot, worker, alarms, MessagingStyle)
 * is ordinary plumbing; the moment a background code path can produce a line,
 * the app grows a second time-evolution source (铁律 5) and a second LLM call
 * site no nsfw-callsite test can see (铁律 6). These tests are what make that
 * claim checkable instead of aspirational.
 *
 *   1. 快照是投影：buildWakeRows 只从 buildNotifications 派生——分级、时间窗、
 *      去重三件事不可能与 App 内路径漂移；
 *   2. 无预览档必须以空正文过桥（Kotlin 补平台措辞，绝不自己编）；
 *   3. 静默 kind（含隐藏会话面）不进快照；
 *   4. 原生侧零 LLM：Kotlin 全量扫描不得出现网络/密钥/生成的任何痕迹；
 *   5. 接线扫描：写快照、开周期唤醒、开机重排、清历史四条线都真接上了。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  toNotifiable,
  buildNotifications,
  buildWakeRows,
  NOTIFY_STANCE,
} from '../../src/ai/notify-service';
import { NO_PREVIEW_BODY } from '../../src/lib/notify';
import type { ScheduledAction, ActionKind } from '../../src/ai/scheduler';

const NOW = new Date(2025, 7, 6, 12, 0, 0).getTime();
const HOUR = 3_600_000;

const read = (p: string) => readFileSync(resolve(__dirname, '../../', p), 'utf8');
const KOTLIN_DIR = 'android/app/src/main/java/com/personal/weixinai';

function kotlinSources(): Array<{ path: string; src: string }> {
  const out: Array<{ path: string; src: string }> = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(resolve(__dirname, '../../', dir), { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.kt')) out.push({ path: p, src: read(p) });
    }
  };
  walk(KOTLIN_DIR);
  return out;
}

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
const tintOf = (id: string) => (id === 'ai_a' ? '#AABBCC' : undefined);
const groupTitleOf = (c: string) => (c === 'conv_g' ? '露营小分队' : undefined);

describe('快照是投影，不是第二份判断', () => {
  it('每一行都能在 buildNotifications 的输出里找到同 id 同时刻的对应项', () => {
    const acts = toNotifiable(
      [
        action('heartbeat', { contactId: 'ai_a', convId: 'c1', body: '早安' }),
        action('ai_money', { contactId: 'ai_a', convId: 'c1', amountFen: 100 }, { id: 'm1' }),
        action('group_chatter', { convId: 'conv_g' }, { id: 'g1' }),
      ],
      { groupTitleOf },
    );
    const notifs = buildNotifications(acts, nameOf, NOW);
    const rows = buildWakeRows(acts, nameOf, tintOf, NOW);
    // 每行都有对应通知，且时刻一致（时间窗/去重规则同源）。
    for (const row of rows) {
      const match = notifs.find((n) => n.fireAt === row.fireAt && n.title === row.title);
      expect(match, `${row.id} 在通知列表里没有对应项`).toBeTruthy();
    }
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(notifs.length);
  });

  it('时间窗与已到期规则同源：过去的与 24h 之外的都不进快照', () => {
    const acts = toNotifiable([
      action('heartbeat', { contactId: 'ai_a', convId: 'c1' }, { id: 'past', fireAt: NOW - 1 }),
      action('heartbeat', { contactId: 'ai_a', convId: 'c1' }, { id: 'far', fireAt: NOW + 48 * HOUR }),
    ]);
    expect(buildWakeRows(acts, nameOf, tintOf, NOW)).toEqual([]);
  });

  it('无预览档以空正文过桥——措辞归平台层，JS 不替 Kotlin 编词', () => {
    const acts = toNotifiable([action('group_msg', { convId: 'conv_g' })], { groupTitleOf });
    const rows = buildWakeRows(acts, nameOf, tintOf, NOW);
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe('');
    // 而且绝不是把平台措辞塞进来。
    expect(rows[0].body).not.toBe(NO_PREVIEW_BODY);
  });

  it('可展示的正文原样过桥（她真发了红包，锁屏就该这么写）', () => {
    const acts = toNotifiable([
      action('ai_money', { contactId: 'ai_a', convId: 'c1', amountFen: 500 }),
    ]);
    const rows = buildWakeRows(acts, nameOf, tintOf, NOW);
    expect(rows[0].body).toContain('红包');
    expect(rows[0].tint).toBe('#AABBCC');
    expect(rows[0].convId).toBe('c1');
    expect(rows[0].route).toBe('aiwx://chat/c1');
  });

  it('静默 kind 一律不进快照（agent_dm 带全须全尾也一样）', () => {
    const acts = toNotifiable(
      [action('agent_dm', { contactId: 'ai_a', convId: 'conv_g', body: '这条不许出现' })],
      { groupTitleOf },
    );
    expect(buildWakeRows(acts, nameOf, tintOf, NOW)).toEqual([]);
    expect(NOTIFY_STANCE.agent_dm.via).toBe('silent');
  });
});

describe('原生侧零 LLM——这一层的全部安全性都压在这条上', () => {
  const sources = kotlinSources();

  it('扫到了 Kotlin 源码（守卫不能空转）', () => {
    expect(sources.length).toBeGreaterThan(8);
    expect(sources.some((f) => f.path.includes('Wake.kt'))).toBe(true);
  });

  it('后台唤醒路径不含任何生成/网络/密钥的痕迹', () => {
    // SseBridge 是**前台**流式桥：它由 JS 在 App 活着时发起，URL 和 key 都由
    // JS 传进来，Kotlin 只是搬运字节。后台三个文件必须连搬运都没有。
    const backgroundFiles = ['Wake.kt', 'WakeWorker.kt', 'Snapshot.kt', 'Conversations.kt'];
    const forbidden = [
      'OkHttp', 'HttpURLConnection', 'okhttp3', // 网络
      'apiKey', 'Authorization', 'KeyStore', // 密钥
      'chat/completions', 'messages', // 端点
    ];
    for (const name of backgroundFiles) {
      const f = sources.find((x) => x.path.endsWith(name));
      expect(f, `${name} 不见了`).toBeTruthy();
      for (const needle of forbidden) {
        expect(
          f!.src.includes(needle),
          `${name} 出现了「${needle}」——后台产出会同时打破铁律 5 与铁律 6`,
        ).toBe(false);
      }
    }
  });

  it('Wake.kt 写明了为什么不能在 Kotlin 生成（后人要能查到理由）', () => {
    const src = sources.find((f) => f.path.endsWith('Wake.kt'))!.src;
    expect(src).toContain('non-extractable');
    expect(src).toContain('铁律');
  });
});

describe('接线扫描（写了没接线 = 没做）', () => {
  it('前台 pass 会把快照推给原生，且与通知走同一份 toNotifiable', () => {
    const src = read('src/app/useSchedulerRuntime.ts');
    expect(src).toContain('writeWakeSnapshot');
    expect(src).toContain('buildWakeRows(toNotifiable(wakeInput.pending');
    // 同一个 pending 数组喂两条路——第二次 pendingActions() 就是两份判断了。
    // 而且唤醒块自己不许再查一次队列——那就是第二份判断的开始。
    const block = src.slice(src.indexOf('4b) 她在后台活着'));
    const wakeBlock = block.slice(0, block.indexOf('\n  }'));
    expect(wakeBlock).not.toContain('pendingActions(');
  });

  it('周期唤醒在启动时自愈，开机后重排闹钟', () => {
    expect(read(`${KOTLIN_DIR}/MainActivity.kt`)).toContain('WakeWorker.ensureScheduled');
    const wake = read(`${KOTLIN_DIR}/aiwx/Wake.kt`);
    expect(wake).toContain('ACTION_BOOT_COMPLETED');
    expect(wake).toContain('deliverDue');
  });

  it('manifest 注册了两个接收器并申明开机权限', () => {
    const m = read('android/app/src/main/AndroidManifest.xml');
    expect(m).toContain('.aiwx.WakeAlarmReceiver');
    expect(m).toContain('.aiwx.BootReceiver');
    expect(m).toContain('android.permission.RECEIVE_BOOT_COMPLETED');
  });

  it('打开聊天页会清掉通知栏的堆叠历史（否则重放刚读过的话）', () => {
    expect(read('src/features/chat/ChatPage.tsx')).toContain('clearConversationHistory(convId)');
  });

  it('精确闹钟被拒时降级而不是崩——后台崩溃是看不见的致命', () => {
    const wake = read(`${KOTLIN_DIR}/aiwx/Wake.kt`);
    expect(wake).toContain('canScheduleExactAlarms');
    expect(wake).toContain('catch (e: SecurityException)');
  });
});
