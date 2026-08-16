/**
 * Repository layer — the single door between the app and persistent storage.
 * M2 backs it with IndexedDB (src/db/idb.ts); M3 swaps in native SQLite behind
 * the SAME interface. Components/stores depend only on this interface.
 *
 * Data is stored VM-shaped (ContactVM/ConversationVM/MessageVM/...) because that
 * is what the UI renders; src/db/schema.ts remains the canonical relational shape
 * for the SQLite target.
 */
import type {
  ContactVM,
  ConversationVM,
  MessageVM,
  PersonaVM,
  MemoryFactVM,
  ProviderVM,
  RedPacketVM,
  RpClaimVM,
  TransferVM,
  WalletTxVM,
  MomentVM,
  MomentLikeVM,
  MomentCommentVM,
  MediaItemVM,
  ConvSummaryVM,
  FavoriteVM,
} from '../data/types';
import {
  idbGetAll,
  idbGet,
  idbPut,
  idbAdd,
  idbBulkAdd,
  idbDelete,
  idbBulkPut,
  idbCount,
  idbQueryByIndex,
  idbGetAllByIndex,
  idbDeleteByIndex,
  idbPageDesc,
  idbFirstByIndex,
} from './idb';

export interface Repo {
  // contacts & personas
  getContacts(): Promise<ContactVM[]>;
  getContact(id: string): Promise<ContactVM | undefined>;
  putContact(c: ContactVM): Promise<void>;
  /**
   * Delete a contact AND every trace of them the app would trip over later —
   * the first (and only) contact-deletion path in the codebase. See
   * `DELETE_CONTACT_CASCADE` for the per-store ledger and the guard test.
   */
  deleteContact(id: string): Promise<void>;
  getPersona(contactId: string): Promise<PersonaVM | undefined>;
  putPersona(p: PersonaVM): Promise<void>;

  // conversations
  getConversations(): Promise<ConversationVM[]>;
  getConversation(id: string): Promise<ConversationVM | undefined>;
  putConversation(c: ConversationVM): Promise<void>;
  deleteConversation(id: string): Promise<void>;

  // messages (autoincrement id; per-conversation cursor pagination)
  getMessages(convId: string, opts?: { limit?: number; beforeId?: number }): Promise<MessageVM[]>;
  /** Timestamp of the conversation's oldest message, or undefined when empty. */
  firstMessageAt(convId: string): Promise<number | undefined>;
  addMessage(msg: Omit<MessageVM, 'id'>): Promise<MessageVM>;
  updateMessage(msg: MessageVM): Promise<void>;
  deleteMessage(id: number): Promise<void>;

  // memory
  getMemory(subjectId: string): Promise<MemoryFactVM[]>;
  putMemory(f: MemoryFactVM): Promise<void>;
  deleteMemory(id: string): Promise<void>;
  getConvSummary(convId: string): Promise<ConvSummaryVM | undefined>;
  putConvSummary(s: ConvSummaryVM): Promise<void>;

  // providers & settings
  getProviders(): Promise<ProviderVM[]>;
  putProvider(p: ProviderVM): Promise<void>;
  deleteProvider(id: string): Promise<void>;
  getSetting<T>(key: string): Promise<T | undefined>;
  putSetting<T>(key: string, value: T): Promise<void>;

  // money: red packets, claims, transfers, wallet ledger
  getRedPacket(id: string): Promise<RedPacketVM | undefined>;
  putRedPacket(rp: RedPacketVM): Promise<void>;
  getClaims(rpId: string): Promise<RpClaimVM[]>;
  putClaim(c: RpClaimVM): Promise<void>;
  getTransfer(id: string): Promise<TransferVM | undefined>;
  putTransfer(t: TransferVM): Promise<void>;
  getWalletTxs(): Promise<WalletTxVM[]>;
  putWalletTx(t: WalletTxVM): Promise<void>;

  // moments
  /** Newest first. `before` paginates by createdAt for infinite scroll. */
  getMoments(opts?: { limit?: number; before?: number }): Promise<MomentVM[]>;
  /** Likes+comments for a page of posts in two queries rather than 2N. */
  getMomentSocial(momentIds: string[]): Promise<{ likes: Record<string, MomentLikeVM[]>; comments: Record<string, MomentCommentVM[]> }>;
  getMoment(id: string): Promise<MomentVM | undefined>;
  /** One person's whole timeline, newest first (个人相册页, M-I15). */
  getMomentsByAuthor(authorId: string): Promise<MomentVM[]>;
  putMoment(m: MomentVM): Promise<void>;
  getLikes(momentId: string): Promise<MomentLikeVM[]>;
  putLike(l: MomentLikeVM): Promise<void>;
  deleteLike(id: string): Promise<void>;
  getComments(momentId: string): Promise<MomentCommentVM[]>;
  putComment(c: MomentCommentVM): Promise<void>;
  /** Delete one comment (自己的评论, M-I6). */
  deleteComment(id: string): Promise<void>;
  /** Delete a post AND its social rows (自己的动态, M-I6). */
  deleteMoment(id: string): Promise<void>;

