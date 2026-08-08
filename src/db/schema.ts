/**
 * Drizzle schema — the SINGLE source of truth for the local SQLite database.
 * Driver-agnostic: the same schema compiles for @capacitor-community/sqlite (APK)
 * and wa-sqlite/OPFS (Web/PWA). See specs/data-schema.md for invariants.
 *
 * Conventions:
 *  - `messages.id` is an INTEGER rowid (autoincrement) so, within a conversation,
 *    rowid order == time order. Everything else uses TEXT UUIDs.
 *  - Money is always an INTEGER count of 分 (fen / cents). Never floats.
 *  - Timestamps are epoch milliseconds (INTEGER).
 *  - Volatile / evolving structures live in JSON TEXT columns (suffix `Json`) so
 *    they evolve without a migration; parsers MUST tolerate unknown keys.
 */
import { sqliteTable, text, integer, real, index, primaryKey } from 'drizzle-orm/sqlite-core';

/** Contacts: the user themselves (`self`) and every AI persona-backed friend. */
export const contacts = sqliteTable(
  'contacts',
  {
    id: text('id').primaryKey(),
    type: text('type', { enum: ['self', 'ai'] }).notNull(),
    name: text('name').notNull(),
    remark: text('remark'), // user-set alias (备注)
    avatarRef: text('avatar_ref'), // relative media path, null = generated placeholder
    signature: text('signature'), // 个性签名
    wxid: text('wxid'), // display-only 微信号
    pinyinInitial: text('pinyin_initial'), // precomputed A-Z index letter for 通讯录
    gender: text('gender', { enum: ['male', 'female', 'other'] }).default('other'),
    region: text('region'),
    isStarred: integer('is_starred', { mode: 'boolean' }).notNull().default(false),
    isHidden: integer('is_hidden', { mode: 'boolean' }).notNull().default(false), // NSFW hidden-friend
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({ byPinyin: index('idx_contacts_pinyin').on(t.pinyinInitial) }),
);

/** AI persona card (1:1 with an `ai` contact). Static config; runtime state lives in agent_state. */
export const personas = sqliteTable('personas', {
  contactId: text('contact_id')
    .primaryKey()
    .references(() => contacts.id, { onDelete: 'cascade' }),
  core: text('core').notNull(), // core persona description
  speechStyle: text('speech_style'),
  fewShotsJson: text('few_shots_json'), // string[] of 3-5 exemplar short messages
  catchphrasesJson: text('catchphrases_json'), // string[]
  stickerTagsJson: text('sticker_tags_json'), // string[] semantic sticker prefs
  relationsJson: text('relations_json'), // { user: string, [aiId]: string }
  activeHoursJson: text('active_hours_json'), // [[startHour, endHour], ...]
  proactivity: real('proactivity').notNull().default(0.5), // 0..1
  heartbeatBaseMin: integer('heartbeat_base_min').notNull().default(240),
  momentsPerDay: real('moments_per_day').notNull().default(0.3),
  likeRate: real('like_rate').notNull().default(0.5),
  commentRate: real('comment_rate').notNull().default(0.25),
  typingCpm: integer('typing_cpm').notNull().default(300), // chars/min for typing-delay sim
  grabSpeed: text('grab_speed', { enum: ['fast', 'mid', 'slow'] }).default('mid'), // red-packet grab
  modelChat: text('model_chat'), // null → global default
  modelNsfw: text('model_nsfw'), // null → global permissive route
  ttsVoice: text('tts_voice'),
  temperature: real('temperature').default(0.8),
  nsfwPermit: integer('nsfw_permit', { mode: 'boolean' }).notNull().default(false),
  nsfwStyleSamplesJson: text('nsfw_style_samples_json'), // optional string[2]
  affinityInit: integer('affinity_init').notNull().default(20),
  affinityBaseline: integer('affinity_baseline').notNull().default(20),
  greeting: text('greeting'),
  storyRolesJson: text('story_roles_json'),
  extensionsJson: text('extensions_json'), // preserve unknown ST-V2 fields verbatim
  version: integer('version').notNull().default(1),
});

/** Runtime scheduling state, split from personas so editing a card never disturbs scheduling. */
export const agentState = sqliteTable('agent_state', {
  contactId: text('contact_id')
    .primaryKey()
    .references(() => contacts.id, { onDelete: 'cascade' }),
  nextWakeAt: integer('next_wake_at'),
  cooldownUntil: integer('cooldown_until'),
  consecCount: integer('consec_count').notNull().default(0),
  lastActiveAt: integer('last_active_at'),
});

/** Conversation list rows. Denormalized preview columns → list renders with zero joins. */
export const conversations = sqliteTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    type: text('type', { enum: ['single', 'group'] }).notNull(),
    peerId: text('peer_id'), // contactId for single chats
    title: text('title'),
    avatarRef: text('avatar_ref'),
    bgRef: text('bg_ref'), // chat background
    isPinned: integer('is_pinned', { mode: 'boolean' }).notNull().default(false),
    isMuted: integer('is_muted', { mode: 'boolean' }).notNull().default(false),
    unreadCount: integer('unread_count').notNull().default(0),
    mentionMe: integer('mention_me', { mode: 'boolean' }).notNull().default(false),
    draft: text('draft'),
    lastMsgPreview: text('last_msg_preview'),
    lastMsgAt: integer('last_msg_at'),
  },
  (t) => ({ byLastMsg: index('idx_conv_last_msg').on(t.lastMsgAt) }),
);

