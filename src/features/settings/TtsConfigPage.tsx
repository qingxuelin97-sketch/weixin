/**
 * TTS source config (M-J3) — 设置 → 语音合成.
 *
 * Until this page existed, TTS was hard-chained to「chat 列表里第一个 enabled
 * 的 MiniMax 槽位」(tts.ts): disabling MiniMax for chat silently struck every
 * persona mute, and `ttsModel` had a reader but no writer anywhere in the UI.
 * Shaped like AsrConfigPage: one source, explicit modes, loud failures, and a
 * full-path test button that synthesizes a real (tiny) line.
 */
import { useEffect, useState } from 'react';
import { SubNav } from '../../components/SubNav';
import {
  DEFAULT_TTS_BASE,
  DEFAULT_TTS_MODEL,
  TTS_STANDALONE_ALIAS,
  getTtsConfig,
  saveTtsConfig,
  clearTtsConfig,
  resolveTtsSource,
  synthesize,
} from '../../llm/tts';
import { withDeadline } from '../../llm/service';
import { repo } from '../../db/repo';
import { setSecret, hasSecret } from '../../lib/keystore';
import { logError } from '../../lib/errlog';
import type { ProviderVM } from '../../data/types';
import './settings.css';

type Mode = 'auto' | 'provider' | 'standalone';