  // worldbook (M-I4): user-authored lore, matched into the prompt's memory layer
  getWorldbook(): Promise<import('../ai/worldbook').WorldbookEntry[]>;
  putWorldbookEntry(e: import('../ai/worldbook').WorldbookEntry): Promise<void>;
  deleteWorldbookEntry(id: string): Promise<void>;

  // favorites (收藏, M-I13). getFavorites filters hidden-conversation rows
  // INSIDE the repo — the same rule as search(): a UI that forgets cannot leak.
  getFavorites(): Promise<FavoriteVM[]>;
  putFavorite(f: FavoriteVM): Promise<void>;
  deleteFavorite(id: string): Promise<void>;

  // runtime media library (avatars + photo pools; see specs/data-schema.md)
  getMedia(kind?: MediaItemVM['kind']): Promise<MediaItemVM[]>;
  getMediaItem(id: string): Promise<MediaItemVM | undefined>;
  putMedia(item: MediaItemVM): Promise<void>;
  deleteMedia(id: string): Promise<void>;

  isEmpty(): Promise<boolean>;
}

/** IndexedDB-backed Repo (web / PWA driver). */
/**
 * Feed page size when a caller doesn't ask for one.
 *
 * `getMoments()` with no arguments used to mean "every post ever written".
 * Making the default a page is what stops an old install from paying for its
 * entire history every time the feed opens; the only reader that wants
 * everything is the backup exporter, and it reads the store directly.
 */
const DEFAULT_MOMENTS_PAGE = 60;

/**
 * The deleteContact ledger: EVERY object store, classified.
 *
 * 'cascade' — deleteContact removes (or patches away) this store's traces of
 * the contact. 'exempt' — deliberately untouched, with the reason beside it.
 * A guard test asserts this ledger covers exactly the stores mounted in
 * idb.ts, so adding a store without deciding what deletion means for it turns
 * the suite red (the same shape as the SCHEDULED_ACTION_KINDS ledger).
 */
export const DELETE_CONTACT_CASCADE: Record<string, 'cascade' | 'exempt'> = {
  contacts: 'cascade',
  personas: 'cascade',
  conversations: 'cascade', // the 1:1 thread, hidden DMs, group roster patches
  messages: 'cascade', // via deleteConversation of the dead threads
  memory_facts: 'cascade', // rows whose subject is the contact
  conv_summaries: 'cascade', // via deleteConversation
  scheduled_actions: 'cascade', // rows whose payload names the contact or a dead thread
  // One KV store doing the work of a dozen tables, so this one word is not
  // enough on its own — `SETTINGS_KEY_CASCADE` below classifies it key by key.
  settings: 'cascade',
  moments: 'cascade', // authored posts + their social rows
  moment_likes: 'cascade', // likes BY the contact anywhere, likes ON their posts
  moment_comments: 'cascade',
  providers: 'exempt', // app-level API config, not per-contact
  red_packets: 'exempt', // money is a LEDGER: deleting a person must not delete
  rp_claims: 'exempt', //   the record of money that actually moved (整数分不蒸发)
  transfers: 'exempt',
  wallet_tx: 'exempt',
  tts_cache: 'exempt', // content-addressed by text hash; harmless orphans, GC'd by size
  media: 'exempt', // the user's own library — avatars are assigned, not owned
  story_scripts: 'exempt', // scripts reference roles, not contact ids
  // Saves are NOT like scripts (M-I18). Since M-I7 gave story mode explicit
  // casting, a save row's `bindings` maps script charId → a REAL contactId, so
  // the old "roles, not contact ids" rationale stopped being true the day
  // casting shipped. Deleting a cast member used to leave the run bound to a
  // ghost: the GM would keep building a directive for a persona that no longer
  // exists and hand it to nobody.
  story_saves: 'cascade',
  worldbook: 'cascade', // persona-scoped entries die with their contact
  favorites: 'cascade', // snapshots FROM the contact (or their dead threads) go too
};

/**
 * Separator used by `pairKey()` (src/ai/relationship.ts) to fuse two ids into
 * one undirected edge key. It lives HERE, and relationship.ts imports it, so
 * the cascade's per-entry surgery on `rel_edges` cannot drift from the writer.
 */
export const REL_PAIR_SEP = '~';

/** How a settings key encodes what it belongs to. */
export type SettingsKeyScope =
  /** One row for the whole app; never owned by a contact. */
  | 'global'
  /** `<prefix><contactId>`. */
  | 'contact'
  /** `<prefix><convId>`. */
  | 'conv'
  /** `<prefix><fromId>:<toId>` — directional, matched from either side. */
  | 'pair';

export interface SettingsKeyRule {
  scope: SettingsKeyScope;
  /** What contact deletion does to the ROW itself. */
  row: 'cascade' | 'exempt';
  /**
   * Set when the row's VALUE is a map keyed by ids. Such a row belongs to
   * EVERYONE, so deleting it would take the survivors' data down with the
   * deleted contact — the cascade cuts out only their ENTRIES instead.
   * 'id' = plain contact ids; 'pair' = `pairKey()` pairs (`a~b`).
   */
  entries?: 'id' | 'pair';
  /** One line of reasoning. Mandatory: an unexplained 'exempt' is how a leak gets waved through. */
  why: string;
}

