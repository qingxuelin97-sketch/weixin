/**
 * Persona editor — the agent's whole control surface (real-device bug #2:
 * "智能体配置太简单，并不 Agent").
 *
 * Every PersonaVM field is editable here, grouped by what it drives:
 * 人设 → prompt layers · 行为 → heartbeat/typing pacing · 朋友圈 → moments
 * engine · 关系 → the relations prompt layer (the chemistry precondition) ·
 * 模型 → per-persona routing · NSFW → the permit bit + style samples.
 * Memory management lives on its own page (/memory/:contactId).
 */
import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { SubNav } from '../../components/SubNav';
import { useAppStore } from '../../store/appStore';
import { VOICE_OPTIONS, DEFAULT_VOICE } from '../../llm/tts';
import { repo } from '../../db/repo';
import type { PersonaVM, ProviderVM } from '../../data/types';
import { makePersona } from '../../data/persona-defaults';
import './settings.css';

function emptyPersona(contactId: string): PersonaVM {
  return makePersona({ contactId, core: '', speechStyle: '', proactivity: 0.5 });
}

/** 主动频率 presets over heartbeatBaseMin — a dropdown reads better than raw minutes. */
const HEARTBEAT_PRESETS: Array<{ min: number; label: string }> = [
  { min: 60, label: '很粘人（约 1 小时）' },
  { min: 240, label: '常规（约 4 小时）' },
  { min: 480, label: '偶尔（约 8 小时）' },
  { min: 1440, label: '高冷（约 1 天）' },
];

const MOMENTS_PRESETS: Array<{ v: number; label: string }> = [
  { v: 0, label: '从不发' },
  { v: 0.15, label: '每周一条' },
  { v: 0.3, label: '每周两三条' },
  { v: 1, label: '每天一条' },
];

