/**
 * SQLite driver behind the SAME Repo interface (M-I17 / the M3 promise).
 *
 * Layout: one table per IndexedDB store. Every table is `(key TEXT PRIMARY
 * KEY, data TEXT)` with the row JSON-encoded in `data` — the "JSON 列演进"
 * convention from specs/data-schema.md, so rows evolve without migrations —
 * EXCEPT `messages`, which keeps its INTEGER AUTOINCREMENT primary key so the
 * repo's core invariant survives verbatim: rowid order == time order, and the
 * `beforeId` cursor pagination (`WHERE conv_id=? AND id<? ORDER BY id DESC
 * LIMIT ?`, never OFFSET) means the same thing it means in IndexedDB.
 *
 * Two rows never live here:
 *   - the WebCrypto master key (`settings.__crypto_master`): a CryptoKey is
 *     device-local and JSON-serializes to `{}` (the H3 husk bug). It stays in
 *     IndexedDB, where src/lib/keystore.ts reads it directly.
 *   - `tts_cache`: re-derivable audio; its only reader (lib/voice.ts) talks to
 *     IndexedDB directly, and copying a cache is weight without meaning.
 *
 * Stores whose only consumers bypass the Repo (`scheduled_actions` for the
 * scheduler, `story_*` for story-gm) KEEP IndexedDB as their live home — this
 * driver never reads them. The migrator still copies them so the SQLite file
 * is a complete snapshot, but the queue the app runs on stays where its reader
 * is. One store, one home, one reader.
 *
 * `media` rows carry Blobs, which cannot live in a TEXT column: they travel
 * base64-encoded in `blobB64` (same codec as .aiwx backups) and are rebuilt
 * into Blobs on read.
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
import { STORES, idbGetAll, idbDelete, idbPut } from './idb';
import {
  deleteContactCascade,
  estimateStorage,
  type CascadeStoryRow,
  type Repo,
  type StorageReport,
} from './repo';
import { visibleMoments } from '../lib/moment-visibility';
import { NO_FRIEND_PERMS, type FriendPermMap } from '../lib/friend-perms';

/**
 * The slice of @capacitor-community/sqlite's SQLiteDBConnection this driver
 * needs. Tests inject an in-memory implementation of the same three calls, so
 * the SQL text and parameter shapes — the actual contract — are what's tested.
 */
export interface SqlDb {
  execute(statements: string, transaction?: boolean): Promise<unknown>;
  run(
    statement: string,
    values?: unknown[],
    transaction?: boolean,
  ): Promise<{ changes?: { changes?: number; lastId?: number } }>;
  query(
    statement: string,
    values?: unknown[],
  ): Promise<{ values?: Array<Record<string, unknown>> }>;
}

/** Stores the SQLite driver SERVES through the Repo interface. */
export const SQLITE_SERVED_STORES: ReadonlySet<string> = new Set([
  'contacts',
  'personas',
  'conversations',
  'messages',
  'memory_facts',
  'conv_summaries',
  'providers',
  'settings',
  'red_packets',
  'rp_claims',
  'transfers',
  'wallet_tx',
  'moments',
  'moment_likes',
  'moment_comments',
  'worldbook',
  'favorites',
  'media',
]);

/** Stores that get a SQLite table at all (everything but the audio cache). */
export const SQLITE_TABLES: readonly string[] = STORES.map((s) => s.name).filter(
  (n) => n !== 'tts_cache',
);

/** keyPath per store, from the single store list in idb.ts. */
const KEY_PATH: Record<string, string> = Object.fromEntries(
  STORES.map((s) => [s.name, s.keyPath]),
);

export function keyOfRow(store: string, row: unknown): string {
  const k = (row as Record<string, unknown>)[KEY_PATH[store]];
  return String(k);
}

/* ---------------------------------------------------------------- schema */

