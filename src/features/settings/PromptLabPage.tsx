/**
 * 提示词工作台 (M-I11) — the tuning loop for拟人化 and世界书.
 *
 * Shows what each recorded LLM turn ACTUALLY sent: the system prompt split
 * into its layers (with per-layer size), the conversation window, and the raw
 * response. Reads the llm-recorder ring buffer — never re-assembles a prompt,
 * because a re-simulation would drift from the dozen conditional layers the
 * engines append (see src/ai/prompt-lab.ts).
 *
 * Hidden AI↔AI DM traffic never appears here: the recorder suppresses those
 * calls at the tap (beginRecordingSuppression), so this surface cannot leak
 * them by construction.
 */
import { useState } from 'react';
import { SubNav } from '../../components/SubNav';
import { Switch } from '../../components/Switch';
import {
  getRecordings,
  clearRecordings,
  serializeRecordings,
  isRecordingEnabled,
  setRecordingEnabled,
  type LlmExchange,
} from '../../lib/llm-recorder';
import { splitPromptSections, systemOf, turnsOf } from '../../ai/prompt-lab';
import { promptStats, PROMPT_LIMITS } from '../../ai/prompt';
import { saveTextFile } from '../../lib/save-file';
import { useAppStore } from '../../store/appStore';
import './settings.css';

function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString('zh-CN', { hour12: false });
}

function ExchangeDetail({ entry }: { entry: LlmExchange }) {
  const [openSection, setOpenSection] = useState<number | null>(null);
  const system = systemOf(entry);
  const sections = system ? splitPromptSections(system) : [];
  const stats = system ? promptStats(system) : null;
  const turns = turnsOf(entry);

  return (
    <div className="prompt-lab__detail">
      {stats && (
        <p className={`settings__hint${stats.overBudget ? ' prompt-lab__over' : ''}`}>
          系统提示共 {stats.chars} 字 · {sections.length} 层
          {stats.overBudget ? ` · 已超软上限 ${PROMPT_LIMITS.totalWarn}` : ''}
        </p>
      )}
      {!system && <p className="settings__hint">这次调用没有系统提示（原样透传）。</p>}
      {sections.map((s, i) => (
        <div key={i}>
          <div
            className="settings__row settings__row--divided"
            onClick={() => setOpenSection(openSection === i ? null : i)}
          >
            <span className="settings__label">{s.title}</span>
            <span className="settings__value">
              {s.chars} 字 {openSection === i ? '▾' : '▸'}
            </span>
          </div>
          {openSection === i && <pre className="prompt-lab__text">{s.text}</pre>}
        </div>
      ))}
      <div className="settings__row settings__row--divided">
        <span className="settings__label">上下文窗口</span>
        <span className="settings__value">{turns.length} 条消息</span>
      </div>
      {entry.text != null && (
        <>
          <div className="settings__row settings__row--divided">
            <span className="settings__label">模型返回</span>
            <span className="settings__value">{entry.finishReason ?? ''}</span>
          </div>
          <pre className="prompt-lab__text">{entry.text}</pre>
        </>
      )}
      {entry.error && <pre className="prompt-lab__text prompt-lab__over">{entry.error}</pre>}
    </div>
  );
}

export function PromptLabPage() {
  const showToast = useAppStore((s) => s.showToast);
  const [recordings, setRecordings] = useState<LlmExchange[]>(() => getRecordings().reverse());
  const [recording, setRecording] = useState(isRecordingEnabled());
  const [openIdx, setOpenIdx] = useState<number | null>(null);

  return (
    <>
      <SubNav title="提示词工作台" />
      <div className="page-body settings">
        <div className="settings__group">
          <div className="settings__row settings__row--divided">
            <span className="settings__label">记录 LLM 交互</span>
            <Switch
              on={recording}
              onChange={(next) => {
                setRecordingEnabled(next);
                setRecording(next);
              }}
            />
          </div>
          <p className="settings__hint">
            开启后，每次真实调用的完整请求（分层的系统提示 + 上下文）与返回会存进本机环形缓冲
            （最多 100 条，不含 API key）。拟人化和世界书调得准不准，看这里的实际注入就知道。
          </p>
        </div>

        <div className="settings__group">
          <div className="settings__group-title">最近调用（{recordings.length} 条，新的在前）</div>
          {recordings.length === 0 && (
            <p className="settings__hint">
              {recording
                ? '还没有记录——去和任何一个 AI 说句话就有了。'
                : '记录未开启。打开上面的开关，之后的每次调用都会出现在这里。'}
            </p>
          )}
          {recordings.map((r, i) => (
            <div key={`${r.at}:${i}`}>
              <div
                className="settings__row settings__row--divided"
                onClick={() => setOpenIdx(openIdx === i ? null : i)}
              >
                <span className="settings__label">
                  {r.error ? '❌' : '✅'} {timeOf(r.at)} · {r.model}
                </span>
                <span className="settings__value">
                  {systemOf(r)?.length ?? 0} 字 · {r.latencyMs}ms
                </span>
              </div>
              {openIdx === i && <ExchangeDetail entry={r} />}
            </div>
          ))}
        </div>

        {recordings.length > 0 && (
          <>
            <button
              className="btn-primary"
              onClick={() => {
                void saveTextFile(
                  'aiwx-llm-recordings.json',
                  serializeRecordings(),
                  'application/json',
                  '导出录制',
                ).catch(() => {});
              }}
            >
              导出全部录制（JSON）
            </button>
            <button
              className="btn-ghost"
              onClick={() => {
                clearRecordings();
                setRecordings([]);
                setOpenIdx(null);
                showToast('已清空录制');
              }}
            >
              清空录制
            </button>
          </>
        )}
      </div>
    </>
  );
}
