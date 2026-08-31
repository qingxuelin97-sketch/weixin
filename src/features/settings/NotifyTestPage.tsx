/**
 * 后台通知自检（M-C1）。这一页回答本项目最大的未知数：在用户这台国产 ROM 上，
 * AlarmManager 预调度的通知在切后台/强杀后到底能不能到。答案直接决定
 * M-C3 之后要不要投入常驻前台服务（能到 = 不做，撞铁律 5 的风险白担）。
 *
 * 结果由用户自报（逐条打勾）——锁屏投递本质上只有人眼能验收。
 */
import { useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { SubNav } from '../../components/SubNav';
import {
  requestPermission,
  scheduleNotifications,
  notificationId,
  cancelNotifyTest,
  type ScheduledNotification,
} from '../../lib/notify';
import './settings.css';
import { Switch } from '../../components/Switch';

/** Minutes after "开始测试" at which each round fires. */
const ROUNDS = [1, 5, 15];

interface TestRecord {
  startedAt: number;
  fireAts: number[];
  received: boolean[];
}

const REC_KEY = 'aiwx_notify_test';

function loadRecord(): TestRecord | null {
  try {
    const raw = localStorage.getItem(REC_KEY);
    return raw ? (JSON.parse(raw) as TestRecord) : null;
  } catch {
    return null;
  }
}

function saveRecord(r: TestRecord | null): void {
  if (r) localStorage.setItem(REC_KEY, JSON.stringify(r));
  else localStorage.removeItem(REC_KEY);
}

const fmtTime = (t: number) =>
  new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

export function NotifyTestPage() {
  const [record, setRecord] = useState<TestRecord | null>(loadRecord());
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isNative = Capacitor.isNativePlatform();

  const start = async () => {
    setBusy(true);
    setStatus(null);
    try {
      // A restart must not inherit ghost rounds from an abandoned earlier test.
      await cancelNotifyTest();
      const granted = await requestPermission();
      if (!granted) {
        setStatus('通知权限未授予——请先在系统设置里允许本应用通知');
        return;
      }
      const now = Date.now();
      const items: ScheduledNotification[] = ROUNDS.map((min, i) => ({
        id: notificationId(`notify_test_${i + 1}`),
        title: '通知自检',
        body: `第 ${i + 1}/3 条（${min} 分钟档）按时到达`,
        fireAt: now + min * 60_000,
        kind: 'greeting', // time-anchored → body may be pre-written
      }));
      const taken = await scheduleNotifications(items, now);
      if (taken < items.length) {
        setStatus(
          isNative
            ? `系统只接受了 ${taken}/3 条排期，结果可能不完整`
            : '浏览器无法为未运行的页面排期通知——此测试只在 APK 上有意义',
        );
        if (taken === 0) return;
      }
      const rec: TestRecord = {
        startedAt: now,
        fireAts: items.map((n) => n.fireAt),
        received: [false, false, false],
      };
      saveRecord(rec);
      setRecord(rec);
    } catch (e) {
      setStatus(`排期失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const toggleReceived = (i: number) => {
    if (!record) return;
    const next = {
      ...record,
      received: record.received.map((v, j) => (j === i ? !v : v)),
    };
    saveRecord(next);
    setRecord(next);
  };

  const reset = () => {
    void cancelNotifyTest(); // still-pending rounds must die with the record
    saveRecord(null);
    setRecord(null);
    setStatus(null);
  };

  return (
    <>
      <SubNav title="后台通知测试" />
      <div className="page-body settings">
        <div className="settings__group">
          <div className="field">
            <span className="field__hint">
              点「开始测试」会排 3 条本地通知（1 / 5 / 15 分钟后触发）。之后请：①锁屏或切到
              别的应用等第 1、2 条；②从最近任务里上滑强杀本应用，等第 3 条。全部等完后回来，
              把真正弹出来的逐条打勾——结果决定后续要不要做常驻服务保活。
            </span>
          </div>
          {!record ? (
            <button className="btn-primary" onClick={() => void start()} disabled={busy}>
              {busy ? '排期中…' : '开始测试'}
            </button>
          ) : (
            <>
              {ROUNDS.map((min, i) => (
                <div
                  key={min}
                  className="settings__row settings__row--divided"
                  onClick={() => toggleReceived(i)}
                >
                  <span className="settings__label">
                    第 {i + 1} 条 · {min} 分钟档（约 {fmtTime(record.fireAts[i])}）
                  </span>
                  <Switch on={record.received[i]} onChange={() => toggleReceived(i)} />
                </div>
              ))}
              <div className="field">
                <span className="field__hint">
                  {record.received.every(Boolean)
                    ? '3/3 全到 ✅ 你的系统按时投递预调度通知，无需常驻服务。'
                    : record.received.some(Boolean)
                      ? '部分到达——通常是省电策略延迟/拦截了长间隔档，建议在系统设置里给本应用「无限制」后台权限再测一轮。'
                      : '等三个时间点都过了再打勾；一条都没到多半是通知权限或省电策略问题。'}
                </span>
              </div>
              <button className="btn-ghost" onClick={reset}>
                重新测试
              </button>
            </>
          )}
          {status && <div className="test-result">{status}</div>}
        </div>
      </div>
    </>
  );
}