export async function ensureSqliteSchema(db: SqlDb): Promise<void> {
  const ddl: string[] = [];
  for (const t of SQLITE_TABLES) {
    if (t === 'messages') {
      ddl.push(
        `CREATE TABLE IF NOT EXISTS "messages" (id INTEGER PRIMARY KEY AUTOINCREMENT, conv_id TEXT NOT NULL, data TEXT NOT NULL);`,
        `CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages (conv_id, id);`,
      );
      continue;
    }
    ddl.push(`CREATE TABLE IF NOT EXISTS "${t}" (key TEXT PRIMARY KEY, data TEXT NOT NULL);`);
  }
  // Expression indexes for the queries the IDB driver answers with indexes.
  ddl.push(
    `CREATE INDEX IF NOT EXISTS idx_mem_subject ON memory_facts (json_extract(data,'$.subjectId'));`,
    `CREATE INDEX IF NOT EXISTS idx_moments_created ON moments (json_extract(data,'$.createdAt'));`,
    `CREATE INDEX IF NOT EXISTS idx_likes_moment ON moment_likes (json_extract(data,'$.momentId'));`,
    `CREATE INDEX IF NOT EXISTS idx_comments_moment ON moment_comments (json_extract(data,'$.momentId'));`,
    `CREATE INDEX IF NOT EXISTS idx_claims_rp ON rp_claims (json_extract(data,'$.rpId'));`,
  );
  await db.execute(ddl.join('\n'), false);
}

/* ------------------------------------------------------------ row codecs */

function blobToB64(bytes: Uint8Array): string {
  let bin = '';
  // Chunked to keep the argument list under engine limits on big photos.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function b64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return new Blob([buf], { type: mime || 'application/octet-stream' });
}

/**
 * Turn a VM row into the JSON string a TEXT column can hold. Media Blobs are
 * base64-encoded; everything else stringifies as-is. Async because reading a
 * Blob is.
 */
export async function encodeRowForSqlite(store: string, row: unknown): Promise<string> {
  if (store === 'media') {
    const { blob, ...rest } = row as { blob?: Blob } & Record<string, unknown>;
    if (blob instanceof Blob) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      return JSON.stringify({ ...rest, blobB64: blobToB64(bytes) });
    }
  }
  return JSON.stringify(row);
}

/** The inverse: JSON string → VM row, rebuilding media Blobs. */
export function decodeRowFromSqlite(store: string, data: string): unknown {
  const parsed = JSON.parse(data) as Record<string, unknown>;
  if (store === 'media' && typeof parsed.blobB64 === 'string') {
    const { blobB64, ...rest } = parsed;
    return { ...rest, blob: b64ToBlob(blobB64, String(rest.mime ?? '')) };
  }
  return parsed;
}

/* ------------------------------------------------- raw store-level access */

/**
 * All rows of a store, in primary-key order (which for `messages` is id order
 * == time order). Backup and the migrator's verify step read through this.
 */
export async function sqliteReadAll(db: SqlDb, store: string): Promise<unknown[]> {
  if (store === 'messages') {
    const res = await db.query(`SELECT id, data FROM messages ORDER BY id ASC`);
    return (res.values ?? []).map((r) => ({
      ...(JSON.parse(String(r.data)) as Record<string, unknown>),
      id: Number(r.id),
    }));
  }
  const res = await db.query(`SELECT data FROM "${store}" ORDER BY key ASC`);
  return (res.values ?? []).map((r) => decodeRowFromSqlite(store, String(r.data)));
}

/** Upsert one row. Messages keep their explicit id (rowid 序==时间序). */
export async function sqliteWriteRow(db: SqlDb, store: string, row: unknown): Promise<void> {
  if (store === 'messages') {
    const m = row as MessageVM;
    const { id, ...rest } = m;
    await db.run(
      `INSERT OR REPLACE INTO messages (id, conv_id, data) VALUES (?, ?, ?)`,
      [id, m.convId, JSON.stringify(rest)],
      false,
    );
    return;
  }
  await db.run(
    `INSERT OR REPLACE INTO "${store}" (key, data) VALUES (?, ?)`,
    [keyOfRow(store, row), await encodeRowForSqlite(store, row)],
    false,
  );
}

export async function sqliteClearStore(db: SqlDb, store: string): Promise<void> {
  await db.run(`DELETE FROM "${store}"`, [], false);
}

/**
 * Delete ONE row by primary key. Backup increments need this to apply
 * tombstones (a row the user deleted after the base full was taken); every
 * other write path here replaces or clears wholesale.
 */
export async function sqliteDeleteRow(
  db: SqlDb,
  store: string,
  key: string | number,
): Promise<void> {
  if (store === 'messages') {
    await db.run(`DELETE FROM messages WHERE id = ?`, [key], false);
    return;
  }
  await db.run(`DELETE FROM "${store}" WHERE key = ?`, [String(key)], false);
}

