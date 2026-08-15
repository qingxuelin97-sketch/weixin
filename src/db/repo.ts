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
  settings: 'cascade', // affect/drift/threads/stance/relarc + per-dead-conv keys
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
  story_saves: 'exempt',
  worldbook: 'cascade', // persona-scoped entries die with their contact
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
  deletePersonaRow(contactId: string): Promise<void>;
  deleteContactRow(id: string): Promise<void>;
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

  // 7) Per-contact settings rows. Contact ids never contain ':', so the
  //    directional keys are matched exactly from either side.
  const settingKeys = await ops.allSettingKeys();
  const isTheirs = (k: string) =>
    k === `affect:${id}` ||
    k === `drift:${id}` ||
    k === `threads:${id}` ||
    k.startsWith(`stance:${id}:`) ||
    (k.startsWith('stance:') && k.endsWith(`:${id}`)) ||
    k.startsWith(`relarc:${id}:`) ||
    (k.startsWith('relarc:') && k.endsWith(`:${id}`)) ||
    [...deadIds].some(
      (cid) =>
        k === `convstate:${cid}` ||
        k === `topic:${cid}` ||
        k === `groupCfg:${cid}` ||
        k === `groupBuild:${cid}`,
    );
  for (const k of settingKeys) {
    if (isTheirs(k)) await ops.deleteSettingRow(k);
  }

  // 7.5) Worldbook: entries scoped to this persona, or to a dead thread.
  for (const w of await repo.getWorldbook()) {
    const gone =
      (w.scope === 'persona' && w.scopeId === id) ||
      (w.scope === 'conv' && w.scopeId != null && deadIds.has(w.scopeId));
    if (gone) await repo.deleteWorldbookEntry(w.id);
  }

  // 8) Moments traces: their posts (with all social rows on them), and
  //    their likes/comments on everyone else's posts.
  const moments = await ops.allMoments();
  for (const m of moments) {
    if (m.authorId !== id) continue;
    await repo.deleteMoment(m.id);
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
