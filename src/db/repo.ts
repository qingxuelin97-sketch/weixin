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

/** The app's single Repo instance (web driver). */
export const repo: Repo & { bulkSeed?: IdbRepo['bulkSeed'] } = new IdbRepo();
