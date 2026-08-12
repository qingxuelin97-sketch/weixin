import { useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { SubNav } from '../../components/SubNav';
import {
  isMessageSoundEnabled,
  setMessageSoundEnabled,
  isVibrateEnabled,
  setVibrateEnabled,
} from '../../lib/sound';
import { requestPermission } from '../../lib/notify';
import { repo } from '../../db/repo';
import { visionEnabled, VISION_SETTING } from '../../ai/vision-context';
import type { NsfwTierVM } from '../../data/types';
import './settings.css';

const NSFW_LABEL: Record<NsfwTierVM, string> = { off: '关闭', ambiguous: '暧昧', full: '全开' };

export function SettingsPage() {
  const navigate = useNavigate();
  const [sound, setSound] = useState(isMessageSoundEnabled());
  const [vibrate, setVibrate] = useState(isVibrateEnabled());
  const [nsfw, setNsfw] = useState<NsfwTierVM>('off');
  const [providerCount, setProviderCount] = useState(0);
  const [notifyOn, setNotifyOn] = useState<boolean | null>(null);
  const [backupHint, setBackupHint] = useState('');

  useEffect(() => {
    void repo.getSetting<NsfwTierVM>('nsfwGlobalTier').then((t) => setNsfw(t ?? 'off'));
    void repo.getProviders().then((p) => setProviderCount(p.filter((x) => x.enabled).length));
    void repo.getSetting<boolean>('notifyGranted').then((v) => setNotifyOn(v ?? false));
    // Freshness nudge: data is the only asset this app has, and .aiwx is its
    // only escape hatch — surface staleness where the user will see it.
    void repo.getSetting<number>('lastBackupAt').then((t) => {
      if (!t) return setBackupHint('从未备份');
      const days = Math.floor((Date.now() - t) / 86_400_000);
      setBackupHint(days === 0 ? '今天已备份' : days > 7 ? `${days} 天前，该备份了` : `${days} 天前`);
    });
  }, []);

  const setTier = (t: NsfwTierVM) => {
    setNsfw(t);
    void repo.putSetting('nsfwGlobalTier', t);
  };

  const toggleSound = () => {
    const next = !sound;
    setSound(next);
    setMessageSoundEnabled(next);
  };

  const [vision, setVision] = useState(true);
  useEffect(() => {
    void visionEnabled().then(setVision).catch(() => {});
  }, []);
  const toggleVision = async () => {
    const next = !vision;
    setVision(next);
    await repo.putSetting(VISION_SETTING, next);
  };

  const toggleVibrate = () => {
    const next = !vibrate;
    setVibrate(next);
    setVibrateEnabled(next);
  };

  // Turning the row on triggers the OS dialog — the one call that was written
  // in M4 but had zero callers, leaving Android 13+ notifications fully inert.
  const toggleNotify = async () => {
    if (notifyOn) {
      setNotifyOn(false);
      await repo.putSetting('notifyGranted', false);
      return;
    }
    const granted = await requestPermission();
    setNotifyOn(granted);
    await repo.putSetting('notifyGranted', granted);
    await repo.putSetting('notifyAsked', true);
  };

  return (
    <>
      <SubNav title="设置" />
      <div className="page-body settings">
        <div className="settings__group">
          <div className="settings__row settings__row--divided" onClick={() => navigate('/settings/api')}>
            <span className="settings__label">API 与模型</span>
            <span className="settings__value">{providerCount > 0 ? `${providerCount} 个已启用` : '未配置'}</span>
            <span className="settings__chevron">›</span>
          </div>
          <div className="settings__row settings__row--divided" onClick={toggleSound}>
            <span className="settings__label">新消息提示音</span>
            <span className={`switch${sound ? ' switch--on' : ''}`}>
              <span className="switch__knob" />
            </span>
          </div>
          <div className="settings__row settings__row--divided" onClick={toggleVibrate}>
            <span className="settings__label">新消息振动</span>
            <span className={`switch${vibrate ? ' switch--on' : ''}`}>
              <span className="switch__knob" />
            </span>
          </div>
          <div className="settings__row settings__row--divided" onClick={() => void toggleVision()}>
            <span className="settings__label">让 TA 看得见图片</span>
            <span className={`switch${vision ? ' switch--on' : ''}`}>
              <span className="switch__knob" />
            </span>
          </div>
          <p className="settings__hint">
            开启后你发的照片会随消息一起交给模型，TA 能真的看懂内容而不只是知道「你发了张图」。
            需要所选模型支持看图；每张图的费用大约相当于一千字，所以只带最近几条里的图。
          </p>
          <div
            className="settings__row settings__row--divided"
            onClick={() => void toggleNotify()}
          >
            <span className="settings__label">锁屏通知</span>
            <span className={`switch${notifyOn ? ' switch--on' : ''}`}>
              <span className="switch__knob" />
            </span>
          </div>
          <div
            className="settings__row settings__row--divided"
            onClick={() => navigate('/story')}
          >
            <span className="settings__label">剧情模式</span>
            <span className="settings__chevron">›</span>
          </div>
          <div
            className="settings__row settings__row--divided"
            onClick={() => navigate('/settings/media')}
          >
            <span className="settings__label">素材库（头像与照片）</span>
            <span className="settings__chevron">›</span>
          </div>
          <div
            className="settings__row settings__row--divided"
            onClick={() => navigate('/settings/env')}
          >
            <span className="settings__label">环境自检与日志</span>
            <span className="settings__chevron">›</span>
          </div>
          <div
            className="settings__row settings__row--divided"
            onClick={() => navigate('/settings/notify-test')}
          >
            <span className="settings__label">后台通知测试</span>
            <span className="settings__chevron">›</span>
          </div>
          <div className="settings__row" onClick={() => navigate('/settings/backup')}>
            <span className="settings__label">备份与恢复</span>
            <span className="settings__value">{backupHint}</span>
            <span className="settings__chevron">›</span>
          </div>
        </div>

        <div className="settings__group">
          <div className="field">
            <span className="field__hint">
              提示音默认使用内置合成音。想要微信原声：把你自己提取的 message.mp3 放到应用的
              sounds 目录（Web 端为 public/sounds/message.mp3），App 会自动优先使用。
            </span>
          </div>
        </div>

        <div className="settings__group">
          <div className="settings__group-title">内容分级（NSFW）</div>
          <div className="segmented">
            {(['off', 'ambiguous', 'full'] as NsfwTierVM[]).map((t) => (
              <div
                key={t}
                className={`segmented__item${nsfw === t ? ' segmented__item--active' : ''}`}
                onClick={() => setTier(t)}
              >
                {NSFW_LABEL[t]}
              </div>
            ))}
          </div>
          <div className="field">
            <span className="field__hint">
              全局有效档 = min(此处, 每个智能体的许可位, 会话临时档)。全开档的上下文只会走"宽松通道"
              Provider，绝不发往国内官方端点。
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
