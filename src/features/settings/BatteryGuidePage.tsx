/**
 * 电池白名单向导（M-I10）。
 *
 * 本 App 的「离线世界」依赖回前台补算，但国产 ROM 会把后台应用连同它的
 * AlarmManager 通知一起杀掉——预调度通知不到、切回来冷启动，全都指向同一个
 * 病根。此页做三件事：① 检测当前是否已在系统电池优化白名单；② 一键发起
 * 标准豁免请求；③ 按厂商（Build.MANUFACTURER）给出对应 ROM 的后台管理页
 * 深跳 + 人话步骤——很多 ROM 的开关根本不在标准页里。
 *
 * 纯逻辑（厂商识别、步骤文案）在 src/native/battery.ts，单测覆盖；
 * 原生 Intent 阶梯在 AiwxNativePlugin.openBatterySettings。
 */
import { useEffect, useState } from 'react';
import { SubNav } from '../../components/SubNav';
import {
  isNative,
  deviceInfo,
  batteryIgnored,
  requestBatteryIgnore,
  openBatterySettings,
} from '../../native/bridge';
import { detectVendor, guideFor, type Vendor } from '../../native/battery';
import './settings.css';

export function BatteryGuidePage() {
  const native = isNative();
  const [vendor, setVendor] = useState<Vendor>('generic');
  const [manufacturer, setManufacturer] = useState('');
  const [ignored, setIgnored] = useState<boolean | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const refresh = async () => {
    if (!native) return;
    try {
      const info = await deviceInfo();
      setManufacturer(info.manufacturer);
      setVendor(detectVendor(info.manufacturer));
      setIgnored(await batteryIgnored());
    } catch {
      /* leave defaults */
    }
  };

  useEffect(() => {
    void refresh();
    // Coming back from a system settings page re-focuses the WebView — the
    // cheapest correct moment to re-read the whitelist state.
    const onVis = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const guide = guideFor(vendor);

  const requestExemption = async () => {
    const launched = await requestBatteryIgnore();
    setStatus(
      launched
        ? '在系统弹窗里选「允许」，回来后此页状态会自动刷新'
        : '系统未响应豁免请求，试试下面的厂商设置页',
    );
  };

  const openVendorPage = async () => {
    const opened = await openBatterySettings(vendor);
    setStatus(
      opened === 'none'
        ? '没找到可打开的设置页（少见）——请手动进系统设置搜「电池优化」'
        : opened === 'app_details'
          ? '已打开本应用详情页——从「电池」或「耗电管理」进入按下面步骤操作'
          : '已打开对应设置页，按下面的步骤操作',
    );
  };

  return (
    <>
      <SubNav title="电池白名单向导" />
      <div className="page-body settings">
        {!native && (
          <div className="settings__group">
            <div className="field">
              <span className="field__hint">
                当前在浏览器里运行——电池白名单只对 Android APK 有意义。装包后从
                设置 → 原生增强 进入本页操作。
              </span>
            </div>
          </div>
        )}

        <div className="settings__group">
          <div className="settings__group-title">为什么需要它</div>
          <div className="field">
            <span className="field__hint">
              不加入白名单，国产 ROM 会在锁屏几分钟后杀掉本应用：预约好的锁屏通知不再送达、
              悬浮气泡与来电全屏失效、每次都是冷启动。加入后，这些能力才能稳定工作。
            </span>
          </div>
        </div>

        <div className="settings__group">
          <div className="settings__group-title">当前状态</div>
          <div className="settings__row settings__row--divided">
            <span className="settings__label">系统电池优化豁免</span>
            <span className="settings__value">
              {ignored == null ? '未知（仅 APK 内可检测）' : ignored ? '已豁免 ✓' : '未豁免'}
            </span>
          </div>
          <div className="settings__row">
            <span className="settings__label">检测到的厂商</span>
            <span className="settings__value">{guide.label}{manufacturer ? `（${manufacturer}）` : ''}</span>
          </div>
        </div>

        <div className="settings__group">
          <div className="settings__group-title">第一步 · 标准豁免</div>
          <div className="settings__row" onClick={() => void requestExemption()}>
            <span className="settings__label">请求加入电池优化白名单</span>
            <span className="settings__chevron">›</span>
          </div>
        </div>

        <div className="settings__group">
          <div className="settings__group-title">第二步 · {guide.label} 专属设置</div>
          <div className="settings__row settings__row--divided" onClick={() => void openVendorPage()}>
            <span className="settings__label">打开厂商后台管理页</span>
            <span className="settings__chevron">›</span>
          </div>
          {guide.steps.map((step, i) => (
            <div className="settings__row settings__row--divided" key={step}>
              <span className="settings__value">{i + 1}.</span>
              <span className="settings__label">{step}</span>
            </div>
          ))}
        </div>

        {status && (
          <div className="settings__group">
            <div className="field">
              <span className="field__hint">{status}</span>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
