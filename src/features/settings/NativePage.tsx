/**
 * 原生增强（M-I10）：悬浮气泡 / 通知直接回复 / 来电全屏 / 桌面小组件的
 * 开关、权限入口与自测按钮。所有能力仅在 APK 内生效；Web 上整页保留但降级为
 * 说明书——保持路由可达（golden 可截、真机文档同一入口），只是按钮不可用。
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SubNav } from '../../components/SubNav';
import { repo } from '../../db/repo';
import { useAppStore } from '../../store/appStore';
import {
  isNative,
  overlayGranted,
  requestOverlay,
  showBubble,
  notifyMessage,
  notifyCall,
} from '../../native/bridge';
import { syncWidget } from '../../native/widget-sync';
import { msgNotifId, callNotifId } from '../../native/background-notify';
import './settings.css';

export function NativePage() {
  const navigate = useNavigate();
  const conversations = useAppStore((s) => s.conversations);
  const contactById = useAppStore((s) => s.contactById);

  const [bubbleOn, setBubbleOn] = useState(true);
  const [callOn, setCallOn] = useState(true);
  const [overlayOk, setOverlayOk] = useState<boolean | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const native = isNative();

  useEffect(() => {
    void repo.getSetting<boolean>('nativeBubble').then((v) => setBubbleOn(v ?? true));
    void repo.getSetting<boolean>('nativeIncomingCall').then((v) => setCallOn(v ?? true));
    if (native) void overlayGranted().then(setOverlayOk);
  }, [native]);

  const toggleBubble = () => {
    const next = !bubbleOn;
    setBubbleOn(next);
    void repo.putSetting('nativeBubble', next);
  };
  const toggleCall = () => {
    const next = !callOn;
    setCallOn(next);
    void repo.putSetting('nativeIncomingCall', next);
  };

  // The demo target: the first visible single chat (what a real alert would use).
  const demoConv = conversations.find((c) => !c.isHidden && c.type === 'single');
  const demoName = demoConv?.peerId
    ? (contactById(demoConv.peerId)?.remark ?? contactById(demoConv.peerId)?.name ?? '微信')
    : '微信';

  const testBubble = async () => {
    if (!demoConv) return setStatus('还没有可用的单聊会话');
    if (!(await overlayGranted())) {
      setOverlayOk(false);
      return setStatus('悬浮窗权限未授予——先点上面的「去授权」');
    }
    const ok = await showBubble(demoConv.id, demoName, '这是一条悬浮气泡测试，点我进入会话');
    setStatus(ok ? '气泡已弹出（点它可直达会话）' : '气泡弹出失败');
  };

  const testNotify = async () => {
    if (!demoConv) return setStatus('还没有可用的单聊会话');
    const ok = await notifyMessage(
      demoConv.id,
      demoName,
      '这是一条测试通知——在通知栏里直接输入回复试试',
      msgNotifId(demoConv.id),
    );
    setStatus(ok ? '已发出。切到后台看通知栏，长按或展开可直接回复' : '通知未发出（检查通知权限）');
  };

  const testCall = async () => {
    if (!demoConv) return setStatus('还没有可用的单聊会话');
    const ok = await notifyCall(demoConv.id, demoName, callNotifId(demoConv.id));
    setStatus(ok ? '来电通知已发出。锁屏状态下会全屏弹出' : '通知未发出（检查通知权限）');
  };

  const refreshWidget = async () => {
    await syncWidget();
    setStatus('小组件数据已刷新（先在桌面长按空白处添加「微信」小组件）');
  };

  return (
    <>
      <SubNav title="原生增强" />
      <div className="page-body settings">
        {!native && (
          <div className="settings__group">
            <div className="field">
              <span className="field__hint">
                当前在浏览器里运行——本页全部能力（悬浮气泡、通知直接回复、来电全屏、桌面
                小组件）只在 Android APK 内生效。以下开关会保存，装包后即按此生效。
              </span>
            </div>
          </div>
        )}

        <div className="settings__group">
          <div className="settings__group-title">消息悬浮气泡</div>
          <div className="settings__row settings__row--divided" onClick={toggleBubble}>
            <span className="settings__label">新消息弹悬浮气泡</span>
            <span className={`switch${bubbleOn ? ' switch--on' : ''}`}>
              <span className="switch__knob" />
            </span>
          </div>
          <div
            className="settings__row settings__row--divided"
            onClick={() => {
              void requestOverlay();
              setStatus('从系统设置授权后回来，状态会自动刷新');
            }}
          >
            <span className="settings__label">悬浮窗权限</span>
            <span className="settings__value">
              {overlayOk == null ? '—' : overlayOk ? '已授权' : '未授权，点此前往'}
            </span>
            <span className="settings__chevron">›</span>
          </div>
          <div className="settings__row" onClick={() => void testBubble()}>
            <span className="settings__label">弹一条测试气泡</span>
            <span className="settings__chevron">›</span>
          </div>
        </div>

        <div className="settings__group">
          <div className="settings__group-title">通知与来电</div>
          <div className="settings__row settings__row--divided" onClick={() => void testNotify()}>
            <span className="settings__label">测试「通知栏直接回复」</span>
            <span className="settings__chevron">›</span>
          </div>
          <div className="settings__row settings__row--divided" onClick={toggleCall}>
            <span className="settings__label">她们偶尔来电（全屏）</span>
            <span className={`switch${callOn ? ' switch--on' : ''}`}>
              <span className="switch__knob" />
            </span>
          </div>
          <div className="settings__row" onClick={() => void testCall()}>
            <span className="settings__label">模拟一次来电</span>
            <span className="settings__chevron">›</span>
          </div>
        </div>

        <div className="settings__group">
          <div className="settings__group-title">桌面小组件</div>
          <div className="field">
            <span className="field__hint">
              桌面长按空白处 → 小组件 → 找「微信 · 未读与最新消息」。小组件在每次打开/离开
              应用时刷新，点按直达最新会话。
            </span>
          </div>
          <div className="settings__row" onClick={() => void refreshWidget()}>
            <span className="settings__label">立即刷新小组件数据</span>
            <span className="settings__chevron">›</span>
          </div>
        </div>

        <div className="settings__group">
          <div className="settings__row" onClick={() => navigate('/settings/battery')}>
            <span className="settings__label">电池白名单向导</span>
            <span className="settings__value">防止后台被杀</span>
            <span className="settings__chevron">›</span>
          </div>
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
