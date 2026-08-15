/**
 * Contact profile card (资料卡) — WeChat never drops you from the contact list
 * straight into an editor, and now neither do we: this card fronts every AI
 * contact with the actions that matter (发消息 / 通话 / 编辑人设 / 记忆).
 */
import { useNavigate, useParams } from 'react-router-dom';
import { SubNav } from '../../components/SubNav';
import { Avatar } from '../../components/Avatar';
import { useAppStore } from '../../store/appStore';
import type { ConversationVM } from '../../data/types';
import { useGuard } from '../../app/useGuard';
import './contacts.css';

export function ContactProfilePage() {
  const guard = useGuard();
  const { contactId = '' } = useParams();
  const navigate = useNavigate();
  const contact = useAppStore((s) => s.contactById(contactId));
  const persona = useAppStore((s) => s.personaFor(contactId));
  const conversations = useAppStore((s) => s.conversations);
  const addConversation = useAppStore((s) => s.addConversation);

  if (!contact) {
    return (
      <>
        <SubNav title="联系人" />
        <div className="page-body contacts">
          <p className="settings__hint">联系人不存在</p>
        </div>
      </>
    );
  }

  /** Find (or lazily create) the 1:1 conversation with this contact. */
  const openChat = async () => {
    let conv = conversations.find((c) => c.type === 'single' && c.peerId === contactId && !c.isHidden);
    if (!conv) {
      conv = {
        id: `conv_${contactId}`,
        type: 'single',
        peerId: contactId,
        title: contact.remark ?? contact.name,
        avatarColor: contact.avatarColor,
        avatarText: contact.avatarText,
        isPinned: false,
        isMuted: false,
        unreadCount: 0,
        mentionMe: false,
        lastMsgPreview: '',
        lastMsgAt: Date.now(),
      } satisfies ConversationVM;
      await addConversation(conv);
    }
    navigate(`/chat/${conv.id}`);
  };

  return (
    <>
      <SubNav title="" />
      <div className="page-body contacts contact-card">
        <div className="contact-card__head">
          <Avatar color={contact.avatarColor} text={contact.avatarText} imageRef={contact.avatarRef} size={64} />
          <div className="contact-card__id">
            <div className="contact-card__name">{contact.remark ?? contact.name}</div>
            {contact.wxid && <div className="contact-card__meta">微信号：{contact.wxid}</div>}
            {contact.signature && <div className="contact-card__meta">个性签名：{contact.signature}</div>}
          </div>
        </div>

        {persona?.core && (
          <div className="settings__group">
            <div className="settings__group-title">人设</div>
            <p className="contact-card__core">{persona.core}</p>
          </div>
        )}

        <div className="settings__group">
          <div className="settings__row settings__row--divided" onClick={() => guard('contact.openChat', openChat)}>
            <span className="settings__label contact-card__action">发消息</span>
          </div>
          <div
            className="settings__row"
            onClick={() => {
              const conv = conversations.find(
                (c) => c.type === 'single' && c.peerId === contactId && !c.isHidden,
              );
              if (conv) navigate(`/call/${conv.id}`);
              else void openChat();
            }}
          >
            <span className="settings__label contact-card__action">语音通话</span>
          </div>
        </div>

        <div className="settings__group">
          {persona && (
            <div className="settings__row settings__row--divided" onClick={() => navigate(`/status/${contactId}`)}>
              <span className="settings__label">她的状态</span>
              <span className="settings__chevron">›</span>
            </div>
          )}
          <div className="settings__row settings__row--divided" onClick={() => navigate(`/persona/${contactId}`)}>
            <span className="settings__label">编辑人设</span>
            <span className="settings__chevron">›</span>
          </div>
          <div className="settings__row" onClick={() => navigate(`/memory/${contactId}`)}>
            <span className="settings__label">记忆管理</span>
            <span className="settings__chevron">›</span>
          </div>
        </div>
      </div>
    </>
  );
}
