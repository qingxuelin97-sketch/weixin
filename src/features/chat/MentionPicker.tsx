/**
 * 群里打出「@」：「选择提醒的人」整页 (M-L2)。
 *
 * 取代此前的半屏名字列表。微信的样子：从底部升起的整页、搜索、带头像的成员。点一个人，把
 * `名字 ` 接在已经打出来的「@」后面——正是导演的 findMentions 认的写法，所以这一下是真的
 * 「叫到了」TA。成员来自这个群自己的名单，不是全部联系人：@ 一个不在群里的人没有意义。
 */
import { useMemo, useState } from 'react';
import { Avatar } from '../../components/Avatar';
import { IconClose, IconSearch } from '../../components/icons';
import { useDismissable } from '../../app/useDismissable';
import type { ContactVM } from '../../data/types';
import '../../components/chat-picker.css';

export interface MentionPickerProps {
  open: boolean;
  /** This room's members (contacts that still exist), in roster order. */
  members: ContactVM[];
  onPick: (member: ContactVM) => void;
  onClose: () => void;
}

export function MentionPicker(props: MentionPickerProps) {
  return props.open ? <MentionPickerBody {...props} /> : null;
}

function MentionPickerBody({ members, onPick, onClose }: MentionPickerProps) {
  const [q, setQ] = useState('');
  useDismissable(true, onClose);
  const rows = useMemo(() => {
    const k = q.trim().toLowerCase();
    if (!k) return members;
    return members.filter((m) => `${m.remark ?? ''} ${m.name}`.toLowerCase().includes(k));
  }, [members, q]);

  return (
    <div className="cpick" role="dialog" aria-label="选择提醒的人">
      <header className="cpick__nav">
        <button className="cpick__close" aria-label="关闭" onClick={onClose}>
          <IconClose />
        </button>
        <span className="cpick__title">选择提醒的人</span>
      </header>
      <label className="cpick__search">
        <IconSearch size={16} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索" />
      </label>
      <div className="cpick__body">
        {rows.length === 0 ? (
          <div className="cpick__empty">没有找到「{q.trim()}」</div>
        ) : (
          rows.map((m) => (
            <button key={m.id} className="cpick__row" onClick={() => onPick(m)}>
              <Avatar color={m.avatarColor} text={m.avatarText} imageRef={m.avatarRef} size={40} />
              <span className="cpick__name">{m.remark ?? m.name}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
