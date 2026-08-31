import { useEffect, useState } from 'react';
import { SubNav } from '../../components/SubNav';
import { PRESETS } from '../../llm/presets';
import {
  testConnection,
  fetchModels,
  invalidateRouter,
  ensureFreshModelDefaults,
  diagnoseProvider,
  withDeadline,
  isPermissiveKind,
} from '../../llm/service';
import { repo } from '../../db/repo';
import { logError } from '../../lib/errlog';
import { setSecret, hasSecret, deleteSecret } from '../../lib/keystore';
import {
  isRecordingEnabled,
  setRecordingEnabled,
  getRecordings,
  clearRecordings,
  serializeRecordings,
} from '../../lib/llm-recorder';
import { saveTextFile } from '../../lib/save-file';
import type { ProviderVM } from '../../data/types';
// Type-only on purpose: the image module is a paid-path lazy chunk (10KB 余量
// 的启动包棘轮), loaded with await import() inside the handlers that need it.
import type { ImageProviderVM } from '../../llm/image';
import './settings.css';
import { Switch } from '../../components/Switch';

const loadImageMod = () => import('../../llm/image');

/** Build a default ProviderVM from a preset kind. */
function presetToVm(kind: keyof typeof PRESETS): ProviderVM {
  const p = PRESETS[kind];
  return {
    id: `prov_${kind}`,
    kind: p.kind as ProviderVM['kind'],
    label: p.label,
    baseUrl: p.baseUrl,
    fallbackBaseUrl: p.fallbackBaseUrl,
    keyAlias: `key_${kind}`,
    models: [...p.defaultModels],
    enabled: true,
  };
}

