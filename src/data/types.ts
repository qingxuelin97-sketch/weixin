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
  avatarColor: string; // placeholder avatar tint until a real image is assigned
  avatarText: string; // 1-2 chars shown on placeholder avatar
  /** Media-library ref (`idb:<id>`) for a real avatar image; color/text remain the fallback. */
  avatarRef?: string;
  signature?: string;
  wxid?: string;
  pinyinInitial?: string;
}

/**
 * A user-imported media item (runtime library, idb store `media`). Refs of the
 * form `idb:<id>` point here — see src/data/moments-images.ts for resolution.
 */
export interface MediaItemVM {
  id: string;
  /** 'avatar' items feed the avatar picker; 'photo' items feed聊天/朋友圈配图. */
  kind: 'avatar' | 'photo';
  /** Free-form persona tags (风景/美食/自拍…). Empty = usable by everyone. */
  tags: string[];
  mime: string;
  blob: Blob;
  createdAt: number;
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
  /** Group membership (AI contactIds; the user is implicit). V1 caps at 4 AI. */
  memberIds?: string[];
  isPinned: boolean;
  isMuted: boolean;
  /**
   * Hidden conversations (AI↔AI DMs) never surface in the chat list, unread
   * counts, tab badge, or search — the user senses them only through their
   * effects (gossip in group chat). Leaking one is an irreversible tell.
   */
  isHidden?: boolean;
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
  /** How fast this persona grabs red packets — gives grabbing a personality. */
  grabSpeed?: 'fast' | 'mid' | 'slow';
  modelChat?: string; // provider:model, null → global default
  /** MiniMax TTS voice id for this persona's voice messages. */
  ttsVoice?: string;
  temperature: number;
  nsfwPermit: boolean;
  nsfwStyleSamples?: string[];
  greeting?: string;
  /** Moments posting rate, posts per day (0.3 ≈ twice a week). 0 = never posts. */
  momentsPerDay: number;
  /** Base probability this persona likes a given post, before affinity scaling. */
  likeRate: number;
  /** Base probability this persona comments on a given post. */
  commentRate: number;
  /** Starting closeness, 0..100. Scales like/comment rates and heartbeat warmth. */
  affinityInit: number;
  /**
   * Media-library tags this persona draws配图 from (吃货人设发健身照=秒穿帮).
   * Empty = draws from the whole photo pool.
   */
  imageTags: string[];
  /**
   * Who this persona is to others. Key 'user' or a contactId; value is the
   * relationship in their own words. Feeds the prompt's relations layer —
   * agents knowing each other is the precondition for any chemistry.
   */
  relations: Record<string, string>;
}

/** A red packet (拼手气 or 普通). Shares are pre-split at creation for replayability. */
export interface RedPacketVM {
  id: string;
  convId: string;
  senderId: string;
  totalFen: number;
  count: number;
  kind: 'lucky' | 'normal';
  greeting: string;
  /** Pre-computed shares (sums exactly to totalFen); claims consume them in order. */
  sharesFen: number[];
  status: 'active' | 'done' | 'expired';
  createdAt: number;
}

export interface RpClaimVM {
  id: string; // `${rpId}:${claimerId}`
  rpId: string;
  claimerId: string;
  amountFen: number;
  isBest: boolean;
  claimedAt: number;
}

export interface TransferVM {
  id: string;
  convId: string;
  fromId: string;
  toId: string;
  amountFen: number;
  note?: string;
  status: 'pending' | 'accepted' | 'returned' | 'expired';
  acceptedAt?: number;
  createdAt: number;
}

/** Wallet ledger entry. amountFen is signed; balanceAfterFen is denormalized. */
export interface WalletTxVM {
  id: string;
  kind: 'rp_in' | 'rp_out' | 'transfer_in' | 'transfer_out' | 'adjust';
  amountFen: number;
  refId?: string;
  title: string;
  balanceAfterFen: number;
  createdAt: number;
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
  /** Where the fact came from (schema column, exposed M-D2). hearsay = gossip. */
  source?: 'chat' | 'manual' | 'hearsay' | 'story';
  /** 0..1; hearsay lands at 0.4, direct chat extraction at 0.9. */
  confidence?: number;
  /** Times this fact was injected into a prompt that produced a reply. */
  refCount?: number;
}

/** One rolling summary per conversation (conv_summaries store). */
export interface ConvSummaryVM {
  convId: string;
  summary: string;
  /** Newest message id covered by this summary. */
  uptoMsgId: number;
  updatedAt: number;
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

/* ---- Moments (朋友圈) ---- */

/**
 * A Moments post. Authored by 'self' or an AI contact.
 *
 * `imageRefs` are keys into the image pool (see src/lib/moments-assets.ts), not
 * URLs — that way a post survives swapping placeholder art for real PNGs later.
 *
 * Moments are unconditionally SFW regardless of the global NSFW tier: the feed is
 * the one surface where a stray explicit post would be jarring rather than opt-in.
 * `isNsfw` exists only to mirror the SQLite column; nothing sets it true today.
 */
export interface MomentVM {
  id: string;
  authorId: string;
  text?: string;
  imageRefs: string[];
  isNsfw: boolean;
  createdAt: number;
}

/** A like. `id` is `${momentId}:${contactId}` — one like per person per moment. */
export interface MomentLikeVM {
  id: string;
  momentId: string;
  contactId: string;
  createdAt: number;
}

export interface MomentCommentVM {
  id: string;
  momentId: string;
  authorId: string;
  replyToCommentId?: string;
  text: string;
  createdAt: number;
}
