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
import { isAsrReady } from '../../llm/asr';
import { isTtsAvailable } from '../../llm/tts';
import { getThemePref } from '../../lib/theme';
import { enterToSend, setEnterToSend } from '../../lib/chat-prefs';
import { FONT_SCALES, STANDARD_INDEX, getFontIndex } from '../../lib/font-scale';
import type { NsfwTierVM } from '../../data/types';
import { LinkRow, SwitchRow } from './rows';
import './settings.css';

/**
 * 设置树的四个分页 (M-K4)。
 *
 * 此前「设置」是一张一屏半长的功能清单：API、语音、提示音、看图、已读回执、锁屏通知、
 * 剧情、素材库、存储、世界书、自检、通知测试、原生增强、备份……中间还夹着解释段落。
 * 微信的设置是**分层**的——新消息通知 / 聊天 / 通用各自一页——找东西靠「它属于哪一类」
 * 而不是从头扫到尾。这里照那个结构拆，并把这个 App 独有的那一类（AI）单独立一页。
 * 每一项的读写逻辑原样从旧页搬来，只换了住处。
 */

const NSFW_LABEL: Record<NsfwTierVM, string> = { off: '关闭', ambiguous: '暧昧', full: '全开' };

/** AI 与模型：本 App 的「账号与安全」——没有它什么都不会动。 */
export function AiSettingsPage() {
  const [providerCount, setProviderCount] = useState(0);
  const [asrHint, setAsrHint] = useState('');
  const [ttsHint, setTtsHint] = useState('');
  const [nsfw, setNsfw] = useState<NsfwTierVM>('off');
  const [vision, setVision] = useState(true);

  useEffect(() => {
    void repo.getProviders().then((p) => setProviderCount(p.filter((x) => x.enabled).length));
    void repo.getSetting<NsfwTierVM>('nsfwGlobalTier').then((t) => setNsfw(t ?? 'off'));
    void isAsrReady()
      .then((ok) => setAsrHint(ok ? '已配置' : '未配置'))
      .catch(() => setAsrHint('未配置'));
    void isTtsAvailable()
      .then((ok) => setTtsHint(ok ? '已配置' : '未配置'))
      .catch(() => setTtsHint('未配置'));
    void visionEnabled().then(setVision).catch(() => {});
  }, []);

  const setTier = (t: NsfwTierVM) => {
    setNsfw(t);
    void repo.putSetting('nsfwGlobalTier', t);
  };
  const toggleVision = async () => {
    const next = !vision;
    setVision(next);
    await repo.putSetting(VISION_SETTING, next);
  };

  return (
    <>
      <SubNav title="AI 与模型" />
      <div className="page-body settings">
        <div className="settings__group">
          <LinkRow
            label="API 与模型"
            value={providerCount > 0 ? `${providerCount} 个已启用` : '未配置'}
            to="/settings/api"
          />
          <LinkRow label="语音输入（按住说话）" value={asrHint} to="/settings/asr" />
          <LinkRow label="语音合成（TA 的声音）" value={ttsHint} to="/settings/tts" />
          <SwitchRow label="让 TA 看得见图片" on={vision} onToggle={() => void toggleVision()} last />
        </div>
        <p className="settings__hint">
          开启后你发的照片会随消息一起交给模型，TA 能真的看懂内容而不只是知道「你发了张图」。
          需要所选模型支持看图；每张图的费用大约相当于一千字，所以只带最近几条里的图。
        </p>

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
        <p className="settings__hint">
          全局有效档 = min(此处, 每个智能体的许可位, 会话临时档)。全开档的上下文只会走「宽松通道」
          Provider，绝不发往国内官方端点。
        </p>

        <div className="settings__group">
          <LinkRow label="世界书" to="/settings/worldbook" />
          <LinkRow label="剧情模式" to="/story" last />
        </div>

        <div className="settings__group">
          <LinkRow label="提示词工作台" to="/settings/prompt-lab" />
          <LinkRow label="用量与预算" to="/settings/usage" last />
        </div>
      </div>
    </>
  );
}

