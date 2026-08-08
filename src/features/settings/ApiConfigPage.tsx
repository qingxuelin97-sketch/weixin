import { useEffect, useState } from 'react';
import { SubNav } from '../../components/SubNav';
import { PRESETS } from '../../llm/presets';
import { testConnection, fetchModels, invalidateRouter, ensureFreshModelDefaults } from '../../llm/service';
import { repo } from '../../db/repo';
import { setSecret, hasSecret } from '../../lib/keystore';
import type { ProviderVM } from '../../data/types';
import './settings.css';

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

  const reload = async () => {
    await ensureFreshModelDefaults();
    setProviders(await repo.getProviders());
    setDefaultId(await repo.getSetting<string>('defaultProviderId'));
    setNsfwId(await repo.getSetting<string>('nsfwProviderId'));
  };
  useEffect(() => {
    void reload();
  }, []);

  const addPreset = async (kind: keyof typeof PRESETS) => {
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
  };

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
      const r = await testConnection(editing);
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

  const runFetchModels = async () => {
    if (!editing) return;
    setFetching(true);
    setTestMsg(null);
    try {
      const ids = await fetchModels(editing);
      if (ids.length) {
        const next = { ...editing, models: ids };
        setEditing(next);
        await repo.putProvider(next);
        invalidateRouter();
        setTestMsg({ ok: true, text: `已拉取 ${ids.length} 个模型，已写入模型列表` });
      } else {
        setTestMsg({ ok: false, text: '未拉取到新列表（需先保存密钥；或该服务商不支持 /models）' });
      }
    } finally {
      setFetching(false);
    }
  };

  const setAsDefault = async (id: string) => {
    await repo.putSetting('defaultProviderId', id);
    invalidateRouter();
    await reload();
  };
  const setAsNsfw = async (id: string) => {
    await repo.putSetting('nsfwProviderId', id);
    invalidateRouter();
    await reload();
  };
  const removeProvider = async (id: string) => {
    await repo.deleteProvider(id);
    invalidateRouter();
    if (editing?.id === id) setEditing(null);
    await reload();
  };

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
            <div className="provider-card__meta">{p.baseUrl}</div>
            <div className="provider-card__meta">模型：{p.models.join(', ')}</div>
            <div className="provider-card__meta">
              {defaultId === p.id && '· 默认聊天路由 '}
              {nsfwId === p.id && '· NSFW 宽松通道'}
            </div>
          </div>
        ))}

        {notAdded.length > 0 && (
          <div className="settings__group" style={{ marginTop: 16 }}>
            <div className="settings__group-title">添加预设 Provider</div>
            {notAdded.map((k, i) => (
              <div
                key={k}
                className={`settings__row${i < notAdded.length - 1 ? ' settings__row--divided' : ''}`}
                onClick={() => addPreset(k)}
              >
                <span className="settings__label">{PRESETS[k].label}</span>
                <span className="settings__chevron">＋</span>
              </div>
            ))}
          </div>
        )}

        {editing && (
          <div className="settings__group" style={{ marginTop: 16 }}>
            <div className="settings__group-title">配置：{editing.label}</div>
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
      </div>
    </>
  );
}
