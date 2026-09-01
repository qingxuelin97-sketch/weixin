/**
 * 朋友权限 (M-J7) — 仅聊天 / 不让他看我的朋友圈 / 不看他的朋友圈。
 *
 * 三个开关都只写一行 KV，**读侧全在数据层**（`canSeeMoment` 一个收口，驱动里
 * 的 `visibleMoments` 与排期规划器 `planReactions` 都走它）。这页因此只负责表达
 * 意图，不负责执行——执行放在页面里，就等于「下一个读路径会忘」。
 *
 * 「仅聊天」与另外两个的关系是**顶替不是同步**：打开它时另外两行变成禁用而不是
 * 被写成 true，关掉它就回到打开前的细粒度状态。把粗开关实现成「同时写两个细
 * 开关」会吃掉用户原来的选择，而那正是用户关掉粗开关时想拿回来的东西。
 */
import { useNavigate, useParams } from 'react-router-dom';
import { SubNav } from '../../components/SubNav';
import { Switch } from '../../components/Switch';
import { useAppStore } from '../../store/appStore';
import '../settings/settings.css';
import './contacts.css';

export function FriendPermPage() {
  const { contactId = '' } = useParams();
  const navigate = useNavigate();
  const contact = useAppStore((s) => s.contactById(contactId));
  const perms = useAppStore((s) => s.friendPerms);
  const setFriendPerm = useAppStore((s) => s.setFriendPerm);
  const p = perms[contactId];
  const chatOnly = Boolean(p?.chatOnly);

  if (!contact) {
    return (
      <>
        <SubNav title="朋友权限" />
        <div className="page-body settings">
          <div className="field">
            <span className="field__hint">联系人不存在</span>
          </div>
          <button className="btn-ghost" onClick={() => navigate('/contacts', { replace: true })}>
            返回通讯录
          </button>
        </div>
      </>
    );
  }

  const name = contact.remark ?? contact.name;
  return (
    <>
      <SubNav title="朋友权限" />
      <div className="page-body settings">
        <div className="settings__group">
          <div className="settings__row settings__row--divided">
            <span className="settings__label">聊天、朋友圈等</span>
            <Switch on={!chatOnly} onChange={() => void setFriendPerm(contactId, { chatOnly: !chatOnly })} />
          </div>
          <div className="settings__row">
            <span className="settings__label">仅聊天</span>
            <Switch on={chatOnly} onChange={() => void setFriendPerm(contactId, { chatOnly: !chatOnly })} />
          </div>
        </div>
        <p className="settings__footnote">
          仅聊天：{name}看不到你的朋友圈，你也看不到{name}的。
        </p>

        <div className="settings__group">
          <div className="settings__group-title">朋友圈</div>
          <div className="settings__row settings__row--divided">
            <span className="settings__label">不让他看我的朋友圈</span>
            <Switch
              on={chatOnly || Boolean(p?.hideMine)}
              disabled={chatOnly}
              onChange={() => void setFriendPerm(contactId, { hideMine: !p?.hideMine })}
            />
          </div>
          <div className="settings__row">
            <span className="settings__label">不看他的朋友圈</span>
            <Switch
              on={chatOnly || Boolean(p?.hideTheirs)}
              disabled={chatOnly}
              onChange={() => void setFriendPerm(contactId, { hideTheirs: !p?.hideTheirs })}
            />
          </div>
        </div>
        <p className="settings__footnote">
          设置立即生效，并且对**已经发过**的动态同样有效——她不会再给你设为不可见的
          旧动态点赞或评论。
        </p>
      </div>
    </>
  );
}