export async function sqliteCount(db: SqlDb, store: string): Promise<number> {
  const res = await db.query(`SELECT COUNT(*) AS n FROM "${store}"`);
  return Number(res.values?.[0]?.n ?? 0);
}

/* ---------------------------------------------------------------- driver */

const DEFAULT_MOMENTS_PAGE = 60;

export class SqliteRepo implements Repo {
  constructor(private db: SqlDb) {}

  /* -- kv helpers -- */
  private async kvGet<T>(store: string, key: string): Promise<T | undefined> {
    const res = await this.db.query(`SELECT data FROM "${store}" WHERE key = ?`, [key]);
    const row = res.values?.[0];
    return row == null ? undefined : (decodeRowFromSqlite(store, String(row.data)) as T);
  }
  private async kvAll<T>(store: string): Promise<T[]> {
    return (await sqliteReadAll(this.db, store)) as T[];
  }
  private async kvPut(store: string, row: unknown): Promise<void> {
    await sqliteWriteRow(this.db, store, row);
  }
  private async kvDelete(store: string, key: string): Promise<void> {
    await this.db.run(`DELETE FROM "${store}" WHERE key = ?`, [key], false);
  }
  /** Equality on one JSON field — the expression indexes above serve these. */
  private async byField<T>(store: string, field: string, value: string): Promise<T[]> {
    const res = await this.db.query(
      `SELECT data FROM "${store}" WHERE json_extract(data,'$.${field}') = ?`,
      [value],
    );
    return (res.values ?? []).map((r) => decodeRowFromSqlite(store, String(r.data)) as T);
  }

  /* -- contacts & personas -- */
  async getContacts() {
    return this.kvAll<ContactVM>('contacts');
  }
  async getContact(id: string) {
    return this.kvGet<ContactVM>('contacts', id);
  }
  async putContact(c: ContactVM) {
    await this.kvPut('contacts', c);
  }
  /** Same cascade, this driver's primitives. scheduled_actions stays in IDB. */
  async deleteContact(id: string) {
    await deleteContactCascade(this, {
      allScheduledActions: () =>
        idbGetAll<{ id: string; payloadJson: string }>('scheduled_actions'),
      deleteScheduledAction: (aid) => idbDelete('scheduled_actions', aid),
      allSettingKeys: async () =>
        (await this.kvAll<{ key: string }>('settings')).map((r) => r.key),
      deleteSettingRow: (k) => this.kvDelete('settings', k),
      allMoments: () => this.kvAll<MomentVM>('moments'),
      allLikes: () => this.kvAll<MomentLikeVM>('moment_likes'),
      allComments: () => this.kvAll<MomentCommentVM>('moment_comments'),
      allFavorites: () => this.kvAll<FavoriteVM>('favorites'),
      // Story saves live in IndexedDB under BOTH drivers — story-gm.ts talks to
      // idb directly, the same reason scheduled_actions does above.
      allStorySaves: () => idbGetAll<CascadeStoryRow>('story_saves'),
      putStorySave: async (row) => {
        await idbPut('story_saves', row);
      },
      deletePersonaRow: (cid) => this.kvDelete('personas', cid),
      deleteContactRow: (cid) => this.kvDelete('contacts', cid),
    }, id);
  }
  async getPersona(contactId: string) {
    return this.kvGet<PersonaVM>('personas', contactId);
  }
  async putPersona(p: PersonaVM) {
    await this.kvPut('personas', p);
  }

  /* -- conversations -- */
  async getConversations() {
    return this.kvAll<ConversationVM>('conversations');
  }
  async getConversation(id: string) {
    return this.kvGet<ConversationVM>('conversations', id);
  }
  async putConversation(c: ConversationVM) {
    await this.kvPut('conversations', c);
  }
  async clearMessages(convId: string) {
    // Messages + summary, conversation row survives (M-J7).
    await this.db.run(`DELETE FROM messages WHERE conv_id = ?`, [convId], false);
    await this.kvDelete('conv_summaries', convId);
  }
  async deleteConversation(id: string) {
    // Messages + summary + row, same order as the IDB driver.
    await this.db.run(`DELETE FROM messages WHERE conv_id = ?`, [id], false);
    await this.kvDelete('conv_summaries', id);
    await this.kvDelete('conversations', id);
  }
  async firstMessageAt(convId: string) {
    const res = await this.db.query(
      `SELECT id, data FROM messages WHERE conv_id = ? ORDER BY id ASC LIMIT 1`,
      [convId],
    );
    const row = res.values?.[0];
    if (row == null) return undefined;
    return (JSON.parse(String(row.data)) as MessageVM).createdAt;
  }