/**
 * The SECOND deleteContact ledger: every settings KEY, classified.
 *
 * `settings` is one flat KV store doing the work of a dozen tables, so
 * `DELETE_CONTACT_CASCADE.settings = 'cascade'` says almost nothing. It read as
 * "handled" while `agent_state:`, `goal_told:`, `giftAt:`, `callAt:`, `memext:`
 * and `groupNick:` all quietly survived deletion (M-I18 audit): a new
 * per-contact key needs neither a new object store nor a ledger edit to ship,
 * so nothing could turn red.
 *
 * Hence this table — and hence the cascade READS it instead of carrying its own
 * hand-written whitelist. Registering a prefix as contact/conv/pair + 'cascade'
 * is what MAKES deletion handle it. A guard test scans every
 * `putSetting`/`getSetting` key expression in src/ and asserts the two sets
 * match exactly, so an unregistered prefix is red before it can leak.
 *
 * Key = the exact key for 'global' rows, or the prefix INCLUDING its trailing
 * ':' for scoped ones.
 */
export const SETTINGS_KEY_CASCADE: Record<string, SettingsKeyRule> = {
  /* ---- per contact ---- */
  'affect:': { scope: 'contact', row: 'cascade', why: '事件情绪脉冲；人没了，脉冲没有主语' },
  'drift:': { scope: 'contact', row: 'cascade', why: '人设漂移累积量' },
  'threads:': { scope: 'contact', row: 'cascade', why: '已追问过的话头台账' },
  'goal_told:': {
    scope: 'contact',
    row: 'cascade',
    why: 'I14 目标结局「一辈子只播一次」台账；残留会让复用 id 的新人一出生就「已经播过了」',
  },
  'agent_state:': {
    scope: 'contact',
    row: 'cascade',
    why: 'I-H1 防刷屏冷却；残留会让复用 id 的新人一出生就在 24h 静默里',
  },

  /* ---- per conversation (deleted when that conversation dies with the contact) ---- */
  'convstate:': { scope: 'conv', row: 'cascade', why: '会话话题/未答问题/承诺，随会话消亡' },
  'topic:': { scope: 'conv', row: 'cascade', why: '群话题缓存，随会话消亡' },
  'groupCfg:': { scope: 'conv', row: 'cascade', why: '群配置，随会话消亡' },
  'groupBuild:': { scope: 'conv', row: 'cascade', why: '一键建群的断点状态，随会话消亡' },
  'giftAt:': { scope: 'conv', row: 'cascade', why: '上次送钱时间戳，随会话消亡' },
  'callAt:': { scope: 'conv', row: 'cascade', why: '上次来电时间戳，随会话消亡' },
  'memext:': { scope: 'conv', row: 'cascade', why: '记忆抽取水位（msgId），随会话消亡' },
  'groupNick:': {
    scope: 'conv',
    row: 'cascade',
    entries: 'id',
    // The group SURVIVES a member's deletion (step 4 only trims the roster), so
    // the row usually stays — but the dead member's alias inside it must not.
    why: '群昵称表：会话死则整行死；会话活着则只剔除死者那一条',
  },

  /* ---- per directional pair ---- */
  'stance:': { scope: 'pair', row: 'cascade', why: 'A 对 B 的单向态度' },
  'relarc:': { scope: 'pair', row: 'cascade', why: 'A 与 B 的关系弧标记' },

  /* ---- a global row that nonetheless carries per-contact ENTRIES ---- */
  rel_edges: {
    scope: 'global',
    row: 'exempt',
    entries: 'pair',
    why: '整张社交图存在一行里：删行=清空所有人的关系，所以按边删（见 deleteContactCascade 7.4）',
  },

  /* ---- global app config / bookkeeping: not per-contact at all ---- */
  defaultProviderId: { scope: 'global', row: 'exempt', why: 'App 级 LLM 配置' },
  nsfwProviderId: { scope: 'global', row: 'exempt', why: 'App 级 LLM 配置' },
  nsfwGlobalTier: { scope: 'global', row: 'exempt', why: 'App 级开关' },
  readReceipts: { scope: 'global', row: 'exempt', why: 'App 级开关' },
  notifyGranted: { scope: 'global', row: 'exempt', why: '系统权限状态' },
  notifyAsked: { scope: 'global', row: 'exempt', why: '系统权限状态' },
  nativeBubble: { scope: 'global', row: 'exempt', why: '原生特性开关' },
  nativeIncomingCall: { scope: 'global', row: 'exempt', why: '原生特性开关' },
  momentsSeenAt: { scope: 'global', row: 'exempt', why: '朋友圈红点水位' },
  momentsCoverRef: { scope: 'global', row: 'exempt', why: '本人朋友圈封面' },
  ttsModel: { scope: 'global', row: 'exempt', why: 'App 级 TTS 配置' },
  visionEnabled: { scope: 'global', row: 'exempt', why: 'App 级开关' },
  asrConfig: { scope: 'global', row: 'exempt', why: 'App 级 ASR 配置' },
  stickerSent: { scope: 'global', row: 'exempt', why: '本人发过的表情台账（主语是我，不是联系人）' },
  'usage:daily': { scope: 'global', row: 'exempt', why: '按天聚合的用量，键是日期不是 id' },
  lastSelftest: { scope: 'global', row: 'exempt', why: '自检结果' },
  lastForegroundAt: { scope: 'global', row: 'exempt', why: '回填屏障时间戳' },
  lastBackupAt: { scope: 'global', row: 'exempt', why: '备份时间戳' },
  autoBackupFreq: { scope: 'global', row: 'exempt', why: '备份配置' },
  autoBackupCounter: { scope: 'global', row: 'exempt', why: '备份计数器' },
  backupWatermarks: { scope: 'global', row: 'exempt', why: '按 store 名索引的增量水位，不含 id' },
  backupHistory: { scope: 'global', row: 'exempt', why: '备份文件清单' },
  groupBuildActive: {
    scope: 'global',
    row: 'exempt',
    why: '当前建群会话指针；值是 convId，但行本身是全局单例',
  },
  groupBuild: {
    scope: 'global',
    row: 'exempt',
    why: '一键建群的老单行状态，只在迁移到 groupBuild:<convId> 时读一次',
  },
  restoreInProgress: { scope: 'global', row: 'exempt', why: '恢复中断标记' },
  sqliteMigratedAt: { scope: 'global', row: 'exempt', why: 'IDB→SQLite 迁移完成时间' },
  sqliteMigrateProgress: { scope: 'global', row: 'exempt', why: 'IDB→SQLite 迁移断点' },
  __crypto_master: {
    scope: 'global',
    row: 'exempt',
    // Written straight to the store (idbPut) rather than through putSetting so
    // the live CryptoKey never round-trips through JSON. Deleting it would
    // brick every stored API key — see CLAUDE.md's CryptoKey trap.
    why: '设备本机主密钥；删它=所有已存 API key 永久解不开',
  },
};

