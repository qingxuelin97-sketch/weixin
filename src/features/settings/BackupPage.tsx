/**
 * Backup & restore screen (v3, M-I17 → M-I18). See specs/backup.md.
 *
 * Restore replaces everything, so this page is deliberately unhurried about it:
 * the file is parsed and its manifest summarized BEFORE anything is written, and
 * the user confirms against real row counts rather than a yes/no prompt.
 *
 * Sections:
 *   上次恢复没有完成 — only when the in-flight marker survived a launch, i.e.
 *     a restore was killed mid-write. Standing until acknowledged (I18-4);
 *   自动备份 — 关/每日/每周 chained through scheduled_actions (`auto_backup`);
 *   备份历史 — the app-managed shelf: restore / share / delete per entry.
 *     Entries show aggregate counts only — never conversation content, so a
 *     hidden AI↔AI DM cannot leak through this page (CLAUDE.md rule);
 *   存储引擎 — native-only SQLite migration + the 回退到 IndexedDB switch.
 *
 * Two rules this screen must not lose sight of:
 *   the base (watermarks + digest) advances ONLY after the package actually
 *   reached the shelf (I18-7), and a chain restore hands ONE snapshot to every
 *   increment so a failure halfway unwinds the whole chain (I18-5).
 */
import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { SubNav } from '../../components/SubNav';
import { saveTextFile } from '../../lib/save-file';
import { repo } from '../../db/repo';
import {
  exportBackupWithState,
  serializeBackup,
  parseBackup,
  restoreBackup,
  applyIncrementalBackup,
  commitBackupState,
  pendingRestoreAt,
  acknowledgePendingRestore,
  backupMode,
  backupFilename,
  type BackupFile,
} from '../../lib/backup';
import {
  listBackupHistory,
  readBackupContent,
  deleteBackupEntry,
  shareBackupEntry,
  recordBackup,
  resolveRestoreChain,
  type BackupHistoryEntry,
} from '../../lib/backup-history';
import { getAutoBackupFreq, setAutoBackupFreq, type AutoBackupFreq } from '../../ai/auto-backup';
import {
  isSqliteActive,
  sqliteMigratedAt,
  openNativeSqliteDb,
  activateSqliteDriver,
  revertToIdb,
} from '../../db/driver';
import { migrateToSqlite, type MigrateProgressEvent } from '../../db/migrate-to-sqlite';
import { showConfirm } from '../../components/dialog';
import './settings.css';
import { Switch } from '../../components/Switch';

/** Human labels for the store names shown in the manifest summary. */
const STORE_LABEL: Record<string, string> = {
  contacts: '联系人',
  personas: '人设',
  conversations: '会话',
  messages: '消息',
  memory_facts: '记忆',
  moments: '朋友圈',
  moment_likes: '点赞',
  moment_comments: '评论',
  red_packets: '红包',
  transfers: '转账',
  wallet_tx: '零钱明细',
  providers: 'API 配置',
  settings: '设置',
  media: '素材图片',
};

const FREQ_LABEL: Record<AutoBackupFreq, string> = {
  off: '关',
  daily: '每日',
  weekly: '每周',
};

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtTime(t: number): string {
  return new Date(t).toLocaleString('zh-CN', { hour12: false });
}

