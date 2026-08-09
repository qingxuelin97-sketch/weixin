/**
 * 环境自检与错误日志（M-D hotfix）。A phone has no console: when the browser
 * build works and the APK silently does nothing, there is no way to see WHY.
 * This page probes the runtime capabilities the app actually depends on and
 * shows every captured error, so a device report becomes evidence instead of
 * guesswork.
 */
import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { SubNav } from '../../components/SubNav';
import { repo } from '../../db/repo';
import { getErrors, clearErrors, type ErrEntry } from '../../lib/errlog';
import { saveTextFile } from '../../lib/save-file';
import './settings.css';

interface Probe {
  label: string;
  ok: boolean;
  detail: string;
}

async function runProbes(): Promise<Probe[]> {
  const out: Probe[] = [];
  const push = (label: string, ok: boolean, detail: string) => out.push({ label, ok, detail });

  push('运行环境', true, Capacitor.isNativePlatform() ? `原生 App（${Capacitor.getPlatform()}）` : '浏览器');
  push('页面来源 origin', true, location.origin || '(空)');

  // localStorage — the API key ciphertext and several flags live here.
  try {
    const k = '__probe__';
    localStorage.setItem(k, '1');
    const v = localStorage.getItem(k);
    localStorage.removeItem(k);
    push('localStorage', v === '1', v === '1' ? '读写正常' : '写入后读不回');
  } catch (e) {
    push('localStorage', false, e instanceof Error ? e.message : String(e));
  }

  // IndexedDB — every message, persona and the crypto master key live here.
  try {
    const t0 = Date.now();
    const n = (await repo.getConversations()).length;
    push('IndexedDB', true, `读取正常（${n} 个会话，${Date.now() - t0}ms）`);
  } catch (e) {
    push('IndexedDB', false, e instanceof Error ? e.message : String(e));
  }

  // WebCrypto — without subtle the keystore cannot encrypt anything.
  push(
    'WebCrypto',
    typeof crypto !== 'undefined' && !!crypto.subtle,
    typeof crypto !== 'undefined' && crypto.subtle ? '可用' : '不可用（安全上下文缺失？）',
  );

  // Is fetch the real one, or replaced by a bridge shim?
  const fetchNative = /\[native code\]/.test(String(globalThis.fetch));
  push('fetch 实现', true, fetchNative ? '浏览器原生 fetch' : '已被替换（可能是插件注入的桥接版）');

  // Does the native HTTP bridge object even exist in this build?
  try {
    const mod = (await import('@capacitor/core')) as unknown as { CapacitorHttp?: unknown };
    push('原生 HTTP 桥对象', !!mod.CapacitorHttp, mod.CapacitorHttp ? '已加载' : '未找到 CapacitorHttp');
  } catch (e) {
    push('原生 HTTP 桥对象', false, e instanceof Error ? e.message : String(e));
  }

  return out;
}

export function EnvDiagPage() {
  const [probes, setProbes] = useState<Probe[] | null>(null);
  const [errors, setErrors] = useState<ErrEntry[]>([]);

  const refresh = () => {
    void runProbes().then(setProbes);
    setErrors(getErrors());
  };
  useEffect(refresh, []);

  const report = () =>
    [
      '# 环境自检',
      ...(probes ?? []).map((p) => `${p.ok ? '✅' : '❌'} ${p.label}：${p.detail}`),
      '',
      '# 错误日志',
      ...(errors.length
        ? errors.map((e) => `[${new Date(e.at).toLocaleTimeString('zh-CN')}] ${e.scope}: ${e.message}`)
        : ['（无）']),
    ].join('\n');

  return (
    <>
      <SubNav title="环境自检与日志" />
      <div className="page-body settings">
        <div className="settings__group">
          <div className="settings__group-title">运行环境</div>
          {(probes ?? []).map((p) => (
            <div key={p.label} className="settings__row settings__row--divided">
              <span className="settings__label">
                {p.ok ? '✅' : '❌'} {p.label}
              </span>
              <span className="settings__value">{p.detail}</span>
            </div>
          ))}
          {!probes && (
            <div className="field">
              <span className="field__hint">检测中…</span>
            </div>
          )}
        </div>

        <div className="settings__group">
          <div className="settings__group-title">错误日志（最近 {errors.length} 条）</div>
          {errors.length === 0 ? (
            <div className="field">
              <span className="field__hint">暂无错误记录。若功能异常却这里空白，说明失败发生在被静默吞掉的路径上——请回报。</span>
            </div>
          ) : (
            errors.map((e, i) => (
              <div key={i} className="field field--divided">
                <span className="field__label">
                  {new Date(e.at).toLocaleTimeString('zh-CN')} · {e.scope}
                </span>
                <span className="field__hint">{e.message}</span>
              </div>
            ))
          )}
        </div>

        <button className="btn-primary" onClick={refresh}>
          重新检测
        </button>
        <button
          className="btn-ghost"
          onClick={() => {
            void saveTextFile('aiwx-diagnostics.txt', report(), 'text/plain', '导出诊断报告').catch(() => {});
          }}
        >
          导出诊断报告
        </button>
        <button
          className="btn-ghost"
          onClick={() => {
            clearErrors();
            setErrors([]);
          }}
        >
          清空日志
        </button>
      </div>
    </>
  );
}
