/**
 * Contact profile card (资料卡) — WeChat never drops you from the contact list
 * straight into an editor, and now neither do we: this card fronts every AI
 * contact with the actions that matter (发消息 / 通话 / 编辑人设 / 记忆).
 *
 * M-K8 laid it out the way WeChat 8.0 does: white cell groups on the grey page
 * (the page used to be white end to end, so the groups had nothing between
 * them), 「昵称：本名」under a remark, the 朋友圈 row carrying her latest photos,
 * 人设 as a row of its own instead of a loose grey paragraph, and the two
 * actions — 发消息 / 音视频通话 — at the BOTTOM with their icons, the call
 * asking video-or-voice exactly as the chat's ＋ panel does.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { SubNav } from '../../components/SubNav';
import { parseTags, permLabel } from '../../lib/friend-perms';
import { liveStatus, statusLabel } from '../../lib/status';
import { useNow } from '../../lib/useNow';
import '../me/me.css';
import { Avatar } from '../../components/Avatar';
import { FLIP_KEYS } from '../../lib/flip';
import { useFlipEnter } from '../../lib/useFlipEnter';
import { useAppStore } from '../../store/appStore';
import { showActionSheet, showConfirm, showPrompt } from '../../components/dialog';
import { Switch } from '../../components/Switch';
import { IconComment, IconVideoCall } from '../../components/icons';
import { useMedia } from '../../components/useMedia';
import { resolveImageRef } from '../../data/moments-images';
import { repo } from '../../db/repo';
import type { ConversationVM } from '../../data/types';
import { useGuard } from '../../app/useGuard';
import './contacts.css';

export function ContactProfilePage() {
  const guard = useGuard();
  const { contactId = '' } = useParams();
  const navigate = useNavigate();
  /**
   * 共享元素转场 (M-I8): the 64px avatar here grows out of the 40px avatar in
   * the row that was tapped. `useFlipEnter` claims the rect the contacts list
   * left behind; arriving any other way (search, a 名片 bubble, a deep link)
   * finds nothing parked and the card simply appears.
   */
  const avatarRef = useRef<HTMLDivElement>(null);
  useFlipEnter(FLIP_KEYS.contactAvatar(contactId), avatarRef);
  const contact = useAppStore((s) => s.contactById(contactId));
  const persona = useAppStore((s) => s.personaFor(contactId));
  const conversations = useAppStore((s) => s.conversations);
  const tags = useAppStore((s) => s.contactTags);
  const perms = useAppStore((s) => s.friendPerms);
  const setContactTags = useAppStore((s) => s.setContactTags);
  const statuses = useAppStore((s) => s.statuses);
  const now = useNow();
  const herStatus = liveStatus(statuses, contactId, now);
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

  // 朋友圈缩略图 (M-K8): her newest photos, up to four — the most recognisable
  // row on a WeChat profile. Read through the same author query the album page
  // uses, so 不看她 / 可见范围 filter here exactly as they do there.
  const [thumbs, setThumbs] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    void repo
      .getMomentsByAuthor(contactId)
      .then((ms) => {
        if (alive) setThumbs(ms.flatMap((m) => m.imageRefs).slice(0, 4));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [contactId]);
  useMedia(thumbs);

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
  const ensureConv = async (): Promise<ConversationVM> => {
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
    return conv;
  };
  const openChat = async () => navigate(`/chat/${(await ensureConv()).id}`);

  /**
   * 音视频通话 (M-K8): WeChat's profile row asks which kind, like the chat's ＋
   * panel (M-J6). It used to read 语音通话 and, with no conversation yet, drop
   * you into the CHAT instead of the call; the conversation is now created and
   * the call placed.
   */
  const startCall = async () => {
    const i = await showActionSheet({ actions: ['视频通话', '语音通话'] });
    if (i == null) return;
    const conv = await ensureConv();
    navigate(i === 0 ? `/call/${conv.id}?video=1` : `/call/${conv.id}`);
  };

  return (
    <>
      <SubNav title="" />
      <div className="page-body contacts contact-card">
        <div className="contact-card__head">
          {/* The wrapper is the flip target: it is what the row's avatar rect
              is measured against, and putting the ref on <Avatar/> would mean
              threading one through a component every other call site shares. */}
          <div className="contact-card__avatar" ref={avatarRef}>
            <Avatar
              color={contact.avatarColor}
              text={contact.avatarText}
              imageRef={contact.avatarRef}
              size={64}
              // 状态圈 (M-J7): only when she actually has a live one — an
              // expired status draws nothing (liveStatus decides, not a timer).
              status={
                herStatus ? { tint: herStatus.option.tint, emoji: herStatus.option.emoji } : undefined
              }
            />
          </div>
          <div className="contact-card__id">
            <div className="contact-card__name">{contact.remark ?? contact.name}</div>
            {/* Under a remark, WeChat shows who they call themselves. */}
            {contact.remark && contact.remark !== contact.name && (
              <div className="contact-card__meta">昵称：{contact.name}</div>
            )}
            {herStatus && (
              <div
                className="contact-card__meta status-chip"
                style={{ '--chip-tint': `var(${herStatus.option.tint})` } as React.CSSProperties}
              >
                <span className="status-chip__emoji">{herStatus.option.emoji}</span>
                {statusLabel(herStatus)}
              </div>
            )}
            {contact.wxid && <div className="contact-card__meta">微信号：{contact.wxid}</div>}
            {contact.signature && <div className="contact-card__meta">个性签名：{contact.signature}</div>}
          </div>
        </div>

        <div className="settings__group">
          {/* 设置备注 (M-I18): `remark` was read in a dozen places — the chat
              title, the contacts list, moments, group nicknames — and written
              by nothing. WeChat puts this on the profile page and so do we. */}
          <div
            className="settings__row settings__row--divided"
            onClick={() =>
              guard('contact.remark', async () => {
                const next = await showPrompt({
                  title: '设置备注',
                  initial: contact.remark ?? '',
                  placeholder: contact.name,
                  maxLength: 24,
                  // Clearing the remark is a real intent (fall back to 本名).
                  allowEmpty: true,
                });
                if (next === null) return; // cancelled — leave it alone
                const remark = next.trim();
                await putContact({ ...contact, remark: remark || undefined });
              })
            }
          >
            <span className="settings__label">备注名</span>
            <span className="settings__value">{contact.remark ?? '未设置'}</span>
            <span className="settings__chevron">›</span>
          </div>
          {/* 设置标签 (M-J7). Free text rather than a picker: the tag set is
              derived from what people are tagged with, so a "create tag" step
              would be a second source for a list that already has one. */}
          <div
            className="settings__row settings__row--divided"
            onClick={() =>
              guard('contact.tags', async () => {
                const next = await showPrompt({
                  title: '设置标签',
                  initial: (tags[contactId] ?? []).join('、'),
                  placeholder: '用逗号分隔，如：同事, 球友',
                  maxLength: 60,
                  allowEmpty: true, // clearing every tag is a real intent
                });
                if (next === null) return;
                await setContactTags(contactId, parseTags(next));
              })
            }
          >
            <span className="settings__label">标签</span>
            <span className="settings__value">
              {(tags[contactId] ?? []).join('、') || '未设置'}
            </span>
            <span className="settings__chevron">›</span>
          </div>
          <div className="settings__row" onClick={() => navigate(`/contact/${contactId}/perm`)}>
            <span className="settings__label">朋友权限</span>
            <span className="settings__value">{permLabel(perms, contactId)}</span>
            <span className="settings__chevron">›</span>
          </div>
        </div>

        <div className="settings__group">
          {/* 个人相册 (M-I18): the album page existed since I15 but was only
              reachable by tapping an avatar inside the feed. M-K8: with her
              newest photos in the row, as on device. */}
          <div
            className="settings__row settings__row--divided contact-card__moments"
            onClick={() => navigate(`/moments/album/${contactId}`)}
          >
            <span className="settings__label contact-card__label">朋友圈</span>
            <span className="contact-card__thumbs">
              {thumbs.map((ref, i) => {
                const { url, background } = resolveImageRef(ref);
                return (
                  <span
                    key={`${ref}-${i}`}
                    className="contact-card__thumb"
                    style={background ? { background } : undefined}
                  >
                    {url && <img src={url} alt="" />}
                  </span>
                );
              })}
            </span>
            <span className="settings__chevron">›</span>
          </div>
          {/* 人设 (M-K8): a row of its own — the start of the persona card, and
              the way into editing it (this row replaced 「编辑人设」). */}
          <div className="settings__row contact-card__core-row" onClick={() => navigate(`/persona/${contactId}`)}>
            <span className="settings__label contact-card__label">人设</span>
            <span className="contact-card__core">{persona?.core || '未填写'}</span>
            <span className="settings__chevron">›</span>
          </div>
        </div>

        <div className="settings__group">
          {persona && (
            <div className="settings__row settings__row--divided" onClick={() => navigate(`/status/${contactId}`)}>
              <span className="settings__label">她的状态</span>
              <span className="settings__chevron">›</span>
            </div>
          )}
          <div className="settings__row settings__row--divided" onClick={() => navigate(`/memory/${contactId}`)}>
            <span className="settings__label">记忆管理</span>
            <span className="settings__chevron">›</span>
          </div>
          <div className="settings__row" onClick={() => guard('contact.star', toggleStar)}>
            <span className="settings__label">星标朋友</span>
            <Switch on={Boolean(contact.isStarred)} onChange={() => guard('contact.star', toggleStar)} />
          </div>
        </div>

        {/* The two actions sit at the bottom, as on device (M-K8). */}
        <div className="settings__group">
          <div
            className="settings__row settings__row--divided contact-card__action"
            onClick={() => guard('contact.openChat', openChat)}
          >
            <IconComment size={20} />
            发消息
          </div>
          <div className="settings__row contact-card__action" onClick={() => guard('contact.call', startCall)}>
            <IconVideoCall size={20} />
            音视频通话
          </div>
        </div>

        {contact.type === 'ai' && (
          <div className="settings__group">
            <div
              className="settings__row settings__row--danger"
              role="button"
              onClick={() => guard('contact.delete', removeContact)}
            >
              删除联系人
            </div>
          </div>
        )}
      </div>
    </>
  );
}