/**
 * Store-level primitives the contact-deletion cascade needs beyond the Repo
 * interface itself. Each driver (IDB / SQLite) supplies its own, so the cascade
 * LOGIC exists exactly once and cannot drift between drivers — the same reason
 * `SCHEDULED_ACTION_KINDS` is one list.
 *
 * `scheduled_actions` primitives always hit IndexedDB in BOTH drivers: the
 * scheduler (src/ai/scheduler.ts) talks to IDB directly, so that queue lives
 * there regardless of which driver serves the Repo.
 */
export interface CascadeStoreOps {
  allScheduledActions(): Promise<Array<{ id: string; payloadJson: string }>>;
  deleteScheduledAction(id: string): Promise<void>;
  allSettingKeys(): Promise<string[]>;
  deleteSettingRow(key: string): Promise<void>;
  allMoments(): Promise<MomentVM[]>;
  allLikes(): Promise<MomentLikeVM[]>;
  allComments(): Promise<MomentCommentVM[]>;
  /** RAW rows — repo.getFavorites filters hidden convs, the cascade must not. */
  allFavorites(): Promise<FavoriteVM[]>;
  /**
   * Story saves, structurally typed. `src/db` must not import `src/ai` (the
   * dependency direction is one-way), and the cascade only needs the cast
   * binding — the index signature is what keeps the rest of the row intact on
   * write-back instead of truncating it to the three fields named here.
   */
  allStorySaves(): Promise<CascadeStoryRow[]>;
  putStorySave(row: CascadeStoryRow): Promise<void>;
  deletePersonaRow(contactId: string): Promise<void>;
  deleteContactRow(id: string): Promise<void>;
}

/** See `CascadeStoreOps.allStorySaves`. Mirrors `StorySaveRow` in src/ai/story-gm.ts. */
export interface CascadeStoryRow {
  id: string;
  bindings: Record<string, string>;
  isActive: boolean;
  [key: string]: unknown;
}

/**
 * The cascade. Ordered so an interruption leaves the WORLD consistent and
 * only the contact row itself possibly surviving (a re-run then finishes the
 * job): references to the contact go first, the contact goes last.
 */
