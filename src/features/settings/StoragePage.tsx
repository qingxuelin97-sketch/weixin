/**
 * 存储用量 (M-J10)。
 *
 * 一个 local-first、没有服务端、把几万条消息和整个媒体库都压在设备上的 App，
 * 到今天为止**没有任何一个界面回答「它占了多少」**。而这恰恰是用户唯一能自己
 * 判断「该导备份了 / 该清点东西了」的依据——WebView 的存储配额被浏览器/系统
 * 拿走时不会有任何提示，只会开始静默写失败。
 *
 * 数据全部走 `Repo`（`storageReport`），页面只负责画。绕开接口直打 idb 是
 * story 表当年断在双驱动上的原因，不重演。
 */
import { useEffect, useState } from 'react';
import { SubNav } from '../../components/SubNav';
import { repo } from '../../db/repo';
import { humanSize } from '../../ai/bubble-materialize';
import type { StorageReport } from '../../db/repo';
import './settings.css';

/** 配额条上的三段：已用 / 本 App 估算 / 剩余。 */
function QuotaBar({ used, quota }: { used: number; quota: number }) {
  const pct = quota > 0 ? Math.min(100, Math.round((used / quota) * 100)) : 0;
  return (
    <div className="quota">
      <div className="quota__track">
        {/* 宽度是运行时算出来的百分比，只能内联——已在 j13 的运行时变量台账里。 */}
        <div className="quota__fill" style={{ '--quota-pct': `${pct}%` } as React.CSSProperties} />
      </div>
      <div className="quota__legend">
        {humanSize(used)} / {humanSize(quota)}（{pct}%）
      </div>
    </div>
  );
}

export function StoragePage() {
  const [report, setReport] = useState<StorageReport | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await repo.storageReport();
        if (alive) setReport(r);
      } catch (e) {
        // 一个诊断页自己崩掉是最没道理的失败。说出来，别白屏。
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <>
      <SubNav title="存储空间" />
      <div className="page-body settings">
        {err && (
          <div className="settings__group">
            <div className="field">
              <span className="field__hint">读取失败：{err}</span>
            </div>
          </div>
        )}

        {!report && !err && (
          <div className="settings__group">
            <div className="field">
              <span className="field__hint">正在统计…</span>
            </div>
          </div>
        )}

        {report && (
          <>
            {report.quota > 0 && (
              <div className="settings__group">
                <div className="settings__group-title">设备配额</div>
                <div className="field">
                  <QuotaBar used={report.usage} quota={report.quota} />
                  <span className="field__hint">
                    浏览器/系统给这个站点的估算值。配额用满时写入会**静默失败**，
                    没有任何提示——所以这一栏比下面的明细更值得看一眼。
                  </span>
                </div>
              </div>
            )}

            <div className="settings__group">
              <div className="settings__group-title">媒体</div>
              {report.media.map((m) => (
                <div key={m.kind} className="settings__row settings__row--divided">
                  <span className="settings__label">{MEDIA_LABEL[m.kind] ?? m.kind}</span>
                  <span className="settings__value">
                    {m.count} 项 · {humanSize(m.bytes)}
                  </span>
                </div>
              ))}
              {report.media.length === 0 && (
                <div className="field">
                  <span className="field__hint">媒体库是空的。</span>
                </div>
              )}
            </div>

            <div className="settings__group">
              <div className="settings__group-title">数据表</div>
              {report.stores.map((s) => (
                <div key={s.name} className="settings__row settings__row--divided">
                  <span className="settings__label">{s.name}</span>
                  <span className="settings__value">{s.rows} 行</span>
                </div>
              ))}
            </div>

            <p className="settings__footnote">
              行数是精确的；字节数是媒体 blob 的实际大小之和，不含索引与 JSON 本身的
              开销，所以它一定**小于**上面的配额用量。
            </p>
          </>
        )}
      </div>
    </>
  );
}

/** 媒体分类的中文名。未知 kind 直接显示原值而不是藏起来。 */
const MEDIA_LABEL: Record<string, string> = {
  avatar: '头像',
  photo: '照片池',
  sticker: '表情',
  generated: 'AI 生成图',
  voice: '语音消息',
  tts: '语音缓存',
};
