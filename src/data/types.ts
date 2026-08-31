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
  /** 星标朋友 (M-I6). Schema had the flag since M1; this is its first writer path. */
  isStarred?: boolean;
}

/**
 * A user-imported media item (runtime library, idb store `media`). Refs of the
 * form `idb:<id>` point here — see src/data/moments-images.ts for resolution.
 */
export interface MediaItemVM {
  id: string;
  /**
   * 'avatar' items feed the avatar picker; 'photo' items feed聊天/朋友圈配图;
   * 'sticker' items (M-I15) feed the composer's「我的表情」panel. Row-level
   * field — adding a kind needs NO idb migration, only UI awareness.
   */
  kind: 'avatar' | 'photo' | 'sticker';
  /** Free-form persona tags (风景/美食/自拍…). Empty = usable by everyone. */
  tags: string[];
  mime: string;
  blob: Blob;
  createdAt: number;
}

export type MessageType =
  | 'text'
  | 'image'
  | 'voice'
  | 'sticker'
  | 'rp'
  | 'transfer'
  | 'call'
  | 'system'
  /** 合并转发 card (M-I6). meta: { title, items: Array<{ name, body, at }> } */
  | 'merged'
  /** 位置卡片 (M-I13). content = 地名; meta: { name, address? }. 静态 SVG 简图，无外网瓦片。 */
  | 'location'
  /** 名片 (M-I13). meta: { contactId, name, wxid?, avatarColor?, avatarText? }; 点开进 /contact/:id。 */
  | 'contact_card'
  /** 假文件卡片 (M-I13). content = 文件名; meta: { fileName, sizeBytes, ext? }. 道具，不可下载。 */
  | 'file'
  /** 链接分享卡 (M-I13). content = 标题; meta: { title, summary? }. 缩略图为占位色块。 */
  | 'link'
  /** 表情游戏 (M-I13). meta: { game: 'dice' | 'rps', result }. 结果 seeded，落地即定，永不重掷。 */
  | 'game';

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
  /**
   * Story mode (V3): which script's run produced this message. The schema
   * columns (`story_script_id`, `story_seq`) existed since M1 with zero
   * writers; M-I7 finally writes them — every message appended while a story
   * beat is playing carries the run's script id and the beat's seq, so a
   * transcript line can be traced to the exact幕 that caused it.
   */
  storyScriptId?: string;
  /** Beat counter at the moment this message landed. See storyScriptId. */
  storySeq?: number;
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
  /**
   * 表情使用率 (M-I18), 0..1 — how sticker-happy this character is.
   *
   * A persona trait exactly like `momentsPerDay` / `likeRate` / `commentRate`,
   * and for the same reason: 话痨爱斗图的 and 高冷的 must not share one global
   * constant. `STICKER_RATE_BASELINE` (0.35) is the neutral point — the rate
   * scales every seeded sticker gate (斗图 urge, custom-sticker swap) and tells
   * the prompt layer whether to say anything about stickers at all.
   */
  stickerRate: number;
  /** Starting closeness, 0..100. Scales like/comment rates and heartbeat warmth. */
  affinityInit: number;
  /**
   * How open-handed, 0..1. Scales both the odds of her sending money at all and
   * which rung of the amount ladder she picks. 0 = never sends any.
   */
  generosity: number;
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
  /**
   * Who/what the fact is about (schema column since M1, first used in M-E2).
   * Free text — a display name or a noun, not an internal id — because facts
   * are about "他妹妹" and "那家咖啡店" as often as about a contact.
   */
  aboutId?: string;
  /**
   * Character-trigram term vector for BM25 retrieval (`embedding` column, which
   * the schema reserved for a real embedding we still cannot compute offline).
   * Serialized by `entity-graph.encodeVector`; recomputed on the fly when absent,
   * so an older row is never wrong, only slower.
   */
  embedding?: string;
  /** Set when a newer fact contradicts this one; the row is archived, not deleted. */
  supersededBy?: string;
  /** Story mode: which run wrote this (schema column since M1). */
  storySaveId?: string;
  /**
   * `scriptId#seq` — the tag rollback finds rows by. Without it a story-written
   * fact is indistinguishable from something the user actually said, and would
   * survive a rollback forever ("the character remembers a future that no
   * longer happens").
   */
  storyTag?: string;
}

/**
 * A favorited message (收藏, M-I13). A SNAPSHOT, not a reference: WeChat keeps
 * a favorite alive after the source message is deleted or its thread is gone,
 * so the row copies everything the favorites page renders. `msgId`/`convId`
 * remain for provenance (and for the hidden-conversation filter in the repo).
 */
export interface FavoriteVM {
  /** `fav_${convId}_${msgId}` — favoriting the same message twice is idempotent. */
  id: string;
  msgId: number;
  convId: string;
  senderId: string;
  /** Display name at favoriting time (remark-aware). */
  senderName: string;
  /** Conversation title at favoriting time. */
  convTitle: string;
  type: MessageType;
  content?: string;
  meta?: Record<string, unknown>;
  /** When the original message was sent. */
  createdAt: number;
  /** When the user favorited it (sort key of the favorites page). */
  favedAt: number;
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
 * WeChat's four audiences for a post (M-I18).
 *
 * `public`   公开        — everyone
 * `private`  私密        — the author only
 * `include`  部分可见    — `ids` is a WHITELIST
 * `exclude`  不给谁看    — `ids` is a BLACKLIST
 */
export type MomentAudience = 'public' | 'private' | 'include' | 'exclude';

/**
 * Who may see one post. Absent on a row = 公开 (every pre-M-I18 post, and every
 * post an AI writes — agents post to everyone).
 *
 * `ids` are contactIds and are only meaningful for include/exclude; the other
 * two modes carry an empty list rather than an absent one so the JSON column
 * has exactly one shape.
 */
export interface MomentVisibility {
  mode: MomentAudience;
  ids: string[];
}

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
  /** Story mode: which run caused this post. */
  storySaveId?: string;
  /** `scriptId#seq` — see MemoryFactVM.storyTag. Rollback finds posts by this. */
  storyTag?: string;
  /**
   * 转发 (M-I15): ROOT original's id — chains collapse, a repost of a repost
   * still points at the first post. Quote content may ONLY be derived from a
   * stored feed row (src/ai/moment-repost.ts is the sole builder); that is the
   * structural guarantee that hidden-conversation content can never ride a
   * repost chain onto the feed.
   */
  repostOf?: string;
  /** Snapshot of the original author, so a deleted original still renders. */
  repostAuthorId?: string;
  /** Snapshot excerpt of the original's text (built by repostExcerpt, capped). */
  repostExcerpt?: string;
  /**
   * 可见范围 (M-I18). Absent = 公开. Enforced in the DATA layer
   * (`src/lib/moment-visibility.ts`, applied inside the Repo drivers and inside
   * the reaction planner) rather than by whoever renders the feed — the whole
   * point is that a caller who forgets cannot leak the post.
   */
  visibility?: MomentVisibility;
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
