/**
 * 个人资料 (M-K4 重做)：微信 8.0 的逐行版式——头像 / 名字 / 拍一拍 / 微信号 / 我的二维码，
 * 每一行点进去改一样东西、**改完即存**，没有底部的「保存」按钮。
 *
 * 此前这一页是一张表单（昵称、头像字、微信号、拍一拍四个输入框 + 一排色板 + 保存），
 * 读起来像后台而不是「我的资料」。能改的东西一样不少：头像的三种改法收进一个
 * 动作面板（素材库里的照片 / 占位头像的颜色 / 占位头像上的字）。
 *
 * 真机 bug #5 的来由仍然成立：自己的资料要写穿 store（putContact），这样「我」页、
 * 朋友圈、群聊 prompt 里所有画「我」的地方一次更新。
 */
import { useEffect, useState } from 'react';
import { SubNav } from '../../components/SubNav';
import { Avatar } from '../../components/Avatar';
import { MediaPicker } from '../../components/MediaPicker';
import { Sheet } from '../../components/Sheet';
import { showActionSheet, showPrompt } from '../../components/dialog';
import { useAppStore } from '../../store/appStore';
import { repo } from '../../db/repo';
import { PAT_SUFFIX_KEY, PAT_SUFFIX_MAX } from '../../ai/pat';
import { AVATAR_PALETTE } from '../../data/avatar-palette';
import { useGuard } from '../../app/useGuard';
import { LinkRow } from '../settings/rows';
import type { ContactVM } from '../../data/types';
import '../settings/settings.css';
import './me.css';

export function ProfilePage() {
  const guard = useGuard();
  const me = useAppStore((s) => s.contactById('self'));
  const putContact = useAppStore((s) => s.putContact);
  const showToast = useAppStore((s) => s.showToast);
  const [picking, setPicking] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // 拍一拍后缀 (M-J7)：微信把它放在「个人信息」里，因为它属于"你自己"——
  // 别人拍你时显示的是**你**设的后缀。
  const [patSuffix, setPatSuffix] = useState('');
  useEffect(() => {
    void repo
      .getSetting<string>(PAT_SUFFIX_KEY)
      .then((v) => setPatSuffix(v ?? ''))
      .catch(() => setPatSuffix(''));
  }, []);

  if (!me) return <SubNav title="个人资料" />;

  /** 一处写穿：每一行改完都走这里。 */
  const save = (patch: Partial<ContactVM>) =>
    guard('profile.save', async () => {
      await putContact({ ...me, ...patch });
    });

  const editName = async () => {
    const v = await showPrompt({ title: '设置名字', initial: me.name, maxLength: 16 });
    if (v == null) return;
    const name = v.trim();
    if (!name) return showToast('名字不能为空');
    // 占位头像的字默认跟着名字走——除非用户单独设过。
    const followsName = !me.avatarText || me.avatarText === me.name.slice(0, 2);
    await save({ name, ...(followsName ? { avatarText: name.slice(0, 2) } : {}) });
  };

  const editWxid = async () => {
    const v = await showPrompt({ title: '设置微信号', initial: me.wxid ?? '', maxLength: 20 });
    if (v == null || !v.trim()) return;
    await save({ wxid: v.trim() });
  };

  const editPat = async () => {
    const v = await showPrompt({
      title: '拍一拍',
      body: '朋友拍了拍你时，显示为「拍了拍我___」',
      initial: patSuffix,
      placeholder: '的脑袋',
      maxLength: PAT_SUFFIX_MAX,
      allowEmpty: true,
    });
    if (v == null) return;
    const next = v.trim().slice(0, PAT_SUFFIX_MAX);
    setPatSuffix(next);
    await repo.putSetting(PAT_SUFFIX_KEY, next);
  };

  const editAvatar = async () => {
    const i = await showActionSheet({ actions: ['从素材库选择', '更换头像颜色', '设置头像上的字'] });
    if (i === 0) setPicking(true);
    else if (i === 1) setPaletteOpen(true);
    else if (i === 2) {
      const v = await showPrompt({ title: '头像上的字（1-2 个）', initial: me.avatarText, maxLength: 2 });
      if (v != null && v.trim()) await save({ avatarText: v.trim().slice(0, 2) });
    }
  };

  return (
    <>
      <SubNav title="个人资料" />
      <div className="page-body settings">
        <div className="settings__group">
          <div className="settings__row settings__row--divided profile__avatar-row" role="button" onClick={() => void editAvatar()}>
            <span className="settings__label">头像</span>
            <Avatar color={me.avatarColor} text={me.avatarText} imageRef={me.avatarRef} size={64} />
            <span className="settings__chevron">›</span>
          </div>
          <LinkRow label="名字" value={me.name} onClick={() => void editName()} />
          <LinkRow label="拍一拍" value={patSuffix ? `拍了拍我${patSuffix}` : ''} onClick={() => void editPat()} />
          <LinkRow label="微信号" value={me.wxid} onClick={() => void editWxid()} />
          <LinkRow
            label="我的二维码"
            value={
              <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden className="profile__qr-glyph">
                <path
                  d="M2 2h5v5H2zM11 2h5v5h-5zM2 11h5v5H2zM11 11h2v2h-2zM14 14h2v2h-2zM11 14h2v2"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                />
              </svg>
            }
            to="/qrcode"
            last
          />
        </div>
      </div>

      {picking && (
        <MediaPicker
          kind="avatar"
          title="选择头像"
          allowClear
          onPick={(ref) => {
            setPicking(false);
            void save({ avatarRef: ref || undefined });
          }}
          onClose={() => setPicking(false)}
        />
      )}
      <Sheet open={paletteOpen} onClose={() => setPaletteOpen(false)} title="头像颜色">
        <div className="profile__palette">
          {AVATAR_PALETTE.map((c) => (
            <button
              key={c}
              className={`profile__swatch${me.avatarColor === c ? ' profile__swatch--active' : ''}`}
              style={{ background: c }}
              aria-label={`颜色 ${c}`}
              onClick={() => {
                setPaletteOpen(false);
                void save({ avatarColor: c });
              }}
            />
          ))}
        </div>
      </Sheet>
    </>
  );
}