export async function deleteContactCascade(
  repo: Repo,
  ops: CascadeStoreOps,
  id: string,
): Promise<void> {
  // 'self' is the user in every senderId; deleting it would be deleting the
  // account, which no UI offers and no cascade could make sensible.
  if (id === 'self' || id === 'user') throw new Error(`refusing to delete ${id}`);

  // 1) Threads that die with the contact: their 1:1 chat, and every hidden
  //    AI↔AI DM they are half of (`dm_a_b` rows are single+hidden with the
  //    pair in memberIds).
  const convs = await repo.getConversations();
  const dead = convs.filter(
    (c) =>
      c.type === 'single' &&
      (c.peerId === id || (c.isHidden && (c.memberIds ?? []).includes(id))),
  );
  const deadIds = new Set(dead.map((c) => c.id));

  // 2) Scheduled actions that name the contact or a dying thread. Payloads
  //    are JSON strings; ids never contain quotes, so a quoted-substring
  //    match is exact. Deleted rather than cancelled: a cancelled row still
  //    references a contact that no longer exists.
  const actions = await ops.allScheduledActions();
  for (const a of actions) {
    const hit =
      a.payloadJson.includes(`"${id}"`) ||
      [...deadIds].some((cid) => a.payloadJson.includes(`"${cid}"`));
    if (hit) await ops.deleteScheduledAction(a.id);
  }

  // 3) The dead threads themselves (messages + summaries + row).
  for (const c of dead) await repo.deleteConversation(c.id);

  // 4) Group rosters: the contact leaves every group they were in.
  for (const c of convs) {
    if (c.type === 'group' && c.memberIds?.includes(id)) {
      await repo.putConversation({ ...c, memberIds: c.memberIds.filter((m) => m !== id) });
    }
  }

  // 5) Memory about them (their own facts; group memories are the group's).
  for (const f of await repo.getMemory(id)) await repo.deleteMemory(f.id);

  // 6) Every OTHER persona forgets the relation edge — a per-edge patch,
  //    never a rebuilt relations map (CLAUDE.md: makePersona resets).
  const contacts = await repo.getContacts();
  for (const c of contacts) {
    if (c.id === id) continue;
    const p = await repo.getPersona(c.id);
    if (p && id in p.relations) {
      const rest = { ...p.relations };
      delete rest[id];
      await repo.putPersona({ ...p, relations: rest });
    }
  }

  // 7) Per-contact / per-conversation settings ROWS, driven entirely by
  //    `SETTINGS_KEY_CASCADE`. This used to be a hand-written whitelist, which
  //    is why five key families outlived deletion for a year: adding a key
  //    never forced anyone to come here. Now registering the prefix IS the fix.
  //    Contact ids never contain ':', so prefix + exact tail is an exact match,
  //    and the directional `pair` keys are matched from either side.
  const settingKeys = await ops.allSettingKeys();
  const isTheirs = (k: string): boolean => {
    for (const [prefix, rule] of Object.entries(SETTINGS_KEY_CASCADE)) {
      if (rule.row !== 'cascade' || rule.scope === 'global') continue;
      if (!k.startsWith(prefix)) continue;
      const tail = k.slice(prefix.length);
      if (rule.scope === 'contact' && tail === id) return true;
      if (rule.scope === 'conv' && deadIds.has(tail)) return true;
      if (rule.scope === 'pair') {
        const [from, to] = tail.split(':');
        if (from === id || to === id) return true;
      }
    }
    return false;
  };
  for (const k of settingKeys) {
    if (isTheirs(k)) await ops.deleteSettingRow(k);
  }

  // 7.4) Rows whose VALUE is a map keyed by ids — `entries` in the ledger.
  //      `rel_edges` is the reason this step exists: ONE global row holds EVERY
  //      pair's (familiarity, affinity), so deleting the row would wipe the
  //      whole social graph — and leaving it whole is worse. Seed ids are FIXED
  //      (`ai_lin` & co. are re-seeded verbatim whenever the app finds itself
  //      empty), so a survivor edge means the NEXT 林 inherits the dead one's
  //      accumulated closeness: old-friend heartbeat pacing and like odds on
  //      day one. Cut per ENTRY, never per row.
  for (const [prefix, rule] of Object.entries(SETTINGS_KEY_CASCADE)) {
    if (!rule.entries) continue;
    const rowKeys =
      rule.scope === 'global' ? [prefix] : settingKeys.filter((k) => k.startsWith(prefix));
    for (const rowKey of rowKeys) {
      const map = await repo.getSetting<Record<string, unknown>>(rowKey);
      // Already deleted above (its conversation died), or never written.
      if (!map || typeof map !== 'object' || Array.isArray(map)) continue;
      const kept = Object.entries(map).filter(([entryKey]) =>
        rule.entries === 'pair' ? !entryKey.split(REL_PAIR_SEP).includes(id) : entryKey !== id,
      );
      if (kept.length !== Object.keys(map).length) {
        await repo.putSetting(rowKey, Object.fromEntries(kept));
      }
    }
  }

  // 7.5) Worldbook: entries scoped to this persona, or to a dead thread.
  for (const w of await repo.getWorldbook()) {
    const gone =
      (w.scope === 'persona' && w.scopeId === id) ||
      (w.scope === 'conv' && w.scopeId != null && deadIds.has(w.scopeId));
    if (gone) await repo.deleteWorldbookEntry(w.id);
  }

  // 7.7) Favorites (M-I13): snapshots authored by the contact, or captured
  //      from a thread that dies with them. Kept snapshots would keep
  //      rendering the deleted person's name and words forever — the opposite
  //      of deletion.
  for (const f of await ops.allFavorites()) {
    if (f.senderId === id || deadIds.has(f.convId)) await repo.deleteFavorite(f.id);
  }

  // 7.8) Story runs they were CAST in (M-I18). Deliberately not deleted: a
  //      save is hours of the user's play, and losing an actor is not losing
  //      the story. Unbind the dead contact and stop the run — `missingBindings`
  //      then reports the empty role, which is I7's own "this run cannot start"
  //      path, so the user is offered re-casting instead of a ghost.
  for (const save of await ops.allStorySaves()) {
    if (!Object.values(save.bindings).includes(id)) continue;
    const bindings = Object.fromEntries(
      Object.entries(save.bindings).filter(([, cid]) => cid !== id),
    );
    await ops.putStorySave({ ...save, bindings, isActive: false });
  }

  // 8) Moments traces: their posts (with all social rows on them), and
  //    their likes/comments on everyone else's posts.
  const moments = await ops.allMoments();
  for (const m of moments) {
    if (m.authorId !== id) continue;
    await repo.deleteMoment(m.id);
  }
  // Reposts by OTHERS that quote the dead contact keep their row but lose the
  // snapshot (M-I15) — "every trace" includes quoted excerpts, and the card
  // renders the WeChat idiom for it instead of a broken lookup.
  for (const m of moments) {
    if (m.authorId !== id && m.repostAuthorId === id) {
      const { repostAuthorId: _drop, ...rest } = m;
      await repo.putMoment({ ...rest, repostExcerpt: '原内容已删除' });
    }
  }
  for (const l of await ops.allLikes()) {
    if (l.contactId === id) await repo.deleteLike(l.id);
  }
  for (const cm of await ops.allComments()) {
    if (cm.authorId === id) await repo.deleteComment(cm.id);
  }

  // 9) Finally the persona and the contact row itself.
  await ops.deletePersonaRow(id);
  await ops.deleteContactRow(id);
}