export const groupMembers = sqliteTable(
  'group_members',
  {
    convId: text('conv_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    contactId: text('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    groupNick: text('group_nick'),
    role: text('role', { enum: ['owner', 'admin', 'member'] }).default('member'),
    joinedAt: integer('joined_at').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.convId, t.contactId] }) }),
);

/**
 * Messages. INTEGER autoincrement id preserves per-conversation time order.
 * Cursor pagination: `WHERE conv_id=? AND id<:cursor ORDER BY id DESC LIMIT 30`.
 */
export const messages = sqliteTable(
  'messages',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    convId: text('conv_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'cascade' }),
    senderId: text('sender_id').notNull(), // contactId; 'self' for the user
    type: text('type', {
      enum: ['text', 'image', 'voice', 'sticker', 'rp', 'transfer', 'call', 'system'],
    }).notNull(),
    content: text('content'), // text body / caption / transcript
    metaJson: text('meta_json'), // type-specific: {w,h,thumbRef} | {duration,voiceId} | ...
    refId: text('ref_id'), // → red_packets / transfers / media_assets
    replyToId: integer('reply_to_id'), // quoted message id
    mentionsJson: text('mentions_json'), // contactId[]
    status: text('status', { enum: ['sending', 'sent', 'failed'] })
      .notNull()
      .default('sent'),
    isRecalled: integer('is_recalled', { mode: 'boolean' }).notNull().default(false),
    isNsfw: integer('is_nsfw', { mode: 'boolean' }).notNull().default(false),
    // (scriptId, seq) tag reserved for V3 story mode; present now for zero-migration.
    storyScriptId: text('story_script_id'),
    storySeq: integer('story_seq'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({
    byConvId: index('idx_msg_conv_id').on(t.convId, t.id),
  }),
);

export const mediaAssets = sqliteTable('media_assets', {
  id: text('id').primaryKey(),
  kind: text('kind', {
    enum: ['avatar', 'sticker', 'chat_img', 'chat_thumb', 'moment', 'voice', 'tts', 'bg'],
  }).notNull(),
  relPath: text('rel_path').notNull(),
  w: integer('w'),
  h: integer('h'),
  bytes: integer('bytes'),
  sha1: text('sha1'),
  pinned: integer('pinned', { mode: 'boolean' }).notNull().default(false),
  lastAccessAt: integer('last_access_at'),
});

/* ---- Moments (朋友圈) — schema present now, feature ships M4 ---- */
export const moments = sqliteTable('moments', {
  id: text('id').primaryKey(),
  authorId: text('author_id').notNull(),
  text: text('text'),
  imageRefsJson: text('image_refs_json'),
  isNsfw: integer('is_nsfw', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
});
export const momentLikes = sqliteTable(
  'moment_likes',
  {
    momentId: text('moment_id')
      .notNull()
      .references(() => moments.id, { onDelete: 'cascade' }),
    contactId: text('contact_id').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.momentId, t.contactId] }) }),
);
export const momentComments = sqliteTable('moment_comments', {
  id: text('id').primaryKey(),
  momentId: text('moment_id')
    .notNull()
    .references(() => moments.id, { onDelete: 'cascade' }),
  authorId: text('author_id').notNull(),
  replyToCommentId: text('reply_to_comment_id'),
  text: text('text').notNull(),
  createdAt: integer('created_at').notNull(),
});

