/**
 * 通讯录功能行的真页面：群聊列表 / 新的朋友 / 仅聊天的朋友 / 标签（M-D3，M-J7 扩写）。
 * 之前这些行全是 toast 死入口；M-D3 让每个都点得进，M-J7 让后两个终于有真数据
 * ——在那之前它们是两句诚实的空文案，因为标签与朋友权限根本还不存在。
 */
import { useMemo } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { SubNav } from '../../components/SubNav';
import { Avatar } from '../../components/Avatar';
import { useAppStore } from '../../store/appStore';
import { chatOnlyIds, groupByTag } from '../../lib/friend-perms';
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

/** One tappable person row, shared by the two list pages below. */
function PersonRow({ id, trailing }: { id: string; trailing?: string }) {
  const navigate = useNavigate();
  const contact = useAppStore((s) => s.contactById(id));
  if (!contact) return null;
  return (
    <div
      className="settings__row settings__row--divided"
      onClick={() => navigate(`/contact/${contact.id}`)}
    >
      <Avatar
        color={contact.avatarColor}
        text={contact.avatarText}
        imageRef={contact.avatarRef}
        size={40}
      />
      <span className="settings__label" style={{ marginLeft: 10 }}>
        {contact.remark ?? contact.name}
      </span>
      {trailing && <span className="settings__value">{trailing}</span>}
      <span className="settings__chevron">›</span>
    </div>
  );
}

/**
 * 仅聊天的朋友 (M-J7).
 *
 * Derived from `friendPerms` rather than stored as its own list, so it cannot
 * disagree with the switch on the profile page — a second list would be a
 * second truth, and the one that drifts is always the index.
 */
export function ChatOnlyListPage() {
  const perms = useAppStore((s) => s.friendPerms);
  const ids = useMemo(() => chatOnlyIds(perms), [perms]);
  return (
    <>
      <SubNav title="仅聊天的朋友" />
      <div className="page-body settings">
        {ids.length > 0 ? (
          <>
            <div className="settings__group">
              {ids.map((id) => (
                <PersonRow key={id} id={id} />
              ))}
            </div>
            <p className="settings__footnote">
              仅聊天的朋友看不到你的朋友圈，你也看不到他的。
            </p>
          </>
        ) : (
          <div className="settings__group">
            <div className="field">
              <span className="field__hint">
                没有仅聊天的朋友——在联系人资料页的「朋友权限」里可以设置。
              </span>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

/** 标签列表 (M-J7)：每个标签一行，右侧是人数，点进去看成员。 */
export function TagListPage() {
  const navigate = useNavigate();
  const tags = useAppStore((s) => s.contactTags);
  const groups = useMemo(() => groupByTag(tags), [tags]);
  return (
    <>
      <SubNav title="标签" />
      <div className="page-body settings">
        {groups.length > 0 ? (
          <div className="settings__group">
            {groups.map((g) => (
              <div
                key={g.tag}
                className="settings__row settings__row--divided"
                onClick={() => navigate(`/contacts-tags/${encodeURIComponent(g.tag)}`)}
              >
                <span className="settings__label">{g.tag}</span>
                <span className="settings__value">{g.contactIds.length} 人</span>
                <span className="settings__chevron">›</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="settings__group">
            <div className="field">
              <span className="field__hint">
                还没有创建标签。在联系人资料页的「设置标签」里给朋友打标签后会显示在这里。
              </span>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

/** 一个标签的成员页。 */
export function TagMembersPage() {
  const { tag = '' } = useParams();
  const name = decodeURIComponent(tag);
  const tags = useAppStore((s) => s.contactTags);
  const ids = useMemo(
    () => groupByTag(tags).find((g) => g.tag === name)?.contactIds ?? [],
    [tags, name],
  );
  return (
    <>
      <SubNav title={name || '标签'} />
      <div className="page-body settings">
        <div className="settings__group">
          {ids.map((id) => (
            <PersonRow key={id} id={id} />
          ))}
          {ids.length === 0 && (
            <div className="field">
              {/* Reachable by a stale deep link after the last member lost the
                  tag — the same "gone, not broken" answer /moments/:id gives. */}
              <span className="field__hint">这个标签下已经没有朋友了。</span>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