export function BackupPage() {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState<BackupFile | null>(null);
  const [includeMedia, setIncludeMedia] = useState(true);
  const [freq, setFreq] = useState<AutoBackupFreq>('off');
  const [history, setHistory] = useState<BackupHistoryEntry[]>([]);
  const [engine, setEngine] = useState<'idb' | 'sqlite'>('idb');
  const [migratedAt, setMigratedAt] = useState(0);
  const [migrateProgress, setMigrateProgress] = useState<MigrateProgressEvent | null>(null);
  // Non-zero ⇒ a previous restore never reached its last store. Announced here
  // as a standing warning (the launch pass announces it once); the marker is
  // only cleared when the user says he has seen it.
  const [interruptedAt, setInterruptedAt] = useState(0);
  const isNative = Capacitor.isNativePlatform();

  const refresh = async () => {
    setFreq(await getAutoBackupFreq());
    setHistory(await listBackupHistory());
    setEngine(isSqliteActive() ? 'sqlite' : 'idb');
    setMigratedAt(await sqliteMigratedAt());
    setInterruptedAt(await pendingRestoreAt());
  };
  useEffect(() => {
    void refresh().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const summarize = (counts: Record<string, number>) =>
    Object.entries(counts)
      .filter(([, n]) => n > 0)
      .map(([k, n]) => `${STORE_LABEL[k] ?? k} ${n}`)
      .join(' · ');

  const doExport = async () => {
    setBusy(true);
    setStatus(null);
    try {
      const now = Date.now();
      const { file, watermarks, digest } = await exportBackupWithState(now, undefined, {
        includeMedia,
      });
      const json = serializeBackup(file);
      const name = backupFilename(now);

      await saveTextFile(name, json, 'application/json', '保存备份文件');
      // Freshness marker for the "该备份了" nudge on the settings page.
      await repo.putSetting('lastBackupAt', now);
      // Manual fulls join the history shelf and advance the base, so later auto
      // increments chain onto a full the shelf actually holds. If the shelf
      // write fails, the base MUST NOT move: an increment cut against a full
      // that is not on the shelf can never be resolved into a restore chain,
      // and the span it covered would be missing without anything saying so.
      const shelved = await commitBackupState({ watermarks, digest }, () =>
        recordBackup(
          {
            id: `mb_${now}`,
            name,
            createdAt: now,
            bytes: json.length,
            mode: 'full',
            source: 'manual',
            counts: file.manifest.counts,
          },
          json,
        ),
      );
      await refresh();
      setStatus(
        shelved
          ? `已导出：${summarize(file.manifest.counts)}`
          : `已导出文件：${summarize(file.manifest.counts)}。` +
            '但未能存入备份历史，后续自动备份会重新做一次全量。',
      );
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      // Backing out of the share sheet isn't a failure — the file is written.
      setStatus(/cancel/i.test(msg) ? '已生成备份文件（未分享）' : `导出失败：${msg}`);
    } finally {
      setBusy(false);
    }
  };

  const pickFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = ''; // let the same file be picked again after an error
    if (!f) return;
    setStatus(null);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        setPending(parseBackup(String(reader.result)));
      } catch (err) {
        setPending(null);
        setStatus((err as Error).message);
      }
    };
    reader.onerror = () => setStatus('读取文件失败');
    reader.readAsText(f);
  };

  const confirmRestore = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      if (backupMode(pending) === 'incremental') {
        // A hand-picked increment applies onto whatever is present. The full
        // chain flow lives in the history list; this is the escape hatch.
        const applied = await applyIncrementalBackup(pending, Date.now());
        setPending(null);
        setStatus(`已叠加增量：${summarize(applied)}。请重启 App 以重新加载。`);
      } else {
        const res = await restoreBackup(pending, Date.now());
        setPending(null);
        const unknown = res.unknownStores.length
          ? `（${res.unknownStores.length} 项本版本无法识别，已跳过）`
          : '';
        setStatus(`恢复完成：${summarize(res.restored)}${unknown}。请重启 App 以重新加载。`);
      }
      await refresh();
    } catch (e) {
      setStatus(`恢复失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  const dismissInterrupted = async () => {
    await acknowledgePendingRestore();
    setInterruptedAt(0);
  };

  const changeFreq = async (next: AutoBackupFreq) => {
    setFreq(next);
    await setAutoBackupFreq(next, Date.now());
  };

  const restoreFromHistory = async (entry: BackupHistoryEntry) => {
    const chain = resolveRestoreChain(history, entry.id);
    if (!chain) {
      setStatus('该增量备份缺少对应的全量基础，无法恢复');
      return;
    }
    const ok = await showConfirm({
      title: '从历史恢复',
      body:
        `将恢复到 ${fmtTime(entry.createdAt)} 的备份` +
        (chain.length > 1 ? `（1 个全量 + ${chain.length - 1} 个增量按序叠加）` : '') +
        '。当前数据会被整库替换，替换前会留一份快照。',
      confirmText: '恢复',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      const now = Date.now();
      const [base, ...incs] = chain;
      // The base full's own snapshot is the true pre-chain state. Handing it to
      // every increment means a package that fails halfway unwinds the WHOLE
      // chain rather than leaving the user between two versions of his
      // history — and the media library is re-encoded once, not once per link.
      const { snapshot } = await restoreBackup(parseBackup(await readBackupContent(base)), now);
      for (let i = 0; i < incs.length; i++) {
        try {
          await applyIncrementalBackup(parseBackup(await readBackupContent(incs[i])), now, {
            snapshot,
          });
        } catch (e) {
          throw new Error(
            `第 ${i + 1}/${incs.length} 个增量包应用失败（${(e as Error).message}）` +
              '——已回滚到恢复前的状态，数据没有丢。',
          );
        }
      }
      setStatus('恢复完成。请重启 App 以重新加载。');
    } catch (e) {
      setStatus(`恢复失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
      await refresh();
    }
  };

  const deleteFromHistory = async (entry: BackupHistoryEntry) => {
    const ok = await showConfirm({
      title: '删除该备份',
      body: `${entry.name}（${fmtBytes(entry.bytes)}）将被删除，不可恢复。`,
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    await deleteBackupEntry(entry.id);
    await refresh();
  };

  const runMigration = async () => {
    const ok = await showConfirm({
      title: '迁移到 SQLite',
      body:
        '将把全部数据复制到原生 SQLite 数据库（IndexedDB 原数据保留不动）。' +
        '完成后 App 改用 SQLite；随时可回退。',
      confirmText: '开始迁移',
    });
    if (!ok) return;
    setBusy(true);
    setStatus(null);
    try {
      const db = await openNativeSqliteDb();
      const res = await migrateToSqlite(db, {
        now: () => Date.now(),
        onProgress: setMigrateProgress,
      });
      if (res.ok) {
        activateSqliteDriver(db);
        setStatus('迁移完成，已切换到 SQLite。');
      } else {
        setStatus(res.aborted ? '迁移已中断，可随时继续。' : `迁移失败：${res.error ?? '未知错误'}`);
      }
    } catch (e) {
      setStatus(`迁移失败：${(e as Error).message}`);
    } finally {
      setMigrateProgress(null);
      setBusy(false);
      await refresh();
    }
  };

  const toggleEngine = async () => {
    if (engine === 'sqlite') {
      const ok = await showConfirm({
        title: '回退到 IndexedDB',
        body:
          '将改回使用 IndexedDB（数据仍在原处，未被迁移动过）。' +
          '切换到 SQLite 之后新产生的内容不会自动回流，重新迁移会以 IndexedDB 为准覆盖。',
        confirmText: '回退',
        danger: true,
      });
      if (!ok) return;
      await revertToIdb();
      setStatus('已回退到 IndexedDB。请重启 App 以重新加载。');
      await refresh();
    } else {
      await runMigration();
    }
  };

  return (
    <>
      <SubNav title="备份与恢复" />
      <div className="page-body settings">
        {interruptedAt > 0 && (
          <div className="settings__group">
            <div className="settings__group-title">上次恢复没有完成</div>
            <p className="settings__hint settings__hint--warn">
              {fmtTime(interruptedAt)} 开始的那次恢复中途被中断（App 被系统回收或断电），
              当前数据可能是半截的。建议重新完整恢复一次同一个备份。
            </p>
            <div className="settings__actions">
              <button className="settings__btn" onClick={() => void dismissInterrupted()}>
                我已了解
              </button>
            </div>
          </div>
        )}

        <div className="settings__group">
          <button className="settings__row settings__row--divided" disabled={busy} onClick={() => void doExport()}>
            <span className="settings__label">导出备份</span>
            <span className="settings__value">.aiwx 文件</span>
          </button>
          <div
            className="settings__row settings__row--divided"
            onClick={() => setIncludeMedia((v) => !v)}
          >
            <span className="settings__label">备份包含素材图片</span>
            <Switch on={includeMedia} onChange={() => setIncludeMedia((v) => !v)} />
          </div>
          <label className="settings__row">
            <span className="settings__label">从文件恢复</span>
            <span className="settings__value">选择 .aiwx</span>
            <input type="file" accept=".aiwx,application/json" hidden onChange={pickFile} />
          </label>
        </div>

        <p className="settings__hint">
          备份包含全部会话、消息、人设、朋友圈与零钱记录。
          <strong>API key 不会被导出</strong>——它只存在设备安全存储里，恢复后需要重新填写。
          语音缓存也不导出，可按原文重新合成。
        </p>

        {pending && (
          <div className="settings__group">
            <div className="settings__group-title">
              {backupMode(pending) === 'incremental' ? '确认叠加增量' : '确认恢复'}
            </div>
            <p className="settings__hint">
              该备份创建于{' '}
              {fmtTime(pending.manifest.createdAt)}，
              {backupMode(pending) === 'incremental' ? '为增量包，' : ''}
              包含：{summarize(pending.manifest.counts) || '（空）'}。
            </p>
            <p className="settings__hint settings__hint--warn">
              {backupMode(pending) === 'incremental'
                ? '增量恢复会在当前数据之上叠加该包的内容；请确认当前数据已经是它所基于的全量状态。'
                : '恢复会整库替换当前数据，不是合并。现有内容会在替换前留一份快照。'}
            </p>
            <div className="settings__actions">
              <button className="settings__btn" disabled={busy} onClick={() => setPending(null)}>
                取消
              </button>
              <button
                className="settings__btn settings__btn--danger"
                disabled={busy}
                onClick={() => void confirmRestore()}
              >
                {backupMode(pending) === 'incremental' ? '确认叠加' : '确认恢复'}
              </button>
            </div>
          </div>
        )}

        <div className="settings__group">
          <div className="settings__group-title">自动备份</div>
          <div className="segmented">
            {(['off', 'daily', 'weekly'] as AutoBackupFreq[]).map((f) => (
              <div
                key={f}
                className={`segmented__item${freq === f ? ' segmented__item--active' : ''}`}
                onClick={() => void changeFreq(f)}
              >
                {FREQ_LABEL[f]}
              </div>
            ))}
          </div>
          <p className="settings__hint">
            按所选频率自动生成备份到下方历史列表：每 7 次做一次全量，其余为增量（只含新增内容，
            体积很小）。新的全量会自动清理它之前的旧自动备份。
          </p>
        </div>

        <div className="settings__group">
          <div className="settings__group-title">备份历史</div>
          {history.length === 0 && <p className="settings__hint">还没有备份记录。</p>}
          {history.map((e) => (
            <div key={e.id} className="settings__row settings__row--divided">
              <span className="settings__label">
                {fmtTime(e.createdAt)}
                <br />
                <span className="settings__value">
                  {e.mode === 'full' ? '全量' : '增量'} · {fmtBytes(e.bytes)} ·{' '}
                  {e.source === 'auto' ? '自动' : '手动'}
                </span>
              </span>
              <span className="settings__actions">
                <button
                  className="settings__btn"
                  disabled={busy}
                  onClick={() => void restoreFromHistory(e)}
                >
                  恢复
                </button>
                <button
                  className="settings__btn"
                  disabled={busy}
                  onClick={() => void shareBackupEntry(e).catch(() => {})}
                >
                  分享
                </button>
                <button
                  className="settings__btn settings__btn--danger"
                  disabled={busy}
                  onClick={() => void deleteFromHistory(e)}
                >
                  删除
                </button>
              </span>
            </div>
          ))}
        </div>

        <div className="settings__group">
          <div className="settings__group-title">存储引擎</div>
          <div className="settings__row settings__row--divided">
            <span className="settings__label">当前引擎</span>
            <span className="settings__value">
              {engine === 'sqlite'
                ? `SQLite（${fmtTime(migratedAt)} 迁移）`
                : 'IndexedDB'}
            </span>
          </div>
          {isNative ? (
            <div className="settings__row" onClick={() => void toggleEngine()}>
              <span className="settings__label">
                {engine === 'sqlite' ? '回退到 IndexedDB' : '迁移到 SQLite'}
              </span>
              <Switch
                on={engine === 'sqlite'}
                disabled={busy}
                onChange={() => void toggleEngine()}
              />
            </div>
          ) : (
            <p className="settings__hint">Web 端固定使用 IndexedDB；SQLite 仅在 App 内可用。</p>
          )}
          {migrateProgress && (
            <p className="settings__hint">
              正在迁移 {STORE_LABEL[migrateProgress.store] ?? migrateProgress.store}（
              {migrateProgress.storeIndex + 1}/{migrateProgress.storeCount}）：
              {migrateProgress.rows}/{migrateProgress.totalRows} 行
            </p>
          )}
        </div>

        {status && <p className="settings__hint">{status}</p>}
      </div>
    </>
  );
}
