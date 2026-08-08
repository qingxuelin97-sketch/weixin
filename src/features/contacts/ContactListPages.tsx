/**
 * 通讯录功能行的三个真页面（M-D3）：群聊列表 / 新的朋友 / 仅聊天与标签。
 * 之前这些行全是 toast 死入口；现在每个都点得进、看得到真数据。
 */
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { SubNav } from '../../components/SubNav';
import { Avatar } from '../../components/Avatar';
import { useAppStore } from '../../store/appStore';
import '../settings/settings.css';
import './contacts.css';

/** All group conversations, tap to enter. */
export function GroupListPage() {
  const navigate = useNavigate();
  const all = useAppStore((s) => s.conversations);
  const groups = useMemo(() => all.filter((c) => c.type === 'group' && !c.isHidden), [all]);
  return (
    <>
      <SubNav title="群聊" />
      <div className="page-body settings">
        <div className="settings__group">
          {groups.map((g) => (
            <div
              key={g.id}
              className="settings__row settings__row--divided"
              onClick={() => navigate(`/chat/${g.id}`)}
            >
              <Avatar color={g.avatarColor} text={g.avatarText} size={40} members={g.memberAvatars} />
              <span className="settings__label" style={{ marginLeft: 10 }}>
                {g.title}（{(g.memberIds?.length ?? 0) + 1}）
              </span>
              <span className="settings__chevron">›</span>
            </div>
          ))}
          {groups.length === 0 && (
            <div className="field">
              <span className="field__hint">还没有群聊——右上角＋或下面按钮发起一个</span>
            </div>
          )}
        </div>
        <button className="btn-primary" onClick={() => navigate('/group-new')}>
          发起群聊
        </button>
      </div>
    </>
  );
}

/** 新的朋友：adding an AI friend goes through here (the "申请" theater). */
export function NewFriendsPage() {
  const navigate = useNavigate();
  const contacts = useAppStore((s) => s.contacts);
  // Newest AI friends first — reads as a "recently passed" applications list.
  const recent = useMemo(
    () => contacts.filter((c) => c.type === 'ai').slice(-8).reverse(),
    [contacts],
  );
  return (
    <>
      <SubNav title="新的朋友" />
      <div className="page-body settings">
        <div className="settings__group">
          {recent.map((c) => (
            <div
              key={c.id}
              className="settings__row settings__row--divided"
              onClick={() => navigate(`/contact/${c.id}`)}
            >
              <Avatar color={c.avatarColor} text={c.avatarText} imageRef={c.avatarRef} size={40} />
              <span className="settings__label" style={{ marginLeft: 10 }}>
                {c.remark ?? c.name}
              </span>
              <span className="settings__value">已添加</span>
            </div>
          ))}
          {recent.length === 0 && (
            <div className="field">
              <span className="field__hint">暂无好友申请</span>
            </div>
          )}
        </div>
        <button className="btn-primary" onClick={() => navigate('/contact-new')}>
          添加朋友
        </button>
      </div>
    </>
  );
}

/** 仅聊天的朋友 / 标签：honest empty-state pages (this archive has neither yet). */
export function SimpleListPage({ kind }: { kind: 'chats-only' | 'tags' }) {
  return (
    <>
      <SubNav title={kind === 'tags' ? '标签' : '仅聊天的朋友'} />
      <div className="page-body settings">
        <div className="settings__group">
          <div className="field">
            <span className="field__hint">
              {kind === 'tags'
                ? '还没有创建标签。给朋友设置标签后会显示在这里。'
                : '没有仅聊天的朋友——你的所有好友都是完整权限的朋友。'}
            </span>
          </div>
        </div>
      </div>
    </>
  );
}