  /* -- messages (autoincrement id; per-conversation cursor pagination) -- */
  async getMessages(convId: string, opts: { limit?: number; beforeId?: number } = {}) {
    const limit = opts.limit ?? 30;
    const res =
      opts.beforeId == null
        ? await this.db.query(
            `SELECT id, data FROM messages WHERE conv_id = ? ORDER BY id DESC LIMIT ?`,
            [convId, limit],
          )
        : await this.db.query(
            `SELECT id, data FROM messages WHERE conv_id = ? AND id < ? ORDER BY id DESC LIMIT ?`,
            [convId, opts.beforeId, limit],
          );
    const rows = (res.values ?? []).map((r) => ({
      ...(JSON.parse(String(r.data)) as Omit<MessageVM, 'id'>),
      id: Number(r.id),
    })) as MessageVM[];
    return rows.reverse();
  }
  async addMessage(msg: Omit<MessageVM, 'id'>) {
    const res = await this.db.run(
      `INSERT INTO messages (conv_id, data) VALUES (?, ?)`,
      [msg.convId, JSON.stringify(msg)],
      false,
    );
    const id = Number(res.changes?.lastId ?? 0);
    return { ...(msg as MessageVM), id };
  }
  async updateMessage(msg: MessageVM) {
    const { id, ...rest } = msg;
    await this.db.run(
      `UPDATE messages SET conv_id = ?, data = ? WHERE id = ?`,
      [msg.convId, JSON.stringify(rest), id],
      false,
    );
  }
  async deleteMessage(id: number) {
    await this.db.run(`DELETE FROM messages WHERE id = ?`, [id], false);
  }

  /* -- memory -- */
  async getMemory(subjectId: string) {
    return this.byField<MemoryFactVM>('memory_facts', 'subjectId', subjectId);
  }
  async putMemory(f: MemoryFactVM) {
    await this.kvPut('memory_facts', f);
  }
  async deleteMemory(id: string) {
    await this.kvDelete('memory_facts', id);
  }
  async getConvSummary(convId: string) {
    return this.kvGet<ConvSummaryVM>('conv_summaries', convId);
  }
  async putConvSummary(s: ConvSummaryVM) {
    await this.kvPut('conv_summaries', s);
  }

  /* -- providers & settings -- */
  async getProviders() {
    return this.kvAll<ProviderVM>('providers');
  }
  async putProvider(p: ProviderVM) {
    await this.kvPut('providers', p);
  }
  async deleteProvider(id: string) {
    await this.kvDelete('providers', id);
  }
  async getSetting<T>(key: string) {
    const row = await this.kvGet<{ key: string; value: T }>('settings', key);
    return row?.value;
  }
  async putSetting<T>(key: string, value: T) {
    await this.kvPut('settings', { key, value });
  }

  /* -- money -- */
  async getRedPacket(id: string) {
    return this.kvGet<RedPacketVM>('red_packets', id);
  }
  async putRedPacket(rp: RedPacketVM) {
    await this.kvPut('red_packets', rp);
  }
  async getClaims(rpId: string) {
    const rows = await this.byField<RpClaimVM>('rp_claims', 'rpId', rpId);
    return rows.sort((a, b) => a.claimedAt - b.claimedAt);
  }
  async putClaim(c: RpClaimVM) {
    await this.kvPut('rp_claims', c);
  }
  async getTransfer(id: string) {
    return this.kvGet<TransferVM>('transfers', id);
  }
  async putTransfer(t: TransferVM) {
    await this.kvPut('transfers', t);
  }
  async getWalletTxs(opts: { limit?: number; before?: number } = {}) {
    // Paged form (M-J8): newest `limit` rows below `before`, returned ascending
    // — the same contract the IDB driver serves off its byCreatedAt index. The
    // SQL mirrors getMoments; both drivers must agree or a migrated phone gets
    // a different bill page than the web build (sqlite-repo parity suite).
    if (opts.limit != null) {
      // `key DESC` tiebreak = IDB's within-key order walked 'prev' (primary key
      // descending among equal createdAt), so same-millisecond rows page alike.
      const res =
        opts.before == null
          ? await this.db.query(
              `SELECT data FROM wallet_tx ORDER BY json_extract(data,'$.createdAt') DESC, key DESC LIMIT ?`,
              [opts.limit],
            )
          : await this.db.query(
              `SELECT data FROM wallet_tx WHERE json_extract(data,'$.createdAt') < ? ORDER BY json_extract(data,'$.createdAt') DESC, key DESC LIMIT ?`,
              [opts.before, opts.limit],
            );
      const rows = (res.values ?? []).map((r) => JSON.parse(String(r.data)) as WalletTxVM);
      return rows.reverse();
    }
    const all = await this.kvAll<WalletTxVM>('wallet_tx');
    return all.sort((a, b) => a.createdAt - b.createdAt);
  }
  async putWalletTx(t: WalletTxVM) {
    await this.kvPut('wallet_tx', t);
  }

