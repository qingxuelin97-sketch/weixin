import { useEffect, useState } from 'react';
import { SubNav } from '../../components/SubNav';
import { repo } from '../../db/repo';
import { LinkRow } from './rows';
import './settings.css';

/**
 * 设置 (M-K4 重排)：微信 8.0 的分层结构。
 *
 *   AI 与模型                       ← 这个 App 的「账号与安全」：没它什么都不会动
 *   ───
 *   新消息通知 / 聊天 / 通用         ← 微信同名的三页
 *   ───
 *   备份与恢复 / 原生增强 / 环境自检  ← 数据与设备
 *
 * 每一项的读写原样搬进了 ./SettingsSections（分页）；这一页只剩入口与两处「值」
 * ——模型配没配、多久没备份——因为这两件事值得在第一眼就看见。
 */
export function SettingsPage() {
  const [providerCount, setProviderCount] = useState<number | null>(null);
  const [backupHint, setBackupHint] = useState('');

  useEffect(() => {
    void repo.getProviders().then((p) => setProviderCount(p.filter((x) => x.enabled).length));
    // Freshness nudge: data is the only asset this app has, and .aiwx is its
    // only escape hatch — surface staleness where the user will see it.
    void repo.getSetting<number>('lastBackupAt').then((t) => {
      if (!t) return setBackupHint('从未备份');
      const days = Math.floor((Date.now() - t) / 86_400_000);
      setBackupHint(days === 0 ? '今天已备份' : days > 7 ? `${days} 天前，该备份了` : `${days} 天前`);
    });
  }, []);

  return (
    <>
      <SubNav title="设置" />
      <div className="page-body settings">
        <div className="settings__group">
          <LinkRow
            label="AI 与模型"
            value={providerCount == null ? '' : providerCount > 0 ? `${providerCount} 个已启用` : '未配置'}
            to="/settings/ai"
            last
          />
        </div>
        <div className="settings__group">
          <LinkRow label="新消息通知" to="/settings/notify" />
          <LinkRow label="聊天" to="/settings/chat" />
          <LinkRow label="通用" to="/settings/general" last />
        </div>
        <div className="settings__group">
          <LinkRow label="备份与恢复" value={backupHint} to="/settings/backup" />
          <LinkRow label="原生增强" value="气泡 · 回复 · 来电 · 小组件" to="/settings/native" />
          <LinkRow label="环境自检与日志" to="/settings/env" last />
        </div>
        <p className="settings__footer">AI 微信 · 个人自用 · 数据只存在这台手机上</p>
      </div>
    </>
  );
}
