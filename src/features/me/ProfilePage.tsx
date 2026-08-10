/**
 * Edit the user's own identity (real-device bug #5: there was no way to change
 * 昵称/头像 anywhere — the '我' contact existed in the DB with putContact ready,
 * but nothing called it). Writes through the store so every surface that
 * renders the self contact (Me page, moments, group prompts) updates at once.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SubNav } from '../../components/SubNav';
import { Avatar } from '../../components/Avatar';
import { MediaPicker } from '../../components/MediaPicker';
import { useAppStore } from '../../store/appStore';
import { AVATAR_PALETTE } from '../../data/avatar-palette';
import { useGuard } from '../../app/useGuard';
import '../settings/settings.css';
import './me.css';

export function ProfilePage() {
  const guard = useGuard();
  const navigate = useNavigate();
  const me = useAppStore((s) => s.contactById('self'));
  const putContact = useAppStore((s) => s.putContact);
  const showToast = useAppStore((s) => s.showToast);

  const [name, setName] = useState(me?.name ?? '我');
  const [avatarText, setAvatarText] = useState(me?.avatarText ?? '我');
  const [color, setColor] = useState(me?.avatarColor ?? AVATAR_PALETTE[0]);
  const [avatarRef, setAvatarRef] = useState(me?.avatarRef);
  const [wxid, setWxid] = useState(me?.wxid ?? '');
  const [picking, setPicking] = useState(false);

  const save = async () => {
    if (!me) return;
    const trimmed = name.trim();
    if (!trimmed) {
      showToast('昵称不能为空');
      return;
    }
    await putContact({
      ...me,
      name: trimmed,
      avatarText: (avatarText.trim() || trimmed).slice(0, 2),
      avatarColor: color,
      avatarRef,
      wxid: wxid.trim() || me.wxid,
    });
    showToast('已保存');
    navigate(-1);
  };

  return (
    <>
      <SubNav title="个人资料" />
      <div className="page-body settings">
        <div className="profile__preview" onClick={() => setPicking(true)} role="button">
          <Avatar
            color={color}
            text={(avatarText.trim() || name.trim() || '我').slice(0, 2)}
            imageRef={avatarRef}
            size={64}
          />
        </div>
        {picking && (
          <MediaPicker
            kind="avatar"
            title="选择头像"
            allowClear
            onPick={(ref) => {
              setAvatarRef(ref || undefined);
              setPicking(false);
            }}
            onClose={() => setPicking(false)}
          />
        )}

        <div className="settings__group">
          <div className="field field--divided">
            <span className="field__label">昵称</span>
            <input
              className="field__input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={16}
              placeholder="你的名字"
            />
          </div>
          <div className="field field--divided">
            <span className="field__label">头像字（1-2 个字符）</span>
            <input
              className="field__input"
              value={avatarText}
              onChange={(e) => setAvatarText(e.target.value)}
              maxLength={2}
              placeholder="默认取昵称首字"
            />
          </div>
          <div className="field">
            <span className="field__label">微信号</span>
            <input
              className="field__input"
              value={wxid}
              onChange={(e) => setWxid(e.target.value)}
              maxLength={20}
              spellCheck={false}
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

        <button className="btn-primary" onClick={() => guard('profile.save', save)}>
          保存
        </button>
      </div>
    </>
  );
}