  /* -- moments -- */
  /**
   * 朋友权限 (M-J7) — read inside the driver for the same reason 可见范围 is
   * filtered here: a reader that has to remember to fetch the perms is a reader
   * that eventually forgets, and forgetting shows up as her liking a post you
   * blocked her from. One KV row, so this is one extra get per moment read.
   */
  async getFriendPerms(): Promise<FriendPermMap> {
    return (await this.getSetting<FriendPermMap>('friendPerms')) ?? NO_FRIEND_PERMS;
  }
  async getMoments(opts: { limit?: number; before?: number; viewer?: string } = {}) {
    const limit = opts.limit ?? DEFAULT_MOMENTS_PAGE;
    const res =
      opts.before == null
        ? await this.db.query(
            `SELECT data FROM moments ORDER BY json_extract(data,'$.createdAt') DESC LIMIT ?`,
            [limit],
          )
        : await this.db.query(
            `SELECT data FROM moments WHERE json_extract(data,'$.createdAt') < ? ORDER BY json_extract(data,'$.createdAt') DESC LIMIT ?`,
            [opts.before, limit],
          );
    // 可见范围 (M-I18) applied HERE, in the driver, exactly as the IDB one does
    // — both drivers must enforce it or swapping storage would silently unmute
    // every restricted post.
    const rows = (res.values ?? []).map((r) => JSON.parse(String(r.data)) as MomentVM);
    return visibleMoments(rows, opts.viewer ?? 'self', await this.getFriendPerms());
  }
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
      this.kvAll<MomentLikeVM>('moment_likes'),
      this.kvAll<MomentCommentVM>('moment_comments'),
    ]);
    for (const l of allLikes) if (want.has(l.momentId)) likes[l.momentId].push(l);
    for (const c of allComments) if (want.has(c.momentId)) comments[c.momentId].push(c);
    for (const id of momentIds) {
      likes[id].sort((a, b) => a.createdAt - b.createdAt);
      comments[id].sort((a, b) => a.createdAt - b.createdAt);
    }
    return { likes, comments };
  }
  async getMoment(id: string, viewer = 'self') {
    const m = await this.kvGet<MomentVM>('moments', id);
    // Contract twin of db/repo.ts: the by-id read carries the same in-driver
    // audience gate as the feed read (M-J12).
    return m && visibleMoments([m], viewer, await this.getFriendPerms()).length > 0 ? m : undefined;
  }
  async getMomentsByAuthor(authorId: string, viewer = 'self') {
    const all = await this.kvAll<MomentVM>('moments');
    return visibleMoments(
      all.filter((m) => m.authorId === authorId),
      viewer,
      await this.getFriendPerms(),
    ).sort((a, b) => b.createdAt - a.createdAt);
  }
  async putMoment(m: MomentVM) {
    await this.kvPut('moments', m);
  }
  async getLikes(momentId: string) {
    const rows = await this.byField<MomentLikeVM>('moment_likes', 'momentId', momentId);
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  }
  async putLike(l: MomentLikeVM) {
    await this.kvPut('moment_likes', l);
  }
  async deleteLike(id: string) {
    await this.kvDelete('moment_likes', id);
  }
  async getComments(momentId: string) {
    const rows = await this.byField<MomentCommentVM>('moment_comments', 'momentId', momentId);
    return rows.sort((a, b) => a.createdAt - b.createdAt);
  }
  async putComment(c: MomentCommentVM) {
    await this.kvPut('moment_comments', c);
  }
  async deleteComment(id: string) {
    await this.kvDelete('moment_comments', id);
  }
  async deleteMoment(id: string) {
    for (const l of await this.getLikes(id)) await this.kvDelete('moment_likes', l.id);
    for (const c of await this.getComments(id)) await this.kvDelete('moment_comments', c.id);
    await this.kvDelete('moments', id);
  }

  /* -- worldbook -- */
  async getWorldbook() {
    const all = await this.kvAll<import('../ai/worldbook').WorldbookEntry>('worldbook');
    return all.sort((a, b) => a.createdAt - b.createdAt);
  }
  async putWorldbookEntry(e: import('../ai/worldbook').WorldbookEntry) {
    await this.kvPut('worldbook', e);
  }
  async deleteWorldbookEntry(id: string) {
    await this.kvDelete('worldbook', id);
  }

  /* -- favorites (M-I13) -- */
  async getFavorites() {
    // Same hidden-conversation wall as the IDB driver: the repo never returns
    // a favorite referencing a hidden AI↔AI DM, so no UI can leak one.
    const [rows, convs] = await Promise.all([
      this.kvAll<FavoriteVM>('favorites'),
      this.getConversations(),
    ]);
    const hidden = new Set(convs.filter((c) => c.isHidden).map((c) => c.id));
    return rows.filter((f) => !hidden.has(f.convId)).sort((a, b) => b.favedAt - a.favedAt);
  }
  async putFavorite(f: FavoriteVM) {
    await this.kvPut('favorites', f);
  }
  async deleteFavorite(id: string) {
    await this.kvDelete('favorites', id);
  }

  /* -- media -- */
  async getMedia(kind?: MediaItemVM['kind']) {
    const all = await this.kvAll<MediaItemVM>('media');
    const filtered = kind ? all.filter((m) => m.kind === kind) : all;
    return filtered.sort((a, b) => a.createdAt - b.createdAt);
  }
  async getMediaItem(id: string) {
    return this.kvGet<MediaItemVM>('media', id);
  }
  async putMedia(item: MediaItemVM) {
    await this.kvPut('media', item);
  }
  async deleteMedia(id: string) {
    await this.kvDelete('media', id);
  }

  /**
   * 存储用量 (M-J10).
   *
   * `estimate()` 是**估算**而且随浏览器/WebView 而异——拿不到时返回 0 而不是
   * 编一个数字，页面据此不画配额条。编一个「无限」会让这一页在最该报警的时候
   * 最安静。
   */
  async storageReport(): Promise<StorageReport> {
    const stores: Array<{ name: string; rows: number }> = [];
    for (const t of SQLITE_TABLES) {
      stores.push({ name: t, rows: await sqliteCount(this.db, t) });
    }
    stores.sort((a, b) => a.name.localeCompare(b.name));

    const byKind = new Map<string, { count: number; bytes: number }>();
    for (const m of await this.kvAll<MediaItemVM>('media')) {
      const acc = byKind.get(m.kind) ?? { count: 0, bytes: 0 };
      acc.count += 1;
      acc.bytes += m.blob?.size ?? 0;
      byKind.set(m.kind, acc);
    }
    const media = [...byKind.entries()]
      .map(([kind, v]) => ({ kind, ...v }))
      .sort((a, b) => b.bytes - a.bytes);

    return { ...(await estimateStorage()), stores, media };
  }

  async isEmpty() {
    return (await sqliteCount(this.db, 'conversations')) === 0;
  }

  /**
   * Same shape as IdbRepo.bulkSeed, so a freshly-wiped SQLite install can
   * still seed. Messages are added WITHOUT ids, in order — the AUTOINCREMENT
   * key preserves time order exactly as the IDB driver's `add` does.
   */
  async bulkSeed(data: {
    contacts: ContactVM[];
    personas: PersonaVM[];
    conversations: ConversationVM[];
    messages: Array<Omit<MessageVM, 'id'>>;
    moments?: MomentVM[];
    momentLikes?: MomentLikeVM[];
    momentComments?: MomentCommentVM[];
  }) {
    for (const c of data.contacts) await this.putContact(c);
    for (const p of data.personas) await this.putPersona(p);
    for (const c of data.conversations) await this.putConversation(c);
    for (const m of data.messages) await this.addMessage(m);
    for (const m of data.moments ?? []) await this.putMoment(m);
    for (const l of data.momentLikes ?? []) await this.putLike(l);
    for (const c of data.momentComments ?? []) await this.putComment(c);
  }
}
