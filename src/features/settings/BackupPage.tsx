/**
 * Backup & restore screen.
 *
 * Restore replaces everything, so this page is deliberately unhurried about it:
 * the file is parsed and its manifest summarized BEFORE anything is written, and
 * the user confirms against real row counts rather than a yes/no prompt.
 */
import { useState } from 'react';
import { SubNav } from '../../components/SubNav';
import { saveTextFile } from '../../lib/save-file';
import { repo } from '../../db/repo';
import {
  exportBackup,
  serializeBackup,
  parseBackup,
  restoreBackup,
  backupFilename,
  type BackupFile,
} from '../../lib/backup';
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

export function BackupPage() {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [pending, setPending] = useState<BackupFile | null>(null);
  const [includeMedia, setIncludeMedia] = useState(true);

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
      const file = await exportBackup(now, undefined, { includeMedia });
      const json = serializeBackup(file);
      const name = backupFilename(now);

      await saveTextFile(name, json, 'application/json', '保存备份文件');
      // Freshness marker for the "该备份了" nudge on the settings page.
      await repo.putSetting('lastBackupAt', now);
      setStatus(`已导出：${summarize(file.manifest.counts)}`);
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
      const res = await restoreBackup(pending, Date.now());
      setPending(null);
      const unknown = res.unknownStores.length
        ? `（${res.unknownStores.length} 项本版本无法识别，已跳过）`
        : '';
      setStatus(`恢复完成：${summarize(res.restored)}${unknown}。请重启 App 以重新加载。`);
    } catch (e) {
      setStatus(`恢复失败：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SubNav title="备份与恢复" />
      <div className="page-body settings">
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
            <div className="settings__group-title">确认恢复</div>
            <p className="settings__hint">
              该备份创建于{' '}
              {new Date(pending.manifest.createdAt).toLocaleString('zh-CN', { hour12: false })}，
              包含：{summarize(pending.manifest.counts) || '（空）'}。
            </p>
            <p className="settings__hint settings__hint--warn">
              恢复会<strong>整库替换</strong>当前数据，不是合并。现有内容会在替换前留一份快照。
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
                确认恢复
              </button>
            </div>
          </div>
        )}

        {status && <p className="settings__hint">{status}</p>}
      </div>
    </>
  );
}