export class IdbRepo implements Repo {
  async getContacts() {
    return idbGetAll<ContactVM>('contacts');
  }
  async getContact(id: string) {
    return idbGet<ContactVM>('contacts', id);
  }
  async putContact(c: ContactVM) {
    await idbPut('contacts', c);
  }

  /** The one contact-deletion path — shared cascade over IDB primitives. */
  async deleteContact(id: string) {
    await deleteContactCascade(this, {
      allScheduledActions: () =>
        idbGetAll<{ id: string; payloadJson: string }>('scheduled_actions'),
      deleteScheduledAction: (aid) => idbDelete('scheduled_actions', aid),
      allSettingKeys: async () =>
        (await idbGetAll<{ key: string }>('settings')).map((r) => r.key),
      deleteSettingRow: (k) => idbDelete('settings', k),
      allMoments: () => idbGetAll<MomentVM>('moments'),
      allLikes: () => idbGetAll<MomentLikeVM>('moment_likes'),
      allComments: () => idbGetAll<MomentCommentVM>('moment_comments'),
      allFavorites: () => idbGetAll<FavoriteVM>('favorites'),
      allStorySaves: () => idbGetAll<CascadeStoryRow>('story_saves'),
      putStorySave: async (row) => {
        await idbPut('story_saves', row);
      },
      deletePersonaRow: (cid) => idbDelete('personas', cid),
      deleteContactRow: (cid) => idbDelete('contacts', cid),
    }, id);
  }
  async getPersona(contactId: string) {
    return idbGet<PersonaVM>('personas', contactId);
  }
  async putPersona(p: PersonaVM) {
    await idbPut('personas', p);
  }

  async getConversations() {
    return idbGetAll<ConversationVM>('conversations');
  }
  async getConversation(id: string) {
    return idbGet<ConversationVM>('conversations', id);
  }
  async putConversation(c: ConversationVM) {
    await idbPut('conversations', c);
  }
  /**
   * Delete a conversation AND everything hanging off it.
   *
   * Deleting only the conversation row left its messages orphaned in the store.
   * They were invisible — until a conversation with the same id was recreated
   * (a rebuilt group, a re-added contact, a `.aiwx` restore), at which point the
   * old messages reappeared inside the new thread. `byConv` still indexed them,
   * so search could surface deleted content too.
   */
  async deleteConversation(id: string) {
    // One cursor, one transaction. This used to load every message and delete
    // them one at a time, each in its own transaction — so a long thread took
    // as many serial round-trips as it had messages, and a failure halfway
    // through left the conversation partly deleted with no way to tell.
    await idbDeleteByIndex('messages', 'byConv', id);
    await idbDelete('conv_summaries', id);
    await idbDelete('conversations', id);
  }

  /**
   * When this conversation started — the oldest message's timestamp.
   *
   * One forward cursor step, not a scan. Needed because nothing else records
   * it: contacts carry no creation date, and the loaded window is only the
   * newest page, so "认识多久了" cannot be derived from what is in memory.
   */
  async firstMessageAt(convId: string) {
    const row = await idbFirstByIndex<MessageVM>('messages', 'byConv', convId);
    return row?.createdAt;
  }

  async getMessages(convId: string, opts: { limit?: number; beforeId?: number } = {}) {
    // Descending by id, then reverse so callers get chronological order.
    const rows = await idbQueryByIndex<MessageVM>('messages', 'byConv', convId, {
      limit: opts.limit ?? 30,
      beforeId: opts.beforeId,
    });
    return rows.reverse();
  }
  async addMessage(msg: Omit<MessageVM, 'id'>) {
    const key = await idbAdd('messages', msg);
    return { ...(msg as MessageVM), id: key as number };
  }
  async updateMessage(msg: MessageVM) {
    await idbPut('messages', msg);
  }
  async deleteMessage(id: number) {
    await idbDelete('messages', id);
  }

  async getMemory(subjectId: string) {
    return idbQueryBySubject<MemoryFactVM>('memory_facts', subjectId);
  }
  async putMemory(f: MemoryFactVM) {
    await idbPut('memory_facts', f);
  }
  async deleteMemory(id: string) {
    await idbDelete('memory_facts', id);
  }
  async getConvSummary(convId: string) {
    return idbGet<ConvSummaryVM>('conv_summaries', convId);
  }
  async putConvSummary(s: ConvSummaryVM) {
    await idbPut('conv_summaries', s);
  }