export function PersonaEditPage() {
  const { contactId = '' } = useParams();
  const navigate = useNavigate();
  const contact = useAppStore((s) => s.contactById(contactId));
  const contacts = useAppStore((s) => s.contacts);
  const existing = useAppStore((s) => s.personaFor(contactId));
  const putPersona = useAppStore((s) => s.putPersona);
  const showToast = useAppStore((s) => s.showToast);
  const [p, setP] = useState<PersonaVM>(existing ?? emptyPersona(contactId));
  const [providers, setProviders] = useState<ProviderVM[]>([]);

  useEffect(() => {
    void repo.getProviders().then((all) => setProviders(all.filter((x) => x.enabled)));
  }, []);

  const set = <K extends keyof PersonaVM>(k: K, v: PersonaVM[K]) => setP((prev) => ({ ...prev, [k]: v }));

  const setRelation = (id: string, text: string) =>
    setP((prev) => {
      const relations = { ...prev.relations };
      if (text.trim()) relations[id] = text;
      else delete relations[id];
      return { ...prev, relations };
    });

  const save = async () => {
    await putPersona(p);
    showToast('已保存');
    navigate(-1);
  };

  // Relations targets: the user + every OTHER AI contact.
  const others = contacts.filter((c) => c.type === 'ai' && c.id !== contactId);

  return (
    <>
      <SubNav title={contact ? `编辑：${contact.remark ?? contact.name}` : '编辑人设'} />
      <div className="page-body settings">
        <div className="settings__group">
          <div className="settings__group-title">人设</div>
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
          <div className="field field--divided">
            <span className="field__label">口头禅（逗号分隔）</span>
            <input
              className="field__input"
              value={p.catchphrases.join('、')}
              onChange={(e) => set('catchphrases', e.target.value.split(/[，,、]/).map((s) => s.trim()).filter(Boolean))}
              placeholder="真的假的、离谱"
            />
          </div>
          <div className="field">
            <span className="field__label">打招呼语（主动开场白兜底）</span>
            <input
              className="field__input"
              value={p.greeting ?? ''}
              onChange={(e) => set('greeting', e.target.value || undefined)}
              placeholder="例：在吗，跟你说个事"
            />
          </div>
        </div>

        <div className="settings__group">
          <div className="settings__group-title">行为</div>
          <div className="field field--divided">
            <span className="field__label">主动找你的频率</span>
            <select
              className="field__input"
              value={String(
                HEARTBEAT_PRESETS.find((h) => h.min === p.heartbeatBaseMin)?.min ?? p.heartbeatBaseMin,
              )}
              onChange={(e) => set('heartbeatBaseMin', Number(e.target.value))}
            >
              {HEARTBEAT_PRESETS.map((h) => (
                <option key={h.min} value={h.min}>
                  {h.label}
                </option>
              ))}
              {!HEARTBEAT_PRESETS.some((h) => h.min === p.heartbeatBaseMin) && (
                <option value={p.heartbeatBaseMin}>自定义（{p.heartbeatBaseMin} 分钟）</option>
              )}
            </select>
          </div>
          <div className="field field--divided">
            <span className="field__label">主动性：{p.proactivity.toFixed(2)}（0=从不追问）</span>
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
          <div className="field field--divided">
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
          <div className="settings__group-title">朋友圈</div>
          <div className="field field--divided">
            <span className="field__label">发帖频率</span>
            <select
              className="field__input"
              value={String(MOMENTS_PRESETS.find((m) => m.v === p.momentsPerDay)?.v ?? p.momentsPerDay)}
              onChange={(e) => set('momentsPerDay', Number(e.target.value))}
            >
              {MOMENTS_PRESETS.map((m) => (
                <option key={m.v} value={m.v}>
                  {m.label}
                </option>
              ))}
              {!MOMENTS_PRESETS.some((m) => m.v === p.momentsPerDay) && (
                <option value={p.momentsPerDay}>自定义（{p.momentsPerDay}/天）</option>
              )}
            </select>
          </div>
          <div className="field field--divided">
            <span className="field__label">点赞倾向：{p.likeRate.toFixed(2)}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={p.likeRate}
              onChange={(e) => set('likeRate', Number(e.target.value))}
            />
          </div>
          <div className="field field--divided">
            <span className="field__label">评论倾向：{p.commentRate.toFixed(2)}</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={p.commentRate}
              onChange={(e) => set('commentRate', Number(e.target.value))}
            />
          </div>
          <div className="field">
            <span className="field__label">初始亲密度：{p.affinityInit}（影响赞评与嘘寒问暖）</span>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={p.affinityInit}
              onChange={(e) => set('affinityInit', Number(e.target.value))}
            />
          </div>
        </div>

        <div className="settings__group">
          <div className="settings__group-title">关系（写进提示词的关系层——化学反应的前提）</div>
          <div className="field field--divided">
            <span className="field__label">和你（用户）的关系</span>
            <input
              className="field__input"
              value={p.relations.user ?? ''}
              onChange={(e) => setRelation('user', e.target.value)}
              placeholder="例：认识三年的好友，无话不谈"
            />
          </div>
          {others.map((c, i) => (
            <div key={c.id} className={`field${i < others.length - 1 ? ' field--divided' : ''}`}>
              <span className="field__label">和 {c.remark ?? c.name} 的关系</span>
              <input
                className="field__input"
                value={p.relations[c.id] ?? ''}
                onChange={(e) => setRelation(c.id, e.target.value)}
                placeholder="留空 = 互不认识（不会私聊）"
              />
            </div>
          ))}
        </div>

        <div className="settings__group">
          <div className="settings__group-title">模型与语音</div>
          <div className="field field--divided">
            <span className="field__label">聊天模型（此智能体专属）</span>
            <select
              className="field__input"
              value={p.modelChat ?? ''}
              onChange={(e) => set('modelChat', e.target.value || undefined)}
            >
              <option value="">跟随全局默认</option>
              {providers.flatMap((prov) =>
                prov.models.map((m) => (
                  <option key={`${prov.id}:${m}`} value={`${prov.id}:${m}`}>
                    {prov.label} · {m}
                  </option>
                )),
              )}
            </select>
          </div>
          <div className="field">
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
        </div>

        <div className="settings__group">
          <div className="settings__row settings__row--divided" onClick={() => set('nsfwPermit', !p.nsfwPermit)}>
            <span className="settings__label">允许 NSFW（此智能体）</span>
            <span className={`switch${p.nsfwPermit ? ' switch--on' : ''}`}>
              <span className="switch__knob" />
            </span>
          </div>
          {p.nsfwPermit && (
            <div className="field">
              <span className="field__label">NSFW 风格样例（每行一条，只在全开档使用）</span>
              <textarea
                className="field__textarea"
                value={(p.nsfwStyleSamples ?? []).join('\n')}
                onChange={(e) =>
                  set(
                    'nsfwStyleSamples',
                    e.target.value.split('\n').map((s) => s.trim()).filter(Boolean),
                  )
                }
                placeholder="示范这个角色亲密时的语气（不会发往国内端点）"
              />
            </div>
          )}
        </div>

        <div className="settings__group">
          <div className="settings__row" onClick={() => navigate(`/memory/${contactId}`)}>
            <span className="settings__label">记忆管理</span>
            <span className="settings__chevron">›</span>
          </div>
        </div>

        <button className="btn-primary" onClick={() => void save()} disabled={!p.core.trim()}>
          保存
        </button>
      </div>
    </>
  );
}
