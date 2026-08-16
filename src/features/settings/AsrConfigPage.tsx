/**
 * ASR provider config (M-I9) — 设置 → 语音输入.
 *
 * Deliberately shaped like ApiConfigPage: preset rows to add, an editing card
 * with endpoint/model/key fields, a full-path test button, loud failures. One
 * ASR slot (unlike chat's many): hold-to-talk has exactly one route.
 *
 * The key follows constitution rule #2 to the letter: it goes through
 * `setSecret` under the config's alias; the settings row stores the alias.
 */
import { useEffect, useState } from 'react';
import { SubNav } from '../../components/SubNav';
import { Switch } from '../../components/Switch';
import {
  ASR_PRESETS,
  asrPresetToConfig,
  getAsrConfig,
  saveAsrConfig,
  clearAsrConfig,
  testAsrConnection,
  type AsrConfigVM,
} from '../../llm/asr';
import { isRecordingSupported, pickAudioMime } from '../../lib/recorder';
import { withDeadline } from '../../llm/service';
import { setSecret, hasSecret, deleteSecret } from '../../lib/keystore';
import { showConfirm } from '../../components/dialog';
import { logError } from '../../lib/errlog';
import './settings.css';

export function AsrConfigPage() {
  const [cfg, setCfg] = useState<AsrConfigVM | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [keyInput, setKeyInput] = useState('');
  const [testing, setTesting] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // hasSecret is sync-read; bump this to re-render after key writes.
  const [, setKeyRev] = useState(0);

  useEffect(() => {
    void getAsrConfig()
      .then((c) => setCfg(c))
      .catch((e) => {
        logError('asrConfig.load', e);
        setTestMsg({ ok: false, text: `读取配置失败：${e instanceof Error ? e.message : String(e)}` });
      })
      .finally(() => setLoaded(true));
  }, []);

  /** Every mutator: a failed write must never look like success (ApiConfig rule). */
  const guard = async (scope: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      logError(`asrConfig.${scope}`, e);
      setTestMsg({ ok: false, text: `操作失败：${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const pickPreset = (kind: string) =>
    guard('pickPreset', async () => {
      const next = asrPresetToConfig(kind);
      await saveAsrConfig(next);
      setCfg(next);
      setKeyInput('');
      setTestMsg(null);
    });

  const patch = (p: Partial<AsrConfigVM>) => {
    if (!cfg) return;
    setCfg({ ...cfg, ...p });
  };
  const persist = () => {
    if (cfg) void guard('persist', () => saveAsrConfig(cfg));
  };

  const saveKey = () =>
    guard('saveKey', async () => {
      if (!cfg || !keyInput.trim()) return;
      await setSecret(cfg.keyAlias, keyInput.trim());
      setKeyInput('');
      setKeyRev((n) => n + 1);
      setTestMsg({ ok: true, text: '密钥已加密保存到本机' });
    });

  const runTest = async () => {
    if (!cfg) return;
    setTesting(true);
    setTestMsg(null);
    try {
      await saveAsrConfig(cfg); // test what will actually be used
      // Belt-and-braces deadline: the button must recover even if a layer hangs.
      const r = await withDeadline(testAsrConnection(cfg), 25_000);
      setTestMsg({ ok: r.ok, text: r.message });
    } catch (e) {
      setTestMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };

  const removeConfig = () =>
    guard('remove', async () => {
      if (!cfg) return;
      const ok = await showConfirm({
        title: '清除语音识别配置',
        body: '将删除端点配置与本机保存的密钥，按住说话会恢复为未配置提示。',
        confirmText: '清除',
        danger: true,
      });
      if (!ok) return;
      deleteSecret(cfg.keyAlias);
      await clearAsrConfig();
      setCfg(null);
      setKeyInput('');
      setTestMsg(null);
    });

  const recordable = isRecordingSupported();

  return (
    <>
      <SubNav title="语音输入" />
      <div className="page-body settings">
        {!recordable && (
          <div className="settings__group">
            <div className="field">
              <span className="field__hint">
                ⚠️ 当前环境不支持录音（缺少 MediaRecorder 或麦克风权限接口）。配置会保存，
                但按住说话要到支持的环境（真机 App）里才能用。
              </span>
            </div>
          </div>
        )}

        {loaded && !cfg && (
          <div className="settings__group">
            <div className="settings__group-title">选择识别服务（OpenAI 兼容 /audio/transcriptions）</div>
            {Object.values(ASR_PRESETS).map((p) => (
              <div
                key={p.kind}
                className="settings__row settings__row--divided"
                onClick={() => pickPreset(p.kind)}
              >
                <span className="settings__label">{p.label}</span>
                <span className="settings__chevron">＋</span>
              </div>
            ))}
            <div className="settings__row" onClick={() => pickPreset('custom')}>
              <span className="settings__label">自定义（任意 OpenAI 兼容端点）</span>
              <span className="settings__chevron">＋</span>
            </div>
          </div>
        )}

        {cfg && (
          <>
            <div className="settings__group">
              <div className="settings__group-title">配置：{cfg.label}</div>
              <div className="field field--divided">
                <span className="field__label">Base URL</span>
                <input
                  className="field__input"
                  value={cfg.baseUrl}
                  onChange={(e) => patch({ baseUrl: e.target.value })}
                  onBlur={persist}
                  placeholder="https://api.siliconflow.cn/v1"
                  spellCheck={false}
                />
                <span className="field__hint">自动追加 /audio/transcriptions；一般以 /v1 结尾</span>
              </div>
              <div className="field field--divided">
                <span className="field__label">模型</span>
                <input
                  className="field__input"
                  value={cfg.model}
                  onChange={(e) => patch({ model: e.target.value })}
                  onBlur={persist}
                  placeholder={ASR_PRESETS[cfg.kind]?.models[0] ?? 'whisper-1'}
                  spellCheck={false}
                />
                {ASR_PRESETS[cfg.kind]?.note && (
                  <span className="field__hint">{ASR_PRESETS[cfg.kind].note}</span>
                )}
              </div>
              <div className="field field--divided">
                <span className="field__label">语言提示（可留空自动检测）</span>
                <input
                  className="field__input"
                  value={cfg.language ?? ''}
                  onChange={(e) => patch({ language: e.target.value.trim() })}
                  onBlur={persist}
                  placeholder="zh"
                  spellCheck={false}
                />
              </div>
              {/* 铁律 6 的入站面 (M-I18)。默认关：一个没被声明过的端点，
                  不该在全开档下收到用户说出口的原话。 */}
              <div className="settings__row settings__row--divided">
                <span className="settings__label">允许上传全开档语音</span>
                <Switch
                  on={Boolean(cfg.nsfwSafe)}
                  onChange={(next) => {
                    patch({ nsfwSafe: next });
                    void persist();
                  }}
                  label="允许上传全开档语音"
                />
              </div>
              <p className="settings__hint">
                关闭时（默认），全开档会话里的「按住说话」不会把录音传给这家转写服务，
                会提示你改用打字。只有你确认这家端点适合承载这类内容时才打开——
                与选择宽松通道的 LLM 是同一个判断。
              </p>
              <div className="field">
                <span className="field__label">API Key（加密存本机，不入库、不上传）</span>
                <input
                  className="field__input"
                  value={keyInput}
                  onChange={(e) => setKeyInput(e.target.value)}
                  placeholder={hasSecret(cfg.keyAlias) ? '已保存，输入可覆盖' : 'sk-...'}
                  type="password"
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>
              <button className="btn-primary" onClick={() => void saveKey()} disabled={!keyInput.trim()}>
                保存密钥
              </button>
              <button className="btn-ghost" onClick={() => void runTest()} disabled={testing}>
                {testing ? '测试中…' : '测试识别（发送一段静音样本）'}
              </button>
              {testMsg && (
                <div className={`test-result${testMsg.ok ? ' test-result--ok' : ''}`}>{testMsg.text}</div>
              )}
              <button className="btn-ghost" onClick={() => void removeConfig()}>
                清除配置（换一家）
              </button>
            </div>

            <div className="settings__group">
              <div className="field">
                <span className="field__hint">
                  用法：聊天页输入框右侧的麦克风，按住说话、上滑取消，松开后识别结果会填进
                  输入框，改好再发送。录音走 {pickAudioMime() || '系统默认'} 格式，最长 60 秒；
                  音频只上传到你配置的这一个识别端点，不经过任何中转。
                </span>
              </div>
            </div>
          </>
        )}

        {!loaded && !testMsg && (
          <div className="settings__group">
            <div className="field">
              <span className="field__hint">读取配置…</span>
            </div>
          </div>
        )}
      </div>
    </>
  );
}