  async getProviders() {
    return idbGetAll<ProviderVM>('providers');
  }
  async putProvider(p: ProviderVM) {
    await idbPut('providers', p);
  }
  async deleteProvider(id: string) {
    await idbDelete('providers', id);
  }
  async getSetting<T>(key: string) {
    const row = await idbGet<{ key: string; value: T }>('settings', key);
    return row?.value;
  }
  async putSetting<T>(key: string, value: T) {
    await idbPut('settings', { key, value });
  }

  async getRedPacket(id: string) {
    return idbGet<RedPacketVM>('red_packets', id);
  }
  async putRedPacket(rp: RedPacketVM) {
    await idbPut('red_packets', rp);
  }
  async getClaims(rpId: string) {
    // `byRp` has existed since v2 and was never used: this read pulled every
    // claim ever made, on every render of every red-packet detail page.
    const rows = await idbGetAllByIndex<RpClaimVM>('rp_claims', 'byRp', rpId);
    return rows.sort((a, b) => a.claimedAt - b.claimedAt);
  }
  async putClaim(c: RpClaimVM) {
    await idbPut('rp_claims', c);
  }
  async getTransfer(id: string) {
    return idbGet<TransferVM>('transfers', id);
  }
  async putTransfer(t: TransferVM) {
    await idbPut('transfers', t);
  }
  async getWalletTxs() {
    const all = await idbGetAll<WalletTxVM>('wallet_tx');
    return all.sort((a, b) => a.createdAt - b.createdAt);
  }
  async putWalletTx(t: WalletTxVM) {
    await idbPut('wallet_tx', t);
  }

  /**
   * Likes and comments for a whole page of posts, in two queries instead of 2N.
   *
   * The feed used to fan out `getLikes`/`getComments` per post — 2N+1 round
   * trips for a screen, which is the shape that makes a feed feel slower the
   * more you have posted. `byMoment` answers each of these directly, and the
   * grouping is a single pass in JS.
   */
  async getMomentSocial(momentIds: string[]) {
    const likes: Record<string, MomentLikeVM[]> = {};
    const comments: Record<string, MomentCommentVM[]> = {};
    if (momentIds.length === 0) return { likes, comments };
    const want = new Set(momentIds);
    for (const id of momentIds) {
      likes[id] = [];
      comments[id] = [];
    }
    const [allLikes, allComments] = await Promise.all([
      idbGetAll<MomentLikeVM>('moment_likes'),
      idbGetAll<MomentCommentVM>('moment_comments'),
    ]);
    for (const l of allLikes) if (want.has(l.momentId)) likes[l.momentId].push(l);
    for (const c of allComments) if (want.has(c.momentId)) comments[c.momentId].push(c);
    for (const id of momentIds) {
      likes[id].sort((a, b) => a.createdAt - b.createdAt);
      comments[id].sort((a, b) => a.createdAt - b.createdAt);
    }
    return { likes, comments };
  }

  async getMoments(opts: { limit?: number; before?: number } = {}) {
    // Walks `byCreatedAt` backwards (v7) instead of reading and sorting the
    // whole store. The old version applied `limit` only AFTER deserializing
    // every post ever written, so opening Moments got slower forever while the
    // screen it drew stayed the same size.
    return idbPageDesc<MomentVM>('moments', 'byCreatedAt', {
      limit: opts.limit ?? DEFAULT_MOMENTS_PAGE,
      before: opts.before,
    });
  }
  async getMoment(id: string) {
    return idbGet<MomentVM>('moments', id);
  }
  /**
   * Full scan by design: the album page is an occasional destination, one
   * author's posts are a small slice, and adding a byAuthor index would cost a
   * DB_VERSION bump for a query that runs on a tap, not a tick.
   */
  async getMomentsByAuthor(authorId: string) {
    const all = await idbGetAll<MomentVM>('moments');
    return all.filter((m) => m.authorId === authorId).sort((a, b) => b.createdAt - a.createdAt);
  }
  async putMoment(m: MomentVM) {
    await idbPut('moments', m);
  }
  async getLikes(momentId: string) {
    const rows = await idbGetAllByIndex<MomentLikeVM>('moment_likes', 'byMoment', momentId);
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  }
  async putLike(l: MomentLikeVM) {
    await idbPut('moment_likes', l);
  }
  async deleteLike(id: string) {
    await idbDelete('moment_likes', id);
  }
  async getComments(momentId: string) {
    const rows = await idbGetAllByIndex<MomentCommentVM>('moment_comments', 'byMoment', momentId);
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  }
  async putComment(c: MomentCommentVM) {
    await idbPut('moment_comments', c);
  }
  async deleteComment(id: string) {
    await idbDelete('moment_comments', id);
  }
  async deleteMoment(id: string) {
    // Social rows go WITH the post — orphaned likes resurface if a moment id
    // is ever reused (the deleteConversation lesson, applied here).
    for (const l of await this.getLikes(id)) await idbDelete('moment_likes', l.id);
    for (const c of await this.getComments(id)) await idbDelete('moment_comments', c.id);
    await idbDelete('moments', id);
  }

