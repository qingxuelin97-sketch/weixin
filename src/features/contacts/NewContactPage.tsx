/**
 * Create a new AI friend (通讯录 ＋). The minimum viable identity is a name and
 * a persona core; makePersona fills every behavioral default so a new agent
 * heartbeats, posts, and reacts out of the box (the undefined-field trap in
 * CLAUDE.md §3.5 is exactly what this flow avoids). Everything else is a
 * follow-up edit on the persona page this flow lands on.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SubNav } from '../../components/SubNav';
import { Avatar } from '../../components/Avatar';
import { useAppStore } from '../../store/appStore';
import { makePersona } from '../../data/persona-defaults';
import { AVATAR_PALETTE } from '../../data/avatar-palette';
import type { ContactVM, ConversationVM } from '../../data/types';
import '../settings/settings.css';
import '../me/me.css';
import { logError } from '../../lib/errlog';
import './contacts.css';

export function NewContactPage() {
  const navigate = useNavigate();
  const putContact = useAppStore((s) => s.putContact);
  const putPersona = useAppStore((s) => s.putPersona);
  const addConversation = useAppStore((s) => s.addConversation);
  const contacts = useAppStore((s) => s.contacts);
  const showToast = useAppStore((s) => s.showToast);

  const [name, setName] = useState('');
  const [core, setCore] = useState('');
  const [relation, setRelation] = useState('');
  const [color, setColor] = useState(AVATAR_PALETTE[1]);
  const [busy, setBusy] = useState(false);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed || !core.trim() || busy) return;
    if (contacts.some((c) => (c.remark ?? c.name) === trimmed)) {
      showToast('已有同名联系人');
      return;
    }
    setBusy(true);
    const id = `ai_u${Date.now().toString(36)}`;
    const contact: ContactVM = {
      id,
      type: 'ai',
      name: trimmed,
      avatarColor: color,
      avatarText: trimmed.slice(0, 1),
      pinyinInitial: '#',
      wxid: id,
    };
    const persona = makePersona({
      contactId: id,
      core: core.trim(),
      ...(relation.trim() ? { relations: { user: relation.trim() } } : {}),
    });
    const conv: ConversationVM = {
      id: `conv_${id}`,
      type: 'single',
      peerId: id,
      title: trimmed,
      avatarColor: color,
      avatarText: trimmed.slice(0, 1),
      isPinned: false,
      isMuted: false,
      unreadCount: 0,
      mentionMe: false,
      lastMsgPreview: '',
      lastMsgAt: Date.now(),
    };
    try {
      await putContact(contact);
      await putPersona(persona);
      await addConversation(conv);
    } catch (e) {
      // Three writes with no transaction: a throw on the second leaves a contact
      // with no persona, which reads downstream as "not an AI" and quietly makes
      // the new friend mute. Say so and let them retry rather than navigating on.
      logError('contact.create', e);
      showToast('创建失败，请重试');
      setBusy(false);
      return;
    }
    showToast('已添加');
    // Land on the full persona editor so the new friend can be fleshed out.
    navigate(`/persona/${id}`, { replace: true });
  };

  return (
    <>
      <SubNav title="新建 AI 好友" />
      <div className="page-body settings">
        <div className="profile__preview">
          <Avatar color={color} text={name.trim().slice(0, 1) || '新'} size={64} />
        </div>

        {/* The hand-written flow sets two fields and leaves twenty at their
            defaults, which is why every hand-made agent behaves the same.
            One sentence fills all of them (M-H2). */}
        <div className="settings__group">
          <div
            className="settings__row"
            role="button"
            onClick={() => navigate('/contact-new/ai', { replace: true })}
          >
            <span className="settings__label">让 AI 帮我写一个</span>
            <span className="settings__value">一句话生成完整人设</span>
            <span className="settings__chevron">›</span>
          </div>
        </div>

        <div className="settings__group">
          <div className="field field--divided">
            <span className="field__label">名字</span>
            <input
              className="field__input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={16}
              placeholder="例：阿岚"
            />
          </div>
          <div className="field field--divided">
            <span className="field__label">人设简介（core，必填）</span>
            <textarea
              className="field__textarea"
              value={core}
              onChange={(e) => setCore(e.target.value)}
              placeholder="例：28 岁乐队吉他手，夜猫子，嘴硬心软"
            />
          </div>
          <div className="field">
            <span className="field__label">和你的关系（写进提示词）</span>
            <input
              className="field__input"
              value={relation}
              onChange={(e) => setRelation(e.target.value)}
              placeholder="例：网上认识的同好，刚加上微信"
            />
          </div>
        </div>

        <div className="settings__group">
          <div className="settings__group-title">头像颜色</div>
          <div className="profile__palette">
            {AVATAR_PALETTE.map((c) => (
              <button
                key={c}
                className={`profile__swatch${color === c ? ' profile__swatch--active' : ''}`}
                style={{ background: c }}
                aria-label={`颜色 ${c}`}
                onClick={() => setColor(c)}
              />
            ))}
          </div>
        </div>

        <button className="btn-primary" onClick={() => void create()} disabled={!name.trim() || !core.trim() || busy}>
          创建并完善人设
        </button>
        <p className="settings__hint">
          创建后会进入完整人设编辑页——主动频率、朋友圈习惯、和其他 AI 的关系都在那里配置。
        </p>
      </div>
    </>
  );
}
