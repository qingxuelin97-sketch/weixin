import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { SubNav } from '../../components/SubNav';
import { useAppStore } from '../../store/appStore';
import { VOICE_OPTIONS, DEFAULT_VOICE } from '../../llm/tts';
import type { PersonaVM } from '../../data/types';
import { makePersona } from '../../data/persona-defaults';
import './settings.css';

function emptyPersona(contactId: string): PersonaVM {
  return makePersona({ contactId, core: '', speechStyle: '', proactivity: 0.5 });
}

export function PersonaEditPage() {
  const { contactId = '' } = useParams();
  const navigate = useNavigate();
  const contact = useAppStore((s) => s.contactById(contactId));
  const existing = useAppStore((s) => s.personaFor(contactId));
  const putPersona = useAppStore((s) => s.putPersona);
  const [p, setP] = useState<PersonaVM>(existing ?? emptyPersona(contactId));

  const set = <K extends keyof PersonaVM>(k: K, v: PersonaVM[K]) => setP((prev) => ({ ...prev, [k]: v }));

  const save = async () => {
    await putPersona(p);
    navigate(-1);
  };

  return (
    <>
      <SubNav title={contact ? `编辑：${contact.remark ?? contact.name}` : '编辑人设'} />
      <div className="page-body settings">
        <div className="settings__group">
          <div className="field field--divided">
            <span className="field__label">人设简介（core）</span>
            <textarea
              className="field__textarea"
              value={p.core}
              onChange={(e) => set('core', e.target.value)}
              placeholder="例：25 岁插画师，温柔但有点毒舌，爱猫爱咖啡"
            />
          </div>
          <div className="field field--divided">
            <span className="field__label">说话风格</span>
            <input
              className="field__input"
              value={p.speechStyle ?? ''}
              onChange={(e) => set('speechStyle', e.target.value)}
              placeholder="例：短句、口语、爱用语气词"
            />
          </div>
          <div className="field field--divided">
            <span className="field__label">说话样例（每行一条，3-5 条）</span>
            <textarea
              className="field__textarea"
              value={p.fewShots.join('\n')}
              onChange={(e) => set('fewShots', e.target.value.split('\n').map((s) => s.trim()).filter(Boolean))}
              placeholder={'在干嘛呀\n我今天画了一整天'}
            />
          </div>
          <div className="field">
            <span className="field__label">口头禅（逗号分隔）</span>
            <input
              className="field__input"
              value={p.catchphrases.join('、')}
              onChange={(e) => set('catchphrases', e.target.value.split(/[，,、]/).map((s) => s.trim()).filter(Boolean))}
              placeholder="真的假的、离谱"
            />
          </div>
        </div>

        <div className="settings__group">
          <div className="field field--divided">
            <span className="field__label">主动性：{p.proactivity.toFixed(2)}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={p.proactivity}
              onChange={(e) => set('proactivity', Number(e.target.value))}
            />
          </div>
          <div className="field field--divided">
            <span className="field__label">打字速度（字/分）：{p.typingCpm}</span>
            <input
              type="range"
              min={120}
              max={500}
              step={10}
              value={p.typingCpm}
              onChange={(e) => set('typingCpm', Number(e.target.value))}
            />
          </div>
          <div className="field field--divided">
            <span className="field__label">温度：{p.temperature.toFixed(2)}</span>
            <input
              type="range"
              min={0}
              max={1.5}
              step={0.05}
              value={p.temperature}
              onChange={(e) => set('temperature', Number(e.target.value))}
            />
          </div>
          <div className="field">
            <span className="field__label">活跃时段（开始-结束小时，如 9-23）</span>
            <input
              className="field__input"
              value={`${p.activeHours[0]?.[0] ?? 9}-${p.activeHours[0]?.[1] ?? 23}`}
              onChange={(e) => {
                const m = e.target.value.match(/(\d+)\s*-\s*(\d+)/);
                if (m) set('activeHours', [[Number(m[1]), Number(m[2])]]);
              }}
            />
          </div>
        </div>

        <div className="settings__group">
          <div className="field field--divided">
            <span className="field__label">语音音色（MiniMax TTS）</span>
            <select
              className="field__input"
              value={p.ttsVoice ?? DEFAULT_VOICE}
              onChange={(e) => set('ttsVoice', e.target.value)}
            >
              {VOICE_OPTIONS.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <span className="field__label">抢红包速度</span>
            <div className="segmented" style={{ margin: 0 }}>
              {(['fast', 'mid', 'slow'] as const).map((s) => (
                <div
                  key={s}
                  className={`segmented__item${(p.grabSpeed ?? 'mid') === s ? ' segmented__item--active' : ''}`}
                  onClick={() => set('grabSpeed', s)}
                >
                  {s === 'fast' ? '手快' : s === 'mid' ? '一般' : '手慢'}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="settings__group">
          <div className="settings__row" onClick={() => set('nsfwPermit', !p.nsfwPermit)}>
            <span className="settings__label">允许 NSFW（此智能体）</span>
            <span className={`switch${p.nsfwPermit ? ' switch--on' : ''}`}>
              <span className="switch__knob" />
            </span>
          </div>
        </div>

        <button className="btn-primary" onClick={save} disabled={!p.core.trim()}>
          保存
        </button>
      </div>
    </>
  );
}