  async getWorldbook() {
    const all = await idbGetAll<import('../ai/worldbook').WorldbookEntry>('worldbook');
    return all.sort((a, b) => a.createdAt - b.createdAt);
  }
  async putWorldbookEntry(e: import('../ai/worldbook').WorldbookEntry) {
    await idbPut('worldbook', e);
  }
  async deleteWorldbookEntry(id: string) {
    await idbDelete('worldbook', id);
  }

  /**
   * Every favorite the USER may see, newest-favorited first.
   *
   * The hidden-conversation filter lives HERE, not in the page (CLAUDE.md
   * §3.5): favorites are only ever created from visible chats, but a row that
   * somehow references a hidden AI↔AI DM (a restore of a tampered backup, a
   * future writer's bug) must still never surface — leaking one is an
   * irreversible tell. A UI that forgets to filter cannot leak what the repo
   * never returns.
   */
  async getFavorites() {
    const [rows, convs] = await Promise.all([
      idbGetAll<FavoriteVM>('favorites'),
      this.getConversations(),
    ]);
    const hidden = new Set(convs.filter((c) => c.isHidden).map((c) => c.id));
    return rows.filter((f) => !hidden.has(f.convId)).sort((a, b) => b.favedAt - a.favedAt);
  }
  async putFavorite(f: FavoriteVM) {
    await idbPut('favorites', f);
  }
  async deleteFavorite(id: string) {
    await idbDelete('favorites', id);
  }

  async getMedia(kind?: MediaItemVM['kind']) {
    const all = await idbGetAll<MediaItemVM>('media');
    const filtered = kind ? all.filter((m) => m.kind === kind) : all;
    return filtered.sort((a, b) => a.createdAt - b.createdAt);
  }
  async getMediaItem(id: string) {
    return idbGet<MediaItemVM>('media', id);
  }
  async putMedia(item: MediaItemVM) {
    await idbPut('media', item);
  }
  async deleteMedia(id: string) {
    await idbDelete('media', id);
  }

  async isEmpty() {
    return (await idbCount('conversations')) === 0;
  }

  async bulkSeed(data: {
    contacts: ContactVM[];
    personas: PersonaVM[];
    conversations: ConversationVM[];
    messages: Array<Omit<MessageVM, 'id'>>;
    moments?: MomentVM[];
    momentLikes?: MomentLikeVM[];
    momentComments?: MomentCommentVM[];
  }) {
    await idbBulkPut('contacts', data.contacts);
    await idbBulkPut('personas', data.personas);
    await idbBulkPut('conversations', data.conversations);
    // Messages use autoincrement — add in order so ids ascend with time.
    // One transaction for the whole seed, not one per message. `idbAdd` opens
    // its own transaction per call, so seeding a few thousand messages meant a
    // few thousand serial round-trips on the very first launch — behind the
    // white screen, where it is least affordable.
    await idbBulkAdd('messages', data.messages);
    if (data.moments?.length) await idbBulkPut('moments', data.moments);
    if (data.momentLikes?.length) await idbBulkPut('moment_likes', data.momentLikes);
    if (data.momentComments?.length) await idbBulkPut('moment_comments', data.momentComments);
  }
}

/**
 * All memory rows for a subject.
 *
 * This used to `getAll()` the whole store and filter in JS, justified by a
 * comment about memory ids being string UUIDs rather than the numeric keys
 * `idbQueryByIndex` walks. True, and beside the point: `idbGetAllByIndex`
 * exists for exactly this shape, and the `bySubject` index has been sitting in
 * the schema since v1 without a single reader.
 *
 * The cost was not theoretical. One message in a five-person group runs this
 * eleven times (each member's own memory plus the group's), so at 5,000
 * remembered facts a single group message deserialized 55,000 rows on the main
 * thread — for a query the database could answer directly.
 */
async function idbQueryBySubject<T extends { subjectId?: string }>(
  store: string,
  subjectId: string,
): Promise<T[]> {
  return idbGetAllByIndex<T>(store, 'bySubject', subjectId);
}

type AppRepo = Repo & { bulkSeed?: IdbRepo['bulkSeed'] };

/**
 * The active driver behind `repo`. IndexedDB by default — src/db/driver.ts
 * swaps in the SQLite driver at startup on native devices that completed the
 * one-time migration (M-I17). Callers never see the swap: they import `repo`.
 */
let impl: AppRepo = new IdbRepo();

/** Swap the driver. Called ONLY by src/db/driver.ts — never by features. */
export function setRepoImpl(next: AppRepo): void {
  impl = next;
}

/** Which driver is live right now (for the settings page status row). */
export function currentRepoImpl(): AppRepo {
  return impl;
}

/**
 * The app's single Repo instance. A delegating proxy rather than a direct
 * instance so the driver can be chosen asynchronously at startup (the flag
 * lives in IndexedDB) without changing a single import site — the Repo
 * interface existing precisely so drivers swap under it (CLAUDE.md §3).
 */
export const repo: AppRepo = new Proxy({} as AppRepo, {
  get(_t, prop) {
    const v = (impl as unknown as Record<PropertyKey, unknown>)[prop];
    return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(impl) : v;
  },
});