export function ApiConfigPage() {
  const [providers, setProviders] = useState<ProviderVM[]>([]);
  const [defaultId, setDefaultId] = useState<string>();
  const [nsfwId, setNsfwId] = useState<string>();
  const [editing, setEditing] = useState<ProviderVM | null>(null);
  const [keyInput, setKeyInput] = useState('');
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [testing, setTesting] = useState(false);
  const [fetching, setFetching] = useState(false);
  const [recording, setRecording] = useState(isRecordingEnabled());
  const [recCount, setRecCount] = useState(() => getRecordings().length);
  const [imgCfg, setImgCfg] = useState<ImageProviderVM | null>(null);
  const [imgKeyInput, setImgKeyInput] = useState('');
  const [imgTesting, setImgTesting] = useState(false);
  const [imgMsg, setImgMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const reload = async () => {
    try {
      await ensureFreshModelDefaults();
      setProviders(await repo.getProviders());
      setDefaultId(await repo.getSetting<string>('defaultProviderId'));
      setNsfwId(await repo.getSetting<string>('nsfwProviderId'));
      setImgCfg(await (await loadImageMod()).getImageProvider());
    } catch (e) {
      // This page is the only place a broken storage layer can be diagnosed
      // from. If its own read throws, it must say so rather than render an
      // empty provider list that looks like "you never configured anything".
      logError('apiConfig.reload', e);
      setTestMsg({ ok: false, text: `读取配置失败：${e instanceof Error ? e.message : String(e)}` });
    }
  };
  useEffect(() => {
    void reload();
  }, []);

  /** Every mutator goes through here: a failed write must never look like success. */
  const guard = async (scope: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      logError(`apiConfig.${scope}`, e);
      setTestMsg({ ok: false, text: `操作失败：${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const addPreset = (kind: keyof typeof PRESETS) =>
    guard('addPreset', async () => {
      const vm = presetToVm(kind);
      await repo.putProvider(vm);
      // First provider added becomes the default chat route; Zen becomes NSFW route.
      if (!(await repo.getSetting<string>('defaultProviderId')) && kind !== 'zen') {
        await repo.putSetting('defaultProviderId', vm.id);
      }
      if (kind === 'zen') await repo.putSetting('nsfwProviderId', vm.id);
      invalidateRouter();
      await reload();
      setEditing(vm);
      setKeyInput('');
      setTestMsg(null);
    });

  /**
   * 自定义 OpenAI 兼容槽位 (M-J3)。The kind has been first-class in the router
   * since M-C1 — `PERMISSIVE_KINDS` includes 'custom', so the NSFW routing
   * treats a user-declared endpoint as a permissive channel automatically —
   * but no UI could ever CREATE one. Id carries a timestamp so several custom
   * slots coexist (Date.now here is UI plumbing, not engine logic).
   */
  const addCustom = () =>
    guard('addCustom', async () => {
      const stamp = Date.now().toString(36);
      const vm: ProviderVM = {
        id: `prov_custom_${stamp}`,
        kind: 'custom',
        label: '自定义（OpenAI 兼容）',
        baseUrl: '',
        keyAlias: `key_custom_${stamp}`,
        models: [],
        enabled: true,
      };
      await repo.putProvider(vm);
      invalidateRouter();
      await reload();
      setEditing(vm);
      setKeyInput('');
      setTestMsg(null);
    });

  const saveKey = async () => {
    if (!editing || !keyInput.trim()) return;
    try {
      await setSecret(editing.keyAlias, keyInput.trim());
      setKeyInput('');
      setTestMsg({ ok: true, text: '密钥已加密保存到本机' });
    } catch (e) {
      // A failed save MUST be loud — silently keeping the input made the user
      // believe the key was stored when the keystore was actually broken.
      setTestMsg({ ok: false, text: `密钥保存失败：${e instanceof Error ? e.message : String(e)}` });
    }
    await reload();
  };

  const runTest = async () => {
    if (!editing) return;
    setTesting(true);
    setTestMsg(null);
    const t0 = performance.now();
    try {
      const r = await withDeadline(testConnection(editing), 25_000);
      const ms = Math.round(performance.now() - t0);
      setTestMsg({ ok: r.ok, text: r.ok ? `${r.message}（${ms}ms）` : r.message });
    } catch (e) {
      // testConnection catches its own errors; this guards the button state
      // against anything unexpected so it can never be stuck on 测试中….
      setTestMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };

  const runDiagnose = async () => {
    if (!editing) return;
    setTesting(true);
    setTestMsg(null);
    try {
      const lines = await diagnoseProvider(editing);
      const ok = lines.every((l) => l.includes('OK'));
      setTestMsg({ ok, text: lines.join('\n') });
    } catch (e) {
      setTestMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };

  const runFetchModels = async () => {
    if (!editing) return;
    setFetching(true);
    setTestMsg(null);
    try {
      // Belt-and-braces: even if a lower layer hangs, the button recovers.
      const ids = await withDeadline(fetchModels(editing), 20_000);
      if (ids.length) {
        const next = { ...editing, models: ids };
        setEditing(next);
        await repo.putProvider(next);
        invalidateRouter();
        setTestMsg({ ok: true, text: `已拉取 ${ids.length} 个模型，已写入模型列表` });
      } else {
        setTestMsg({ ok: false, text: '未拉取到新列表（需先保存密钥；或该服务商不支持 /models）' });
      }
    } catch (e) {
      // withDeadline rejects on a hang; without this the button recovered but
      // the reason vanished into an unhandled rejection.
      logError('apiConfig.fetchModels', e);
      setTestMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setFetching(false);
    }
  };

  const setAsDefault = (id: string) =>
    guard('setDefault', async () => {
      await repo.putSetting('defaultProviderId', id);
      invalidateRouter();
      await reload();
    });
  const setAsNsfw = (id: string) =>
    guard('setNsfw', async () => {
      await repo.putSetting('nsfwProviderId', id);
      invalidateRouter();
      await reload();
    });
  const removeProvider = (id: string) =>
    guard('removeProvider', async () => {
      await repo.deleteProvider(id);
      invalidateRouter();
      if (editing?.id === id) setEditing(null);
      await reload();
    });

  /* ---------------- 图片生成 (M-J3) ---------------- */

  const pickImgPreset = (kind: string) =>
    guard('imgPreset', async () => {
      const img = await loadImageMod();
      const next = img.imagePresetToConfig(kind);
      await img.saveImageProvider(next);
      setImgCfg(next);
      setImgKeyInput('');
      setImgMsg(null);
    });

  const patchImg = (p: Partial<ImageProviderVM>) => {
    if (imgCfg) setImgCfg({ ...imgCfg, ...p });
  };
  const persistImg = () => {
    if (imgCfg) void guard('imgPersist', async () => (await loadImageMod()).saveImageProvider(imgCfg));
  };

  const saveImgKey = () =>
    guard('imgKey', async () => {
      if (!imgCfg || !imgKeyInput.trim()) return;
      await setSecret(imgCfg.keyAlias, imgKeyInput.trim());
      setImgKeyInput('');
      setImgMsg({ ok: true, text: '密钥已加密保存到本机' });
    });

  const runImgTest = async () => {
    if (!imgCfg) return;
    setImgTesting(true);
    setImgMsg(null);
    try {
      // The real path, one real (smallest) generation — the only honest probe
      // for a diffusion queue. Belt-and-braces deadline keeps the button alive.
      const img = await loadImageMod();
      const r = await withDeadline(img.testImageGeneration(imgCfg), 70_000);
      setImgMsg({ ok: r.ok, text: r.message });
    } catch (e) {
      setImgMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setImgTesting(false);
    }
  };

  const removeImgCfg = () =>
    guard('imgRemove', async () => {
      if (!imgCfg) return;
      deleteSecret(imgCfg.keyAlias);
      await (await loadImageMod()).clearImageProvider();
      setImgCfg(null);
      setImgKeyInput('');
      setImgMsg(null);
    });

  const notAdded = (Object.keys(PRESETS) as Array<keyof typeof PRESETS>).filter(
    (k) => !providers.some((p) => p.id === `prov_${k}`),
  );

  return (
    <>
      <SubNav title="API 与模型" />
      <div className="page-body settings">
        {providers.map((p) => (
          <div key={p.id} className="provider-card" onClick={() => { setEditing(p); setTestMsg(null); }}>
            <div className="provider-card__head">
              <span className="provider-card__name">{p.label}</span>
              <span className={`provider-card__status ${hasSecret(p.keyAlias) ? 'provider-card__status--ok' : 'provider-card__status--off'}`}>
                {hasSecret(p.keyAlias) ? '已配置密钥' : '未配置密钥'}
              </span>
            </div>
            <div className="provider-card__meta">{p.baseUrl || '（未填 Base URL）'}</div>
            <div className="provider-card__meta">模型：{p.models.join(', ') || '（未配置）'}</div>
            <div className="provider-card__meta">
              {defaultId === p.id && '· 默认聊天路由 '}
              {nsfwId === p.id && '· NSFW 宽松通道 '}
              {/* 宽松通道徽标 (M-J3): kind 属于 PERMISSIVE_KINDS 即被 NSFW 路由
                  认作可承载全开档的通道——徽标读的是路由器同一份集合，不会说谎。 */}
              {isPermissiveKind(p.kind) && '· 可作宽松通道'}
            </div>
          </div>
        ))}

        <div className="settings__group" style={{ marginTop: 16 }}>
          <div className="settings__group-title">添加 Provider</div>
          {notAdded.map((k) => (
            <div
              key={k}
              className="settings__row settings__row--divided"
              onClick={() => addPreset(k)}
            >
              <span className="settings__label">{PRESETS[k].label}</span>
              <span className="settings__chevron">＋</span>
            </div>
          ))}
          <div className="settings__row" onClick={() => void addCustom()}>
            <span className="settings__label">自定义（任意 OpenAI 兼容端点）</span>
            <span className="settings__chevron">＋</span>
          </div>
          <p className="settings__hint">
            自定义槽位自动被 NSFW 路由认作宽松通道（与 Zen 同级）——只把你确认过内容政策的
            端点填进来。名称 / Base URL / 模型 id 全部自填。
          </p>
        </div>

        {editing && (
          <div className="settings__group" style={{ marginTop: 16 }}>
            <div className="settings__group-title">配置：{editing.label}</div>
            {editing.kind === 'custom' && (
              <div className="field field--divided">
                <span className="field__label">名称</span>
                <input
                  className="field__input"
                  value={editing.label}
                  onChange={(e) => setEditing({ ...editing, label: e.target.value })}
                  onBlur={() => {
                    void repo.putProvider(editing);
                    invalidateRouter();
                  }}
                  placeholder="我的中转站"
                  spellCheck={false}
                />
              </div>
            )}
            <div className="field field--divided">
              <span className="field__label">Base URL</span>
              <input
                className="field__input"
                value={editing.baseUrl}
                onChange={(e) => setEditing({ ...editing, baseUrl: e.target.value })}
                onBlur={() => {
                  void repo.putProvider(editing);
                  invalidateRouter();
                }}
                spellCheck={false}
              />
              <span className="field__hint">
                OpenAI 兼容根地址（自动追加 /chat/completions）；除 DeepSeek 外一般以 /v1 结尾
              </span>
            </div>
            <div className="field field--divided">
              <span className="field__label">模型（逗号分隔）</span>
              <input
                className="field__input"
                value={editing.models.join(', ')}
                onChange={(e) => setEditing({ ...editing, models: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })}
                onBlur={() => {
                  void repo.putProvider(editing);
                  invalidateRouter();
                }}
                spellCheck={false}
              />
            </div>
            <div className="field field--divided">
              <span className="field__label">可看图的模型（逗号分隔，可留空）</span>
              <input
                className="field__input"
                value={(editing.visionModels ?? []).join(', ')}
                onChange={(e) =>
                  setEditing({
                    ...editing,
                    visionModels: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
                  })
                }
                onBlur={() => {
                  void repo.putProvider(editing);
                  invalidateRouter();
                }}
                spellCheck={false}
              />
              <span className="field__hint">
                填了就以这里为准：只有列出的模型会收到图片。留空则按模型名猜（猜不出的当纯文本，防止发图后每轮 400）
              </span>
            </div>
            <div className="field">
              <span className="field__label">API Key（加密存本机，不入库、不上传）</span>
              <input
                className="field__input"
                value={keyInput}
                onChange={(e) => setKeyInput(e.target.value)}
                placeholder={hasSecret(editing.keyAlias) ? '已保存，输入可覆盖' : 'sk-...'}
                type="password"
                spellCheck={false}
                autoComplete="off"
              />
            </div>
            <button className="btn-primary" onClick={saveKey} disabled={!keyInput.trim()}>
              保存密钥
            </button>
            <button className="btn-ghost" onClick={runFetchModels} disabled={fetching}>
              {fetching ? '拉取中…' : '拉取模型列表'}
            </button>
            <button className="btn-ghost" onClick={runTest} disabled={testing}>
              {testing ? '测试中…' : '测试连接'}
            </button>
            <button className="btn-ghost" onClick={() => void runDiagnose()} disabled={testing}>
              网络诊断（分段定位）
            </button>
            {testMsg && (
              <div className={`test-result${testMsg.ok ? ' test-result--ok' : ''}`}>{testMsg.text}</div>
            )}
            <div style={{ display: 'flex', gap: 10, margin: '10px 16px 0' }}>
              <button
                className={`btn-ghost${defaultId === editing.id ? ' btn-ghost--active' : ''}`}
                style={{ margin: 0 }}
                onClick={() => void setAsDefault(editing.id).catch(() => {})}
              >
                {defaultId === editing.id ? '✓ 当前默认聊天' : '设为默认聊天'}
              </button>
              <button
                className={`btn-ghost${nsfwId === editing.id ? ' btn-ghost--active' : ''}`}
                style={{ margin: 0 }}
                onClick={() => void setAsNsfw(editing.id).catch(() => {})}
              >
                {nsfwId === editing.id ? '✓ 当前宽松通道' : '设为宽松通道'}
              </button>
            </div>
            <button className="btn-ghost" onClick={() => removeProvider(editing.id)}>
              删除此 Provider
            </button>
          </div>
        )}

        <div className="settings__group" style={{ marginTop: 16 }}>
          <div className="settings__group-title">图片生成（可选，聊天配图 / 朋友圈配图 / AI 换头像）</div>
          {!imgCfg && (
            <>
              <div className="settings__row settings__row--divided" onClick={() => pickImgPreset('siliconflow')}>
                <span className="settings__label">SiliconFlow 硅基流动（国内直连）</span>
                <span className="settings__chevron">＋</span>
              </div>
              <div className="settings__row settings__row--divided" onClick={() => pickImgPreset('openai')}>
                <span className="settings__label">OpenAI（gpt-image / DALL·E）</span>
                <span className="settings__chevron">＋</span>
              </div>
              <div className="settings__row" onClick={() => pickImgPreset('custom')}>
                <span className="settings__label">自定义（任意 OpenAI 兼容 images 端点）</span>
                <span className="settings__chevron">＋</span>
              </div>
              <p className="settings__hint">
                不配也完全能用：AI 发图会继续从素材库抽取。配置后，素材池没有命中素材时才会
                真的生成一张（每次生成计入用量）。
              </p>
            </>
          )}
          {imgCfg && (
            <>
              <div className="field field--divided">
                <span className="field__label">Base URL</span>
                <input
                  className="field__input"
                  value={imgCfg.baseUrl}
                  onChange={(e) => patchImg({ baseUrl: e.target.value })}
                  onBlur={persistImg}
                  placeholder="https://api.siliconflow.cn/v1"
                  spellCheck={false}
                />
                <span className="field__hint">自动追加 /images/generations；一般以 /v1 结尾</span>
              </div>
              <div className="field field--divided">
                <span className="field__label">模型</span>
                <input
                  className="field__input"
                  value={imgCfg.model}
                  onChange={(e) => patchImg({ model: e.target.value })}
                  onBlur={persistImg}
                  placeholder="Kwai-Kolors/Kolors"
                  spellCheck={false}
                />
              </div>
              <div className="field field--divided">
                <span className="field__label">可用尺寸（逗号分隔，第一个为默认）</span>
                <input
                  className="field__input"
                  value={imgCfg.sizes.join(', ')}
                  onChange={(e) =>
                    patchImg({ sizes: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })
                  }
                  onBlur={persistImg}
                  spellCheck={false}
                />
              </div>
              {imgCfg.kind === 'custom' && (
                <>
                  {/* 铁律 6 的生成面：与 ASR 的 nsfwSafe、宽松通道 LLM 同一个用户判断。 */}
                  <div className="settings__row settings__row--divided">
                    <span className="settings__label">允许承载全开档生成提示</span>
                    <Switch
                      on={Boolean(imgCfg.nsfwCapable)}
                      onChange={(next) => {
                        patchImg({ nsfwCapable: next });
                        void persistImg();
                      }}
                      label="允许承载全开档生成提示"
                    />
                  </div>
                  <p className="settings__hint">
                    关闭时（默认），全开档会话里的配图会直接跳过生成、回落素材池。
                    只有你确认这家端点适合承载这类内容时才打开。
                  </p>
                </>
              )}
              {imgCfg.kind !== 'custom' && (
                <p className="settings__hint">
                  预设端点在全开档下一律不生成（SiliconFlow 是国内官方端点，铁律 6）——
                  全开档要用生成配图，请改配自定义端点并显式勾选。
                </p>
              )}
              <div className="field">
                <span className="field__label">API Key（加密存本机，不入库、不上传）</span>
                <input
                  className="field__input"
                  value={imgKeyInput}
                  onChange={(e) => setImgKeyInput(e.target.value)}
                  placeholder={hasSecret(imgCfg.keyAlias) ? '已保存，输入可覆盖' : 'sk-...'}
                  type="password"
                  spellCheck={false}
                  autoComplete="off"
                />
              </div>
              <button className="btn-primary" onClick={() => void saveImgKey()} disabled={!imgKeyInput.trim()}>
                保存密钥
              </button>
              <button className="btn-ghost" onClick={() => void runImgTest()} disabled={imgTesting}>
                {imgTesting ? '生成中…' : '测试生成（会真的画一张小图）'}
              </button>
              {imgMsg && (
                <div className={`test-result${imgMsg.ok ? ' test-result--ok' : ''}`}>{imgMsg.text}</div>
              )}
              <button className="btn-ghost" onClick={() => void removeImgCfg()}>
                清除图片生成配置
              </button>
            </>
          )}
        </div>

        <div className="settings__group" style={{ marginTop: 16 }}>
          <div className="settings__group-title">对话录制（调优语料，只存本机）</div>
          <div
            className="settings__row settings__row--divided"
            onClick={() => {
              const next = !recording;
              setRecordingEnabled(next);
              setRecording(next);
            }}
          >
            <span className="settings__label">录制真实请求与回复</span>
            <Switch
              on={recording}
              onChange={(next) => {
                setRecordingEnabled(next);
                setRecording(next);
              }}
            />
          </div>
          <div className="field">
            <span className="field__hint">
              只记录发送的消息与模型回复正文（不含密钥），最多保留 100 条。导出的文件用于
              调优多气泡解析与记忆抽取。
            </span>
          </div>
          <button
            className="btn-ghost"
            disabled={recCount === 0}
            onClick={() => {
              void saveTextFile(
                `llm-recordings-${recCount}.json`,
                serializeRecordings(),
                'application/json',
                '导出对话录制',
              ).catch(() => {});
            }}
          >
            导出录制（{recCount} 条）
          </button>
          <button
            className="btn-ghost"
            disabled={recCount === 0}
            onClick={() => {
              clearRecordings();
              setRecCount(0);
            }}
          >
            清空录制
          </button>
        </div>
      </div>
    </>
  );
}
