/**
 * 发起群聊（M-D3）：pick ≥2 AI friends → a real group conversation is born and
 * the director machinery takes over from the first message.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SubNav } from '../../components/SubNav';
import { Avatar } from '../../components/Avatar';
import { useAppStore } from '../../store/appStore';
import '../settings/settings.css';
import { logError } from '../../lib/errlog';
import './contacts.css';

export function GroupCreatePage() {
  const navigate = useNavigate();
  const contacts = useAppStore((s) => s.contacts);
  const addConversation = useAppStore((s) => s.addConversation);
  const showToast = useAppStore((s) => s.showToast);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const ais = contacts.filter((c) => c.type === 'ai');

  const toggle = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const create = async () => {
    const memberIds = [...picked];
    if (memberIds.length < 2) {
      showToast('至少选择 2 位好友');
      return;
    }
    const members = memberIds.map((id) => contacts.find((c) => c.id === id)!);
    const title = members.map((m) => m.remark ?? m.name).join('、').slice(0, 16);
    const now = Date.now();
    const conv = {
      id: `conv_g_${now}`,
      type: 'group' as const,
      title,
      avatarColor: members[0].avatarColor,
      avatarText: members[0].avatarText,
      memberAvatars: members.map((m) => ({ color: m.avatarColor, text: m.avatarText })),
      memberIds,
      isPinned: false,
      isMuted: false,
      unreadCount: 0,
      mentionMe: false,
      lastMsgPreview: '你创建了群聊',
      lastMsgAt: now,
    };
    try {
      await addConversation(conv);
    } catch (e) {
      // Navigating on a failed write dropped the user into a chat backed by no
      // conversation row — an empty screen with no way to tell what went wrong.
      logError('group.create', e);
      showToast('创建群聊失败，请重试');
      return;
    }
    navigate(`/chat/${conv.id}`, { replace: true });
  };

  return (
    <>
      <SubNav title="发起群聊" />
      <div className="page-body settings">
        {/* Building a group by hand means already owning the people in it
            (M-H2). One sentence writes the whole room instead. */}
        <div className="settings__group">
          <div
            className="settings__row"
            role="button"
            onClick={() => navigate('/group-new/ai', { replace: true })}
          >
            <span className="settings__label">让 AI 帮我建一个群</span>
            <span className="settings__value">连人带关系一起生成</span>
            <span className="settings__chevron">›</span>
          </div>
        </div>

        <div className="settings__group">
          {ais.map((c) => (
            <div
              key={c.id}
              className="settings__row settings__row--divided"
              onClick={() => toggle(c.id)}
            >
              <span className={`group-pick${picked.has(c.id) ? ' group-pick--on' : ''}`}>
                {picked.has(c.id) ? '✓' : ''}
              </span>
              <Avatar color={c.avatarColor} text={c.avatarText} imageRef={c.avatarRef} size={40} />
              <span className="settings__label" style={{ marginLeft: 10 }}>
                {c.remark ?? c.name}
              </span>
            </div>
          ))}
        </div>
        <button className="btn-primary" onClick={() => void create()} disabled={picked.size < 2}>
          完成（已选 {picked.size} 人）
        </button>
      </div>
    </>
  );
}