/* ---- Money: red packets, transfers, wallet ---- */
export const redPackets = sqliteTable('red_packets', {
  id: text('id').primaryKey(),
  convId: text('conv_id').notNull(),
  senderId: text('sender_id').notNull(),
  totalFen: integer('total_fen').notNull(),
  count: integer('count').notNull(),
  kind: text('kind', { enum: ['lucky', 'normal'] }).notNull(),
  greeting: text('greeting'),
  status: text('status', { enum: ['active', 'done', 'expired'] })
    .notNull()
    .default('active'),
  expiresAt: integer('expires_at'),
  createdAt: integer('created_at').notNull(),
});
export const rpClaims = sqliteTable(
  'rp_claims',
  {
    rpId: text('rp_id')
      .notNull()
      .references(() => redPackets.id, { onDelete: 'cascade' }),
    claimerId: text('claimer_id').notNull(),
    amountFen: integer('amount_fen').notNull(),
    isBest: integer('is_best', { mode: 'boolean' }).notNull().default(false),
    claimedAt: integer('claimed_at').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.rpId, t.claimerId] }) }),
);
export const transfers = sqliteTable('transfers', {
  id: text('id').primaryKey(),
  convId: text('conv_id').notNull(),
  fromId: text('from_id').notNull(),
  toId: text('to_id').notNull(),
  amountFen: integer('amount_fen').notNull(),
  note: text('note'),
  status: text('status', { enum: ['pending', 'accepted', 'returned', 'expired'] })
    .notNull()
    .default('pending'),
  acceptedAt: integer('accepted_at'),
  createdAt: integer('created_at').notNull(),
});
export const walletTx = sqliteTable('wallet_tx', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['rp_in', 'rp_out', 'transfer_in', 'transfer_out', 'adjust'] }).notNull(),
  amountFen: integer('amount_fen').notNull(), // signed
  refId: text('ref_id'),
  balanceAfterFen: integer('balance_after_fen').notNull(), // denormalized for 零钱明细
  createdAt: integer('created_at').notNull(),
});

/* ---- Memory & summaries ---- */
export const memoryFacts = sqliteTable(
  'memory_facts',
  {
    id: text('id').primaryKey(),
    subjectId: text('subject_id').notNull(), // whose memory this is (an AI contactId)
    aboutId: text('about_id'), // who the fact is about
    fact: text('fact').notNull(), // ≤50 chars
    importance: integer('importance').notNull().default(3), // 1..5
    sensitivity: text('sensitivity', { enum: ['normal', 'sensitive', 'nsfw'] })
      .notNull()
      .default('normal'),
    scope: text('scope').notNull().default('private'), // private:aiId | group:gid | public | story:id
    source: text('source', { enum: ['chat', 'manual', 'hearsay', 'story'] })
      .notNull()
      .default('chat'),
    storySaveId: text('story_save_id'), // set when source=story
    evidenceMsgIdsJson: text('evidence_msg_ids_json'), // number[]; empty → discard on extract
    embedding: text('embedding'), // reserved (V2 embo-01); null in V1
    status: text('status', { enum: ['pending', 'confirmed', 'archived'] })
      .notNull()
      .default('pending'),
    confidence: real('confidence').notNull().default(0.6),
    isPinned: integer('is_pinned', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
    lastRefAt: integer('last_ref_at'),
    refCount: integer('ref_count').notNull().default(0),
  },
  (t) => ({
    bySubject: index('idx_mem_subject').on(t.subjectId, t.status),
  }),
);

/** Relationship edges (directional): familiarity monotonic-up, affinity bounded. */
export const relationshipEdges = sqliteTable(
  'relationship_edges',
  {
    fromId: text('from_id').notNull(),
    toId: text('to_id').notNull(),
    familiarity: integer('familiarity').notNull().default(0), // 0..100
    affinity: integer('affinity').notNull().default(20), // -100..100
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.fromId, t.toId] }) }),
);

