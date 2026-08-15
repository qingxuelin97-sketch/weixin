/**
 * 聊天信息（M-D3）。The chat page's "…" finally goes somewhere: single chats get
 * the member header + find/pin/mute/delete rows; groups add the member grid,
 * editable group name and announcement. Every control is real — toggles write
 * through patchConversation, delete really deletes.
 */
import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { SubNav } from '../../components/SubNav';
import { Avatar } from '../../components/Avatar';
import { useAppStore } from '../../store/appStore';
import { showConfirm, showPrompt } from '../../components/dialog';
import { useGuard } from '../../app/useGuard';
import '../settings/settings.css';
import './chat.css';
import { Switch } from '../../components/Switch';

export function ChatInfoPage() {
  const guard = useGuard();
  const { convId = '' } = useParams();
  const navigate = useNavigate();
  const conv = useAppStore((s) => s.conversationById(convId));
  const contactById = useAppStore((s) => s.contactById);
  const patchConversation = useAppStore((s) => s.patchConversation);
  const deleteConversation = useAppStore((s) => s.deleteConversation);
  const showToast = useAppStore((s) => s.showToast);
  const [, bump] = useState(0);

  if (!conv) {
    return (
      <>
        <SubNav title="聊天信息" />
        <div className="page-body settings">
          <div className="field">
            <span className="field__hint">会话不存在</span>
          </div>
        </div>
      </>
    );
  }

  const isGroup = conv.type === 'group';
  const memberIds = isGroup ? (conv.memberIds ?? []) : conv.peerId ? [conv.peerId] : [];
  const members = memberIds
    .map((id) => contactById(id))
    .filter((c): c is NonNullable<typeof c> => Boolean(c));

  const toggle = async (key: 'isPinned' | 'isMuted') => {
    await patchConversation(conv.id, { [key]: !conv[key] });
    bump((n) => n + 1);
  };

  const editGroupName = async () => {
    const next = await showPrompt({ title: '群聊名称', initial: conv.title, maxLength: 16 });
    if (next?.trim()) {
      await patchConversation(conv.id, { title: next.trim().slice(0, 16) });
      bump((n) => n + 1);
    }
  };

  const editAnnouncement = async () => {
    const next = await showPrompt({
      title: '群公告',
      initial: conv.announcement ?? '',
      // Clearing the announcement is a legitimate edit, not a cancel.
      allowEmpty: true,
    });
    if (next != null) {
      await patchConversation(conv.id, { announcement: next.trim() || undefined });
      bump((n) => n + 1);
    }
  };

  const removeChat = async () => {
    // The old row destroyed the whole thread on a single tap — the only
    // destructive action in the app with no confirmation at all.
    const ok = await showConfirm({
      title: '删除该聊天',
      body: '聊天记录将被删除，且无法恢复。',
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    await deleteConversation(conv.id);
    showToast('已删除');
    navigate('/', { replace: true });
  };

  return (
    <>
      <SubNav title="聊天信息" />
      <div className="page-body settings">
        <div className="settings__group">
          <div className="chatinfo-members">
            {members.map((m) => (
              <div
                key={m.id}
                className="chatinfo-member"
                onClick={() => navigate(`/contact/${m.id}`)}
                role="button"
              >
                <Avatar color={m.avatarColor} text={m.avatarText} imageRef={m.avatarRef} size={52} />
                <span className="chatinfo-member__name">{m.remark ?? m.name}</span>
              </div>
            ))}
            <div className="chatinfo-member" onClick={() => navigate('/group-new')} role="button">
              <div className="chatinfo-member__add">＋</div>
              <span className="chatinfo-member__name">&nbsp;</span>
            </div>
          </div>
        </div>

        {isGroup && (
          <div className="settings__group">
            <div className="settings__row settings__row--divided" onClick={() => guard('chatinfo.rename', editGroupName)}>
              <span className="settings__label">群聊名称</span>
              <span className="settings__value">{conv.title}</span>
              <span className="settings__chevron">›</span>
            </div>
            <div className="settings__row" onClick={() => guard('chatinfo.announce', editAnnouncement)}>
              <span className="settings__label">群公告</span>
              <span className="settings__value">{conv.announcement ? conv.announcement.slice(0, 10) : '未设置'}</span>
              <span className="settings__chevron">›</span>
            </div>
          </div>
        )}

        <div className="settings__group">
          <div
            className="settings__row settings__row--divided"
            onClick={() => navigate('/search')}
          >
            <span className="settings__label">查找聊天记录</span>
            <span className="settings__chevron">›</span>
          </div>
          <div className="settings__row settings__row--divided" onClick={() => guard('chatinfo.pin', () => toggle('isPinned'))}>
            <span className="settings__label">置顶聊天</span>
            <Switch on={conv.isPinned} onChange={() => guard('chatinfo.pin', () => toggle('isPinned'))} />
          </div>
          <div className="settings__row" onClick={() => guard('chatinfo.mute', () => toggle('isMuted'))}>
            <span className="settings__label">消息免打扰</span>
            <Switch on={conv.isMuted} onChange={() => guard('chatinfo.mute', () => toggle('isMuted'))} />
          </div>
        </div>

        <button className="btn-ghost" onClick={() => guard('chatinfo.delete', removeChat)}>
          删除该聊天
        </button>
      </div>
    </>
  );
}