export function TtsConfigPage() {
  const [mode, setMode] = useState<Mode>('auto');
  const [providerId, setProviderId] = useState<string>('');
  const [baseUrl, setBaseUrl] = useState(DEFAULT_TTS_BASE);
  const [model, setModel] = useState(DEFAULT_TTS_MODEL);
  const [slots, setSlots] = useState<ProviderVM[]>([]);
  const [status, setStatus] = useState('');
  const [keyInput, setKeyInput] = useState('');
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [, setKeyRev] = useState(0);

  const refreshStatus = async () => {
    const src = await resolveTtsSource();
    setStatus(src ? `当前来源：${src.label}` : '当前没有可用来源——语音消息会静默降级为无声');
  };

  useEffect(() => {
    void (async () => {
      try {
        const [cfg, providers, m] = await Promise.all([
          getTtsConfig(),
          repo.getProviders(),
          repo.getSetting<string>('ttsModel'),
        ]);
        // MiniMax-kind slots first: /t2a_v2 is a MiniMax shape. Custom slots
        // are listed too — a self-hosted gateway proxying it is legitimate.
        setSlots(providers.filter((p) => p.kind === 'minimax' || p.kind === 'custom'));
        if (m) setModel(m);
        if (cfg?.source === 'provider') {
          setMode('provider');
          setProviderId(cfg.providerId ?? '');
        } else if (cfg?.source === 'standalone') {
          setMode('standalone');
          setBaseUrl(cfg.baseUrl || DEFAULT_TTS_BASE);
        }
        await refreshStatus();
      } catch (e) {
        logError('ttsConfig.load', e);
        setTestMsg({ ok: false, text: `读取配置失败：${e instanceof Error ? e.message : String(e)}` });
      }
    })();
  }, []);

  /** Every mutator: a failed write must never look like success (ApiConfig rule). */
  const guard = async (scope: string, fn: () => Promise<void>) => {
    try {
      await fn();
      await refreshStatus();
    } catch (e) {
      logError(`ttsConfig.${scope}`, e);
      setTestMsg({ ok: false, text: `操作失败：${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const pickMode = (next: Mode) =>
    guard('mode', async () => {
      setMode(next);
      setTestMsg(null);
      if (next === 'auto') await clearTtsConfig();
      else if (next === 'standalone') await saveTtsConfig({ source: 'standalone', baseUrl });
      else if (providerId) await saveTtsConfig({ source: 'provider', providerId });
      // provider mode with nothing picked yet: saved on first pick below.
    });

  const pickSlot = (id: string) =>
    guard('slot', async () => {
      setProviderId(id);
      await saveTtsConfig({ source: 'provider', providerId: id });
    });

  const persistStandalone = () =>
    guard('standalone', () => saveTtsConfig({ source: 'standalone', baseUrl }));

  const persistModel = () =>
    guard('model', async () => {
      await repo.putSetting('ttsModel', model.trim() || DEFAULT_TTS_MODEL);
    });

  const saveKey = () =>
    guard('saveKey', async () => {
      if (!keyInput.trim()) return;
      await setSecret(TTS_STANDALONE_ALIAS, keyInput.trim());
      setKeyInput('');
      setKeyRev((n) => n + 1);
      setTestMsg({ ok: true, text: '密钥已加密保存到本机' });
    });

  const runTest = async () => {
    setTesting(true);
    setTestMsg(null);
    try {
      // The real path, a real (tiny) synthesis — the only honest probe.
      const t0 = performance.now();
      const res = await withDeadline(synthesize({ text: '你好呀' }), 30_000);
      const ms = Math.round(performance.now() - t0);
      setTestMsg({
        ok: true,
        text: `合成通了（${ms}ms，音频 ${Math.round(res.durationMs / 100) / 10}s）`,
      });
    } catch (e) {
      setTestMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      <SubNav title="语音合成（TTS）" />
      <div className="page-body settings">
        <div className="settings__group">
          <div className="settings__group-title">语音来源</div>
          <div className="segmented">
            {(
              [
                ['auto', '自动'],
                ['provider', '绑定聊天槽位'],
                ['standalone', '独立密钥'],
              ] as Array<[Mode, string]>
            ).map(([m, label]) => (
              <div
                key={m}
                className={`segmented__item${mode === m ? ' segmented__item--active' : ''}`}
                onClick={() => void pickMode(m)}
              >
                {label}
              </div>
            ))}
          </div>
          <p className="settings__hint">
            {status}。自动 = 用任何一个已存密钥的 MiniMax 槽位（即使它没启用聊天——
            关掉 MiniMax 聊天不再让语音失声）；绑定 = 明确指定用哪个槽位的密钥；
            独立密钥 = TTS 用自己的账号，与聊天配置彻底解耦。
          </p>

          {mode === 'provider' && (
            <>
              {slots.length === 0 && (
                <p className="settings__hint">
                  还没有可绑定的槽位（MiniMax 或自定义）——先去「API 与模型」添加，或改用独立密钥。
                </p>
              )}
              {slots.map((p, i) => (
                <div
                  key={p.id}
                  className={`settings__row${i < slots.length - 1 ? ' settings__row--divided' : ''}`}
                  onClick={() => void pickSlot(p.id)}
                >
                  <span className="settings__label">{p.label}</span>
                  <span className="settings__value">
                    {providerId === p.id ? '✓ 使用中' : hasSecret(p.keyAlias) ? '已有密钥' : '无密钥'}
                  </span>
                </div>
              ))}
            </>
          )}

          {mode === 'standalone' && (
            <>
              <div className="field field--divided">
                <span className="field__label">Base URL</span>
                <input
                  className="field__input"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  onBlur={() => void persistStandalone()}
                  placeholder={DEFAULT_TTS_BASE}
                  spellCheck={false}
                />
                <span className="field__hint">自动追加 /t2a_v2（MiniMax 语音接口形状）</span>
              </div>
              <div className="field">
                <span className="field__label">API Key（加密存本机，不入库、不上传）</span>
                <input
                  className="field__input"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  placeholder={hasSecret(TTS_STANDALONE_ALIAS) ? '已保存，输入可覆盖' : 'sk-...'}
                  type="password"
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>
              <button className="btn-primary" onClick={() => void saveKey()} disabled={!keyInput.trim()}>
                保存密钥
              </button>
            </>
          )}
        </div>

        <div className="settings__group">
          <div className="settings__group-title">合成参数</div>
          <div className="field">
            <span className="field__label">语音模型</span>
            <input
              className="field__input"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              onBlur={() => void persistModel()}
              placeholder={DEFAULT_TTS_MODEL}
              spellCheck={false}
            />
            <span className="field__hint">
              MiniMax 每隔几个月更新语音模型 id（如 speech-02-hd / speech-2.5-hd-preview）——
              报错时改成官网现行 id。每个角色的音色在人设编辑页里单独选。
            </span>
          </div>
          <button className="btn-ghost" onClick={() => void runTest()} disabled={testing}>
            {testing ? '测试中…' : '测试合成（说一句「你好呀」）'}
          </button>
          {testMsg && (
            <div className={`test-result${testMsg.ok ? ' test-result--ok' : ''}`}>{testMsg.text}</div>
          )}
        </div>

        <div className="settings__group">
          <div className="field">
            <span className="field__hint">
              全开档提醒：露骨文本永远不会直接送去合成——会先经宽松通道降敏改写，失败则自动
              转成文字气泡（specs/nsfw.md 铁律）。合成结果按文本缓存，重复播放不重复计费。
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
