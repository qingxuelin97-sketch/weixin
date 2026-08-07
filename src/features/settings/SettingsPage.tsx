import { useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { SubNav } from '../../components/SubNav';
import { isMessageSoundEnabled, setMessageSoundEnabled } from '../../lib/sound';
import { repo } from '../../db/repo';
import type { NsfwTierVM } from '../../data/types';
import './settings.css';

const NSFW_LABEL: Record<NsfwTierVM, string> = { off: '关闭', ambiguous: '暧昧', full: '全开' };

export function SettingsPage() {
  const navigate = useNavigate();
  const [sound, setSound] = useState(isMessageSoundEnabled());
  const [nsfw, setNsfw] = useState<NsfwTierVM>('off');
  const [providerCount, setProviderCount] = useState(0);

  useEffect(() => {
    void repo.getSetting<NsfwTierVM>('nsfwGlobalTier').then((t) => setNsfw(t ?? 'off'));
    void repo.getProviders().then((p) => setProviderCount(p.filter((x) => x.enabled).length));
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
          <div className="settings__row" onClick={toggleSound}>
            <span className="settings__label">新消息提示音</span>
            <span className={`switch${sound ? ' switch--on' : ''}`}>
              <span className="switch__knob" />
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
