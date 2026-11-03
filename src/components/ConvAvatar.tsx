/**
 * 一个会话的头像 (M-L2，从会话列表抽出)：单聊画对方（真头像经联系人实时解析——换了头像
 * 每一行都跟着变，不用迁移数据），群聊画成员九宫格。会话列表与转发选择器共用这一份，
 * 两处画同一个会话不会长得不一样。
 */
import { Avatar } from './Avatar';
import { useAppStore } from '../store/appStore';
import type { ConversationVM } from '../data/types';

export function ConvAvatar({ conv, size }: { conv: ConversationVM; size: number }) {
  const contactById = useAppStore((s) => s.contactById);
  const peerRef = conv.type === 'single' && conv.peerId ? contactById(conv.peerId)?.avatarRef : undefined;
  const members = conv.memberAvatars?.map((m, i) => ({
    ...m,
    imageRef: conv.memberIds?.[i] ? contactById(conv.memberIds[i])?.avatarRef : undefined,
  }));
  return <Avatar color={conv.avatarColor} text={conv.avatarText} size={size} imageRef={peerRef} members={members} />;
}
