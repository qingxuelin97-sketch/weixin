/**
 * UI view-model types. These are the shapes the React tree renders. They are a
 * thin projection of the Drizzle schema (src/db/schema.ts); the persistence layer
 * that maps rows → view models lands in M2. For M1 the store is seeded in-memory.
 */

export interface ContactVM {
  id: string;
  type: 'self' | 'ai';
  name: string;
  remark?: string;
  avatarColor: string; // placeholder avatar tint until PNG library arrives
  avatarText: string; // 1-2 chars shown on placeholder avatar
  signature?: string;
  wxid?: string;
  pinyinInitial?: string;
}

export type MessageType = 'text' | 'image' | 'voice' | 'sticker' | 'rp' | 'transfer' | 'call' | 'system';

export interface MessageVM {
  id: number;
  convId: string;
  senderId: string; // 'self' for the user
  type: MessageType;
  content?: string;
  /** voice: {durationMs}; rp: {greeting, opened}; transfer: {amountFen, note, status}; image: {w,h} */
  meta?: Record<string, unknown>;
  status: 'sending' | 'sent' | 'failed';
  isRecalled?: boolean;
  createdAt: number;
}

export interface ConversationVM {
  id: string;
  type: 'single' | 'group';
  peerId?: string;
  title: string;
  avatarColor: string;
  avatarText: string;
  memberAvatars?: Array<{ color: string; text: string }>; // group: composited 9-grid
  isPinned: boolean;
  isMuted: boolean;
  unreadCount: number;
  mentionMe: boolean;
  draft?: string;
  /** Group announcement pinned bar text (group chats only). */
  announcement?: string;
  lastMsgPreview: string;
  lastMsgAt: number;
}
