/**
 * "让 AI 帮我写一个角色" (M-H2).
 *
 * The hand-written flow asks for a name and a core and leaves twenty other
 * fields at their defaults, which is why every hand-made agent behaves
 * identically: nobody can guess a good `heartbeatBaseMin` before meeting the
 * character. This page takes one sentence and fills all of them.
 *
 * Two things it deliberately does NOT do:
 *
 *   - save straight through. The card lands in a preview the user can edit
 *     field by field first, because a generated character you cannot correct
 *     is a slot machine, not a tool.
 *   - hide the cost. Generation is a real model call on the user's own key, so
 *     the button says what it is about to do and the progress line says which
 *     step is running.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SubNav } from '../../components/SubNav';
import { Avatar } from '../../components/Avatar';
import { useAppStore } from '../../store/appStore';
import { AVATAR_PALETTE } from '../../data/avatar-palette';
import { listRegisteredMedia } from '../../data/media-registry';
import { generatePersona, type GeneratedPersona } from '../../ai/persona-generate';
import { getRouter } from '../../llm/service';
import { globalTier } from '../../lib/nsfw-tier';
import { logError } from '../../lib/errlog';
import type { ContactVM, ConversationVM } from '../../data/types';
import '../settings/settings.css';
import './contacts.css';
import { pinyinInitialOf } from '../../lib/pinyin-initial';

const EXAMPLES = [
  '爱吃辣的川妹子，做插画的，嘴硬心软',
  '大学室友，程序员，话少但每次都秒回',
  '健身教练，作息极其规律，早上六点就找你说话',
];

export function PersonaGeneratePage() {
  const navigate = useNavigate();
  const contacts = useAppStore((s) => s.contacts);
  const putContact = useAppStore((s) => s.putContact);
  const putPersona = useAppStore((s) => s.putPersona);
  const addConversation = useAppStore((s) => s.addConversation);
  const showToast = useAppStore((s) => s.showToast);

  const [brief, setBrief] = useState('');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [card, setCard] = useState<GeneratedPersona | null>(null);
  const [color, setColor] = useState(AVATAR_PALETTE[1]);
  const [contactId, setContactId] = useState('');

  const run = async () => {
    if (!brief.trim() || busy) return;
    setBusy(true);
    setError('');
    setCard(null);
    const id = `ai_u${Date.now().toString(36)}`;
    setContactId(id);
    try {
      const router = await getRouter();
      // Rule #6: a persona card is content like any other. The tier comes from
      // the global setting, never declared here — and the whole chain runs on
      // whatever channel that resolves to.
      const tier = await globalTier();
      const out = await generatePersona(
        brief.trim(),
        {
          complete: async (messages, opts) =>
            (
              await router.complete(
                { role: 'reasoning', nsfwTier: tier },
                { messages, json: opts.json, maxTokens: opts.maxTokens, temperature: 0.9 },
                {},
                `persona-gen:${id}`,
              )
            ).text,
          onProgress: setProgress,
        },
        {
          contactId: id,
          takenNames: contacts.map((c) => c.remark ?? c.name),
          knownTags: [
            ...new Set(listRegisteredMedia('photo').flatMap((m) => m.tags ?? [])),
          ],
        },
      );
      if (!out.ok || !out.value) {
        setError(out.error ?? '生成失败');
        return;
      }
      setCard(out.value);
    } catch (e) {
      logError('persona.generate', e);
      setError(e instanceof Error ? e.message : '生成失败');
    } finally {
      setBusy(false);
      setProgress('');
    }
  };

  const save = async () => {
    if (!card || busy) return;
    setBusy(true);
    const contact: ContactVM = {
      id: contactId,
      type: 'ai',
      name: card.name,
      signature: card.signature,
      avatarColor: color,
      avatarText: card.name.slice(0, 1),
      pinyinInitial: pinyinInitialOf(card.name),
      wxid: contactId,
    };
    const conv: ConversationVM = {
      id: `conv_${contactId}`,
      type: 'single',
      peerId: contactId,
      title: card.name,
      avatarColor: color,
      avatarText: card.name.slice(0, 1),
      isPinned: false,
      isMuted: false,
      unreadCount: 0,
      mentionMe: false,
      lastMsgPreview: '',
      lastMsgAt: Date.now(),
    };
    try {
      await putContact(contact);
      await putPersona(card.persona);
      await addConversation(conv);
    } catch (e) {
      // Same three-write hazard as the hand-written flow: a throw on the
      // second leaves a contact with no persona, which reads downstream as
      // "not an AI" and quietly makes the new friend mute.
      logError('persona.generate.save', e);
      setBusy(false);
      showToast('保存失败，请重试');
      return;
    }
    showToast('已创建');
    navigate(`/persona/${contactId}`, { replace: true });
  };

  const p = card?.persona;

  return (
    <>
      <SubNav title="AI 代写角色卡" />
      <div className="page-body settings">
        <div className="settings__group">
          <div className="settings__group-title">一句话描述这个人</div>
          <div className="field field--divided">
            <textarea
              className="field__textarea"
              value={brief}
              maxLength={200}
              onChange={(e) => setBrief(e.target.value)}
              placeholder={EXAMPLES[0]}
            />
          </div>
          <div className="field">
            <span className="field__label">试试这些</span>
            {EXAMPLES.map((x) => (
              <button key={x} className="btn-ghost" onClick={() => setBrief(x)}>
                {x}
              </button>
            ))}
          </div>
        </div>

        <div className="settings__group">
          <button className="btn-primary" disabled={busy || !brief.trim()} onClick={() => void run()}>
            {busy ? (progress || '生成中…') : card ? '重新生成' : '生成角色卡（会调用一次模型）'}
          </button>
          {error && <div className="field__hint">{error}</div>}
        </div>

        {card && p && (
          <>
            <div className="settings__group">
              <div className="settings__group-title">预览（保存后还能逐字改）</div>
              <div className="field field--divided">
                <span className="field__label">名字</span>
                <div className="persona-gen__head">
                  <Avatar color={color} text={card.name.slice(0, 1)} size={44} />
                  <input
                    className="field__input"
                    value={card.name}
                    onChange={(e) => setCard({ ...card, name: e.target.value })}
                  />
                </div>
              </div>
              <div className="field field--divided">
                <span className="field__label">头像底色</span>
                <div className="persona-gen__colors">
                  {AVATAR_PALETTE.map((c) => (
                    <button
                      key={c}
                      className={`persona-gen__color${c === color ? ' persona-gen__color--on' : ''}`}
                      style={{ background: c }}
                      aria-label="选择底色"
                      onClick={() => setColor(c)}
                    />
                  ))}
                </div>
              </div>
              <div className="field field--divided">
                <span className="field__label">人设简介</span>
                <textarea
                  className="field__textarea"
                  value={p.core}
                  onChange={(e) => setCard({ ...card, persona: { ...p, core: e.target.value } })}
                />
              </div>
              <div className="field field--divided">
                <span className="field__label">说话风格</span>
                <input
                  className="field__input"
                  value={p.speechStyle ?? ''}
                  onChange={(e) =>
                    setCard({ ...card, persona: { ...p, speechStyle: e.target.value } })
                  }
                />
              </div>
              <div className="field field--divided">
                <span className="field__label">她平时会这么说</span>
                <textarea
                  className="field__textarea"
                  value={p.fewShots.join('\n')}
                  onChange={(e) =>
                    setCard({
                      ...card,
                      persona: {
                        ...p,
                        fewShots: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean),
                      },
                    })
                  }
                />
              </div>
              <div className="field">
                <span className="field__label">她和你的关系</span>
                <input
                  className="field__input"
                  value={p.relations.user ?? ''}
                  onChange={(e) =>
                    setCard({
                      ...card,
                      persona: { ...p, relations: { ...p.relations, user: e.target.value } },
                    })
                  }
                />
              </div>
            </div>

            <div className="settings__group">
              <div className="settings__group-title">行为（AI 按人设给的，可在人设页细调）</div>
              <div className="field__hint">
                作息 {p.activeHours.map(([a, b]) => `${a}-${b > 24 ? b - 24 : b}点`).join('、')}
                ｜主动性 {p.proactivity.toFixed(2)}｜打字 {p.typingCpm} 字/分
              </div>
              <div className="field__hint">
                朋友圈 {p.momentsPerDay}/天｜点赞 {p.likeRate.toFixed(2)}｜评论{' '}
                {p.commentRate.toFixed(2)}｜大方 {p.generosity.toFixed(2)}
              </div>
            </div>

            <div className="settings__group">
              <button className="btn-primary" disabled={busy} onClick={() => void save()}>
                保存并开始聊天
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
