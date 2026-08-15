/**
 * Contact profile card (资料卡) — WeChat never drops you from the contact list
 * straight into an editor, and now neither do we: this card fronts every AI
 * contact with the actions that matter (发消息 / 通话 / 编辑人设 / 记忆).
 */
import { useNavigate, useParams } from 'react-router-dom';
import { SubNav } from '../../components/SubNav';
import { Avatar } from '../../components/Avatar';
import { useAppStore } from '../../store/appStore';
import { showConfirm } from '../../components/dialog';
import { Switch } from '../../components/Switch';
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
  const deleteContact = useAppStore((s) => s.deleteContact);
  const showToast = useAppStore((s) => s.showToast);

  // 星标 (M-I6): the schema carried isStarred since M1 with zero writers, so
  // the 星标朋友 section could never appear. This is the writer.
  const putContact = useAppStore((s) => s.putContact);
  const toggleStar = async () => {
    if (!contact) return;
    await putContact({ ...contact, isStarred: !contact.isStarred });
  };

  /** The one irreversible action on this card — spells out how much goes. */
  const removeContact = async () => {
    const ok = await showConfirm({
      title: '删除联系人',
      body: '将同时删除与 TA 的聊天记录、朋友圈动态和相关记忆，且无法恢复。',
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    await deleteContact(contactId);
    showToast('已删除');
    navigate('/contacts', { replace: true });
  };

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
          <div
            className="settings__row settings__row--divided"
            onClick={() => guard('contact.star', toggleStar)}
          >
            <span className="settings__label">星标朋友</span>
            <Switch on={Boolean(contact.isStarred)} onChange={() => guard('contact.star', toggleStar)} />
          </div>
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

        {contact.type === 'ai' && (
          <button className="btn-ghost" onClick={() => guard('contact.delete', removeContact)}>
            删除联系人
          </button>
        )}
      </div>
    </>
  );
}
