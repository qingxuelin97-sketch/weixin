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

/** NSFW tier for an agent/conversation. */
export type NsfwTierVM = 'off' | 'ambiguous' | 'full';

/** AI persona card (editable). Mirrors src/db/schema.ts personas, VM-shaped. */
export interface PersonaVM {
  contactId: string;
  core: string;
  speechStyle?: string;
  fewShots: string[]; // 3-5 exemplar short messages
  catchphrases: string[];
  activeHours: Array<[number, number]>; // e.g. [[9, 23]]
  proactivity: number; // 0..1
  typingCpm: number;
  heartbeatBaseMin: number;
  modelChat?: string; // provider:model, null → global default
  temperature: number;
  nsfwPermit: boolean;
  nsfwStyleSamples?: string[];
  greeting?: string;
}

/** Extracted long-term memory fact. */
export interface MemoryFactVM {
  id: string;
  subjectId: string; // whose memory (an AI contactId)
  fact: string;
  importance: number; // 1..5
  sensitivity: 'normal' | 'sensitive' | 'nsfw';
  evidenceMsgIds: number[];
  status: 'pending' | 'confirmed' | 'archived';
  isPinned: boolean;
  createdAt: number;
  lastRefAt?: number;
}

/** Configured LLM provider slot (the real key lives in secure storage, not here). */
export interface ProviderVM {
  id: string;
  kind: 'deepseek' | 'minimax' | 'zen' | 'custom';
  label: string;
  baseUrl: string;
  fallbackBaseUrl?: string;
  keyAlias: string; // handle into keystore
  models: string[];
  enabled: boolean;
}