/** 新消息通知：声音、振动、锁屏——微信把这三样放在同一页。 */
export function NotifySettingsPage() {
  const [sound, setSound] = useState(isMessageSoundEnabled());
  const [vibrate, setVibrate] = useState(isVibrateEnabled());
  const [notifyOn, setNotifyOn] = useState<boolean | null>(null);

  useEffect(() => {
    void repo.getSetting<boolean>('notifyGranted').then((v) => setNotifyOn(v ?? false));
  }, []);

  const toggleSound = () => {
    const next = !sound;
    setSound(next);
    setMessageSoundEnabled(next);
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
      <SubNav title="新消息通知" />
      <div className="page-body settings">
        <div className="settings__group">
          <SwitchRow label="锁屏通知" on={Boolean(notifyOn)} onToggle={() => void toggleNotify()} last />
        </div>
        <p className="settings__hint">关闭后，App 不在前台时她发来的消息、转账与来电都不会提醒你。</p>
        <div className="settings__group">
          <SwitchRow label="声音" on={sound} onToggle={toggleSound} />
          <SwitchRow label="振动" on={vibrate} onToggle={toggleVibrate} last />
        </div>
        <p className="settings__hint">
          提示音默认使用内置合成音。想要微信原声：把你自己提取的 message.mp3 放到应用的 sounds
          目录（Web 端为 public/sounds/message.mp3），App 会自动优先使用。
        </p>
        <div className="settings__group">
          <LinkRow label="后台通知测试" to="/settings/notify-test" last />
        </div>
      </div>
    </>
  );
}

/** 聊天：背景、输入习惯与拟真项。 */
export function ChatSettingsPage() {
  const [enter, setEnter] = useState(enterToSend());
  // 已读回执 (M-I16): WeChat has none, so it ships OFF as an opt-in拟真项.
  const [readReceipts, setReadReceipts] = useState(false);
  useEffect(() => {
    void repo
      .getSetting<boolean>('readReceipts')
      .then((v) => setReadReceipts(Boolean(v)))
      .catch(() => {});
  }, []);
  const toggleEnter = () => {
    const next = !enter;
    setEnter(next);
    setEnterToSend(next);
  };
  const toggleReadReceipts = () => {
    const next = !readReceipts;
    setReadReceipts(next);
    void repo.putSetting('readReceipts', next);
  };

  return (
    <>
      <SubNav title="聊天" />
      <div className="page-body settings">
        <div className="settings__group">
          <LinkRow label="聊天背景" to="/settings/chat-bg" last />
        </div>
        <div className="settings__group">
          <SwitchRow label="回车键发送消息" on={enter} onToggle={toggleEnter} last />
        </div>
        <p className="settings__hint">关闭后回车键换行，只能点「发送」把消息发出去。</p>
        <div className="settings__group">
          <SwitchRow label="已读回执" on={readReceipts} onToggle={toggleReadReceipts} last />
        </div>
        <p className="settings__hint">
          微信本体没有已读回执——这是本应用的可选拟真项：开启后，你发出的最后一条消息在 TA
          看过（开始回复）后会标一个小小的「已读」。默认关闭。
        </p>
      </div>
    </>
  );
}

const THEME_LABEL = { system: '跟随系统', light: '普通模式', dark: '深色模式' } as const;

/** 「字体大小」那一行的值：标准档写「标准」，其余写倍数——八档没有微信那么多好名字。 */
function fontLabel(i: number): string {
  if (i === STANDARD_INDEX) return '标准';
  return i < STANDARD_INDEX ? '小' : `大 ${FONT_SCALES[i]}×`;
}

/** 通用：显示与存储。 */
export function GeneralSettingsPage() {
  return (
    <>
      <SubNav title="通用" />
      <div className="page-body settings">
        <div className="settings__group">
          <LinkRow label="深色模式" value={THEME_LABEL[getThemePref()]} to="/settings/dark-mode" />
          <LinkRow label="字体大小" value={fontLabel(getFontIndex())} to="/settings/font-size" last />
        </div>
        <div className="settings__group">
          <LinkRow label="素材库（头像与照片）" to="/settings/media" />
          <LinkRow label="存储空间" to="/settings/storage" last />
        </div>
      </div>
    </>
  );
}