export const convSummaries = sqliteTable('conv_summaries', {
  convId: text('conv_id').primaryKey(),
  uptoMsgId: integer('upto_msg_id').notNull(),
  summary: text('summary').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

/* ---- Story mode (V3 feature; schema present now) ---- */
export const storyScripts = sqliteTable('story_scripts', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  genre: text('genre'),
  nsfwLevel: integer('nsfw_level').notNull().default(0), // 0 off | 1 暧昧 | 2 全开
  dagJson: text('dag_json').notNull(),
  rolesJson: text('roles_json'),
  createdAt: integer('created_at').notNull(),
});
export const storySaves = sqliteTable('story_saves', {
  id: text('id').primaryKey(),
  scriptId: text('script_id')
    .notNull()
    .references(() => storyScripts.id, { onDelete: 'cascade' }),
  name: text('name'),
  activeNodesJson: text('active_nodes_json'),
  gmStateJson: text('gm_state_json'),
  roleBindingsJson: text('role_bindings_json'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
});

/**
 * Every kind of thing that can happen on its own schedule.
 *
 * THIS IS THE ONE LIST. `ActionKind` in src/ai/scheduler.ts is derived from it,
 * so the runtime union and the persisted column can no longer drift apart — they
 * did once already (the column said `comment` while the code wrote
 * `moment_comment`, and `transfer_accept` was missing from the column entirely).
 *
 * `story_tick` is reserved for V3 and has no handler yet; an unhandled kind is
 * dropped by the executor rather than throwing.
 */
export const SCHEDULED_ACTION_KINDS = [
  'heartbeat',
  'rp_grab',
  'transfer_accept',
  'moment_post',
  'moment_like',
  'moment_comment',
  'group_msg',
  'agent_dm',
  'recall',
  'story_tick',
] as const;

export type ScheduledActionKind = (typeof SCHEDULED_ACTION_KINDS)[number];

/**
 * The single persisted queue that IS the time-evolution engine. Heartbeats,
 * staggered likes/comments, 1-8s red-packet grabs, recalls, offline backfill —
 * all live here. Executing every past-due row, using fire_at as the message
 * timestamp, IS backfill. There is no second time-evolution code path.
 */
export const scheduledActions = sqliteTable(
  'scheduled_actions',
  {
    id: text('id').primaryKey(),
    fireAt: integer('fire_at').notNull(),
    kind: text('kind', { enum: SCHEDULED_ACTION_KINDS }).notNull(),
    payloadJson: text('payload_json'),
    status: text('status', { enum: ['pending', 'done', 'cancelled'] })
      .notNull()
      .default('pending'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => ({ byDue: index('idx_sched_due').on(t.status, t.fireAt) }),
);

/* ---- Providers & settings. Real API keys NEVER live here (Keystore only). ---- */
export const providers = sqliteTable('providers', {
  id: text('id').primaryKey(),
  kind: text('kind').notNull(), // 'deepseek' | 'minimax' | 'zen' | 'custom'
  label: text('label').notNull(),
  baseUrl: text('base_url').notNull(),
  fallbackBaseUrl: text('fallback_base_url'),
  keyAlias: text('key_alias'), // handle into secure storage; NOT the key itself
  modelsCacheJson: text('models_cache_json'),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
});
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  valueJson: text('value_json'),
});

export type Contact = typeof contacts.$inferSelect;
export type Persona = typeof personas.$inferSelect;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type MemoryFact = typeof memoryFacts.$inferSelect;
export type ScheduledAction = typeof scheduledActions.$inferSelect;
export type Provider = typeof providers.$inferSelect;
