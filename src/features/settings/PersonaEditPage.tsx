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
import { Avatar } from '../../components/Avatar';
import { MediaPicker } from '../../components/MediaPicker';
import { useAppStore } from '../../store/appStore';
import { VOICE_OPTIONS, DEFAULT_VOICE } from '../../llm/tts';
import { repo } from '../../db/repo';
import type { PersonaVM, ProviderVM } from '../../data/types';
import { makePersona, PERSONA_LIMITS } from '../../data/persona-defaults';
import { useGuard } from '../../app/useGuard';
import { getDrift, explainDrift, resetDrift, type DriftExplanation } from '../../ai/drift';
import { importStCard, exportStCard } from '../../ai/sillytavern';
import { saveTextFile } from '../../lib/save-file';
import { logError } from '../../lib/errlog';
import { humanizePersona, HUMANIZE_LEVEL_LABELS, type HumanizeLevel } from '../../ai/humanize';
import { applyPersonaPatch } from '../../data/persona-patch';
import { HumanizeDiffSheet } from './HumanizeDiffSheet';
import { showActionSheet, showConfirm } from '../../components/dialog';
import { getRouter } from '../../llm/service';
import { globalTier } from '../../lib/nsfw-tier';
import './settings.css';
import { Switch } from '../../components/Switch';

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
  const guard = useGuard();
  const { contactId = '' } = useParams();
  const navigate = useNavigate();
  const contact = useAppStore((s) => s.contactById(contactId));
  const contacts = useAppStore((s) => s.contacts);
  const existing = useAppStore((s) => s.personaFor(contactId));
  const putPersona = useAppStore((s) => s.putPersona);
  const showToast = useAppStore((s) => s.showToast);
  const putContact = useAppStore((s) => s.putContact);
  // Rows persisted before a field existed lack it — makePersona backfills the
  // defaults so e.g. `p.imageTags.join` can't crash on a pre-M-C2 persona.
  const [p, setP] = useState<PersonaVM>(existing ? makePersona(existing) : emptyPersona(contactId));
  const [providers, setProviders] = useState<ProviderVM[]>([]);
  const [pickingAvatar, setPickingAvatar] = useState(false);

  const [drifted, setDrifted] = useState<DriftExplanation[]>([]);

  useEffect(() => {
    void repo.getProviders().then((all) => setProviders(all.filter((x) => x.enabled)));
  }, []);

  // How she has actually changed since the card was written (M-H1). Shown here
  // rather than only in the state page because this is where the user comes to
  // ask "why is she like this" — and because a drift you cannot see or undo is
  // indistinguishable from the app quietly rewriting your character.
  useEffect(() => {
    if (!contactId) return;
    void getDrift(contactId, Date.now()).then((d) => setDrifted(explainDrift(d)));
  }, [contactId]);

  const set = <K extends keyof PersonaVM>(k: K, v: PersonaVM[K]) => setP((prev) => ({ ...prev, [k]: v }));

  const setRelation = (id: string, text: string) =>
    setP((prev) => {
      const relations = { ...prev.relations };
      if (text.trim()) relations[id] = text;
      else delete relations[id];
      return { ...prev, relations };
    });

  const [cardNotes, setCardNotes] = useState<string[]>([]);

  /**
   * Import a V2 card over this persona.
   *
   * Deliberately does NOT save: it fills the form, so the user reviews a
   * stranger's card before it becomes one of their friends.
   */
  const importCard = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const card = importStCard(parsed, contactId);
      if (!card) {
        showToast('不是可识别的角色卡');
        return;
      }
      setP(card.persona);
      setCardNotes(card.notes);
      showToast(`已载入「${card.name}」，确认后再保存`);
      // character_book (M-I4): the card's world entries, offered separately —
      // they are additive rows, not form fields, so they save on their own.
      if (card.worldbook.length) {
        void showConfirm({
          title: '导入世界书？',
          body: `这张卡带了 ${card.worldbook.length} 条世界书条目（只对这个角色生效），要一并导入吗？`,
          confirmText: '导入',
        }).then(async (yes) => {
          if (!yes) return;
          const now = Date.now();
          for (const e of card.worldbook) {
            await repo.putWorldbookEntry({ ...e, createdAt: now }).catch(() => {});
          }
          showToast(`已导入 ${card.worldbook.length} 条世界书条目`);
        });
      }
      // 拟人化追问 (M-I2): imported cards are the ones most likely to read as
      // generated — offer the rewrite while the card is still under review.
      void showConfirm({
        title: '顺手拟人化一遍？',
        body: '刚导入的卡可以让 AI 加点人味——逐字段对照，想留哪条留哪条。',
        confirmText: '来吧',
      }).then((yes) => {
        if (yes) void humanize();
      });
    } catch (err) {
      logError('persona.import', err);
      showToast('读取失败');
    }
  };

  const exportCard = async () => {
    try {
      const name = contact?.remark ?? contact?.name ?? '角色';
      // This persona's own worldbook entries travel with the card (M-I4).
      const book = (await repo.getWorldbook()).filter(
        (e) => e.scope === 'persona' && e.scopeId === contactId,
      );
      await saveTextFile(
        `${name}.card.json`,
        JSON.stringify(exportStCard(name, p, {}, book), null, 2),
        'application/json',
        '导出角色卡',
      );
    } catch (err) {
      logError('persona.export', err);
      showToast('导出失败');
    }
  };

  const save = async () => {
    await putPersona(p);
    showToast('已保存');
    navigate(-1);
  };

  // 一键拟人化 (M-I2): pick a level → chain → per-field diff → apply as PATCH.
  // Fills the form like the ST import does; nothing lands until 保存.
  const [hBusy, setHBusy] = useState(false);
  const [hPatch, setHPatch] = useState<Partial<PersonaVM> | null>(null);
  const humanize = async () => {
    if (hBusy) return;
    const levels: HumanizeLevel[] = ['light', 'medium', 'heavy'];
    const idx = await showActionSheet({
      title: '拟人化力度',
      actions: levels.map((l) => HUMANIZE_LEVEL_LABELS[l]),
    });
    if (idx == null) return;
    setHBusy(true);
    try {
      const router = await getRouter();
      // Rule #6: the tier is derived from the global setting, never declared.
      const tier = await globalTier();
      const out = await humanizePersona(
        p,
        contact?.remark ?? contact?.name ?? '她',
        levels[idx],
        {
          complete: async (messages, opts) =>
            (
              await router.complete(
                { role: 'reasoning', nsfwTier: tier },
                { messages, json: opts.json, maxTokens: opts.maxTokens, temperature: 0.9 },
                {},
                `humanize:${contactId}`,
              )
            ).text,
          onProgress: (note) => showToast(note),
        },
      );
      if (!out.ok || !out.value) {
        showToast(out.error ?? '拟人化失败');
        return;
      }
      setHPatch(out.value);
    } catch (err) {
      logError('persona.humanize', err);
      showToast('拟人化失败');
    } finally {
      setHBusy(false);
    }
  };

  // Relations targets: the user + every OTHER AI contact.
  const others = contacts.filter((c) => c.type === 'ai' && c.id !== contactId);

  return (
    <>
      <SubNav title={contact ? `编辑：${contact.remark ?? contact.name}` : '编辑人设'} />
      <div className="page-body settings">
        {contact && (
          <div className="settings__group">
            <div
              className="settings__row"
              onClick={() => setPickingAvatar(true)}
              role="button"
            >
              <span className="settings__label">头像</span>
              <Avatar
                color={contact.avatarColor}
                text={contact.avatarText}
                imageRef={contact.avatarRef}
                size={40}
              />
              <span className="settings__chevron">›</span>
            </div>
          </div>
        )}
        {pickingAvatar && contact && (
          <MediaPicker
            kind="avatar"
            title="选择头像"
            allowClear
            onPick={(ref) => {
              void putContact({ ...contact, avatarRef: ref || undefined });
              setPickingAvatar(false);
            }}
            onClose={() => setPickingAvatar(false)}
          />
        )}
        <div className="settings__group">
          <div className="settings__group-title">人设</div>
          <div className="field field--divided">
            <span className="field__label">人设简介（core）</span>
            <textarea
              className="field__textarea"
              value={p.core}
              maxLength={PERSONA_LIMITS.core}
              onChange={(e) => set('core', e.target.value)}
              placeholder="例：25 岁插画师，温柔但有点毒舌，爱猫爱咖啡"
            />
          </div>
          <div className="field field--divided">
            <span className="field__label">说话风格</span>
            <input
              className="field__input"
              value={p.speechStyle ?? ''}
              maxLength={PERSONA_LIMITS.speechStyle}
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
          <div className="field field--divided">
            <span className="field__label">配图标签（逗号分隔，对应素材库照片标签）</span>
            <input
              className="field__input"
              value={p.imageTags.join(', ')}
              onChange={(e) =>
                set(
                  'imageTags',
                  e.target.value
                    .split(/[,，]/)
                    .map((t) => t.trim())
                    .filter(Boolean),
                )
              }
              placeholder="留空 = 从整个照片池抽取"
              spellCheck={false}
            />
          </div>
          <div className="field field--divided">
            <span className="field__label">
              大方程度：{(p.generosity ?? 0.35).toFixed(2)}（她主动发红包/转账的意愿与金额）
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={p.generosity ?? 0.35}
              onChange={(e) => set('generosity', Number(e.target.value))}
            />
          </div>
          {drifted.length > 0 && (
            <div className="field">
              <span className="field__label">相处出来的变化（不改卡片，只是叠在上面）</span>
              {drifted.map((d) => (
                <div key={d.dim} className="field__hint">
                  · 她{d.label}（{d.delta > 0 ? '+' : ''}
                  {d.delta.toFixed(2)}）
                </div>
              ))}
              <button
                className="btn-ghost"
                onClick={() => {
                  void resetDrift(contactId).then(() => {
                    setDrifted([]);
                    showToast('已恢复到卡片');
                  });
                }}
              >
                恢复到卡片
              </button>
            </div>
          )}
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
            <Switch on={p.nsfwPermit} onChange={() => set('nsfwPermit', !p.nsfwPermit)} />
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

        {/* SillyTavern V2 (M-H2). The V2 card is the interchange format for
            this whole category of app: without it every character the user
            already owns is unreachable, and every character made here is
            trapped inside this app. */}
        <div className="settings__group">
          <div className="settings__group-title">一键拟人化</div>
          <div className="settings__row" role="button" onClick={() => guard('persona.humanize', humanize)}>
            <span className="settings__label">{hBusy ? '正在改写…' : 'AI 给这张卡加人味'}</span>
            <span className="settings__value">逐字段可选</span>
            <span className="settings__chevron">›</span>
          </div>
        </div>

        <div className="settings__group">
          <div className="settings__group-title">角色卡（SillyTavern V2）</div>
          <label className="settings__row">
            <span className="settings__label">导入角色卡</span>
            <span className="settings__value">选择 .json</span>
            <input type="file" accept=".json,application/json" hidden onChange={importCard} />
          </label>
          <div className="settings__row" role="button" onClick={() => void exportCard()}>
            <span className="settings__label">导出角色卡</span>
            <span className="settings__value">本 App 的字段会一并带走</span>
          </div>
          {cardNotes.map((n) => (
            <div key={n} className="field__hint">
              · {n}
            </div>
          ))}
        </div>

        <button className="btn-primary" onClick={() => guard('persona.save', save)} disabled={!p.core.trim()}>
          保存
        </button>
      </div>

      {hPatch && (
        <HumanizeDiffSheet
          open
          original={p}
          patch={hPatch}
          onClose={() => setHPatch(null)}
          onApply={(accepted) => {
            // Patch semantics end to end: only accepted fields move, locked
            // fields can't move even if the model tried (applyPersonaPatch
            // strips them again as the last line of defense).
            const { persona } = applyPersonaPatch(p, accepted);
            setP(persona);
            setHPatch(null);
            showToast('已应用，确认后记得保存');
          }}
        />
      )}
    </>
  );
}
