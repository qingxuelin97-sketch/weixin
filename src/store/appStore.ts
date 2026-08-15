/**
 * App store (zustand), backed by the Repo (IndexedDB in M2, native SQLite at M3).
 * State is hydrated from the Repo on startup; mutations write through to the Repo
 * so data survives refresh. Component-facing selectors keep their M1 signatures.
 */
import { create } from 'zustand';
import type {
  ContactVM,
  ConversationVM,
  MessageVM,
  PersonaVM,
  MomentVM,
  MomentLikeVM,
  MomentCommentVM,
} from '../data/types';
import {
  seedContacts,
  seedConversations,
  seedMessages,
  seedPersonas,
  seedRedPackets,
  seedMoments,
  seedMomentLikes,
  seedMomentComments,
} from '../data/seed';
import { repo, IdbRepo } from '../db/repo';
import { initStorageDriver } from '../db/driver';
import { registerMediaMeta, materializeMedia } from '../data/media-registry';
import { makePersona } from '../data/persona-defaults';
import { recordRelEvent } from '../ai/relationship';
import { cancelActionsForConversation } from '../ai/scheduler';
import { abortConversation } from '../ai/engine';
import { applyStoryStamp } from '../ai/story-stamp';
import { collectMomentsNews, type MomentsNews } from '../ai/moments-news';
import { logError } from '../lib/errlog';

/** A like warms the (liker, author) edge — fire-and-forget, never blocks UI. */
async function relEventForLike(momentId: string, likerId: string, now: number): Promise<void> {
  try {
    const moment = await repo.getMoment(momentId);
    if (moment && moment.authorId !== likerId) {
      await recordRelEvent(moment.authorId, likerId, 'moment_liked', now);
    }
  } catch {
    /* bookkeeping only */
  }
}

interface AppState {
  hydrated: boolean;
  /** Set when hydrate() failed — the shell shows a retry screen, not white. */
  hydrateError: string | null;
  contacts: ContactVM[];
  conversations: ConversationVM[];
  messages: Record<string, MessageVM[]>;
  personas: Record<string, PersonaVM>;
  /** Conversations currently showing "对方正在输入…". */
  typing: Record<string, boolean>;
  /**
   * The conversation the user is looking at right now. Messages arriving here
   * don't count as unread; entering clears the badge. Null when off any chat.
   */
  activeConvId: string | null;
  /** Transient feedback line ("暂未开放" etc.). Null = hidden. */
  toast: string | null;
  showToast: (msg: string) => void;

  /**
   * An agent is calling right now (M-H1). Null = nobody is.
   *
   * Kept in the store rather than routed to a page: the overlay has to be able
   * to appear over WHATEVER the user is looking at — that is what makes it a
   * call rather than a screen you navigated to.
   */
  incomingCall: { convId: string; contactId: string; reason: string; at: number } | null;
  setIncomingCall: (call: AppState['incomingCall']) => void;

  /** Moments feed, newest first. Loaded lazily — the feed is not on the hot path. */
  moments: MomentVM[];
  momentsLoaded: boolean;
  /** Keyed by momentId so selectors can return a stable reference (see CLAUDE.md §3.5). */
  momentLikes: Record<string, MomentLikeVM[]>;
  momentComments: Record<string, MomentCommentVM[]>;
  /**
   * 朋友圈新消息 (M-I15): likes/comments on the user's own posts since they
   * last opened the feed. DERIVED from stored rows + the `momentsSeenAt`
   * setting (never counted in place), so restarts and backfill cannot make the
   * Discover-tab badge lie. Stable reference; only refresh/markSeen replace it.
   */
  momentsNews: MomentsNews;
  /** Recompute momentsNews from storage. Cheap (one feed page + social rows). */
  refreshMomentsNews: () => Promise<void>;
  /** The user just looked at the feed: persist the watermark, clear the badge. */
  markMomentsSeen: (now: number) => Promise<void>;

  // selectors (stable signatures)
  contactById: (id: string) => ContactVM | undefined;
  messagesFor: (convId: string) => MessageVM[];
  /** Has this conversation's thread been loaded (an empty thread still counts)? */
  hasThread: (convId: string) => boolean;
  /** Load a conversation's newest page on first open. Idempotent. */
  openConversation: (convId: string, limit?: number) => Promise<void>;
  /** Prepend the page before the oldest held message; returns how many arrived. */
  loadOlderMessages: (convId: string, limit?: number) => Promise<number>;
  /**
   * Re-read a conversation's newest page from the Repo, REPLACING whatever the
   * store holds (M-I7). The one caller is story rollback: it deletes rows
   * underneath the store, and a stale in-memory tail would resurrect trimmed
   * scenes on the next render. No-op for a thread that was never loaded.
   */
  reloadConversation: (convId: string, limit?: number) => Promise<void>;
  conversationById: (id: string) => ConversationVM | undefined;
  personaFor: (contactId: string) => PersonaVM | undefined;
  setTyping: (convId: string, on: boolean) => void;
  likesFor: (momentId: string) => MomentLikeVM[];
  commentsFor: (momentId: string) => MomentCommentVM[];

  // lifecycle & mutations (write through to Repo)
  hydrate: () => Promise<void>;
  /** Enter (id) / leave (null) a chat. Entering zeroes unreadCount + mentionMe. */
  setActiveConv: (convId: string | null) => Promise<void>;
  appendMessage: (msg: Omit<MessageVM, 'id'>) => Promise<MessageVM>;
  updateMessage: (msg: MessageVM) => Promise<void>;
  patchConversation: (id: string, patch: Partial<ConversationVM>) => Promise<void>;
  /** 删除聊天：remove the conversation row (history rows stay orphaned, like WeChat). */
  deleteConversation: (id: string) => Promise<void>;
  /** Delete one message locally and recompute the conversation preview. */
  deleteMessage: (convId: string, msgId: number) => Promise<void>;
  /** Insert a conversation (used for hidden AI↔AI DM threads). Idempotent by id. */
  addConversation: (c: ConversationVM) => Promise<void>;
  putPersona: (p: PersonaVM) => Promise<void>;
  putContact: (c: ContactVM) => Promise<void>;
  /**
   * Remove a contact and every trace of them (M-I1). Orchestrates: abort any
   * in-flight generation for their threads → repo cascade → in-memory mirror.
   */
  deleteContact: (id: string) => Promise<void>;
  /** Delete one's own comment (M-I6). */
  deleteComment: (momentId: string, commentId: string) => Promise<void>;
  /** Delete one's own moment with its social rows (M-I6). */
  deleteMoment: (momentId: string) => Promise<void>;
  loadMoments: (force?: boolean) => Promise<void>;
  addMoment: (m: MomentVM) => Promise<void>;
  /** Add or remove a like. Returns true if the moment is liked afterwards. */
  toggleLike: (momentId: string, contactId: string, now: number) => Promise<boolean>;
  /**
   * Idempotently add a like. Distinct from toggleLike because an AI reacting is
   * always an add — toggling would undo the like if the feed happened to be loaded.
   */
  applyLike: (like: MomentLikeVM) => Promise<void>;
  addComment: (c: MomentCommentVM) => Promise<void>;
}

const EMPTY_MESSAGES: MessageVM[] = [];
// Module-level constants: returning a fresh [] from a selector re-renders forever.
const EMPTY_LIKES: MomentLikeVM[] = [];
const EMPTY_COMMENTS: MomentCommentVM[] = [];
const EMPTY_NEWS: MomentsNews = { count: 0, items: [] };

// Fixed timestamp for seeded rows so first-run state is deterministic.
const SEED_BASE = 1_754_500_000_000;

// Module-level so two near-simultaneous hydrate() calls can't seed twice.
let hydrateInFlight = false;

let toastTimer: ReturnType<typeof setTimeout> | undefined;

type Set = (partial: Partial<AppState>) => void;
type Get = () => AppState;

async function doHydrate(set: Set, _get: Get): Promise<void> {
  // Choose the storage driver BEFORE the first Repo read (M-I17): on a native
  // device that completed the SQLite migration this swaps the driver in;
  // everywhere else it is a no-op and IndexedDB stays. Never throws.
  await initStorageDriver();
  // First run: write seed into the Repo so the app has believable friends.
  if (await repo.isEmpty()) {
    const seedMsgs = seedConversations.flatMap((conv) =>
      (seedMessages[conv.id] ?? []).map(({ id: _drop, ...rest }) => rest),
    );
    await (repo as IdbRepo).bulkSeed({
      contacts: seedContacts,
      personas: seedPersonas,
      conversations: seedConversations,
      messages: seedMsgs,
      moments: seedMoments,
      momentLikes: seedMomentLikes,
      momentComments: seedMomentComments,
    });
    // Real packet entities behind the seeded bubbles, so they're tappable.
    for (const rp of seedRedPackets) await repo.putRedPacket(rp);
    // Opening wallet balance so red packets / transfers have something to move.
    await repo.putWalletTx({
      id: 'wtx_seed',
      kind: 'adjust',
      amountFen: 128_800,
      title: '零钱初始余额',
      balanceAfterFen: 128_800,
      createdAt: SEED_BASE,
    });
  }
  const [contacts, conversations] = await Promise.all([
    repo.getContacts(),
    repo.getConversations(),
  ]);
  // Messages are NOT loaded here. Hydration used to pull 200 per conversation
  // — on the critical path of a white screen, growing linearly with how much
  // the app is used — when the only thing the first screen draws is the
  // conversation list, and every row already carries its own `lastMsgPreview`.
  // `openConversation` fetches a thread when it is actually opened.
  const messages: Record<string, MessageVM[]> = {};
  const personas: Record<string, PersonaVM> = {};
  await Promise.all(
    contacts
      .filter((cc) => cc.type === 'ai')
      .map(async (cc) => {
        const p = await repo.getPersona(cc.id);
        // Through makePersona, always: a persona row written before a field
        // existed comes back without it, and an absent field is read as
        // "never posts" / "never likes" rather than erroring — the feature just
        // silently stops working for every pre-existing agent.
        if (p) personas[cc.id] = makePersona(p);
      }),
  );
  // Prime the media registry.
  //
  // METADATA for everything (pool selection needs kind+tags and they cost
  // nothing); object URLs only for AVATARS, which every conversation row draws.
  // Photos are materialized on demand by `primeMedia`.
  //
  // This loop used to `createObjectURL` every item in the library, serially, on
  // the critical path of the first paint — and an object URL pins its blob
  // until revoked, which happened only on delete. A few hundred photos was
  // therefore several hundred megabytes held for the life of the process,
  // behind a white screen while it was built.
  for (const item of await repo.getMedia()) {
    registerMediaMeta(item.id, { kind: item.kind, tags: item.tags });
    if (item.kind === 'avatar') materializeMedia(item.id, item.blob);
  }
  conversations.sort(sortConversations);
  set({ hydrated: true, contacts, conversations, messages, personas });
}

export const useAppStore = create<AppState>((set, get) => ({
  hydrated: false,
  hydrateError: null,
  contacts: [],
  conversations: [],
  messages: {},
  personas: {},
  typing: {},
  activeConvId: null,
  toast: null,
  incomingCall: null,
  moments: [],
  momentsLoaded: false,
  momentLikes: {},
  momentComments: {},
  momentsNews: EMPTY_NEWS,

  contactById: (id) => get().contacts.find((cc) => cc.id === id),
  messagesFor: (convId) => get().messages[convId] ?? EMPTY_MESSAGES,

  /**
   * Has this conversation's thread been loaded?
   *
   * Distinct from "has messages": a conversation can legitimately be empty.
   * Derived from the store rather than from a timer, so it flips in the SAME
   * React commit that renders the messages — which is what makes it a sound
   * readiness signal for anything observing the settled page.
   */
  hasThread: (convId) => get().messages[convId] != null,

  /**
   * Load a conversation's newest page, once, when it is opened.
   *
   * Idempotent: an already-loaded thread is left alone so re-entering does not
   * discard messages that arrived since (or the older pages the user paged in).
   */
  openConversation: async (convId, limit = 60) => {
    if (get().messages[convId] != null) return;
    const rows = await repo.getMessages(convId, { limit });
    set((s) => (s.messages[convId] != null ? s : { messages: { ...s.messages, [convId]: rows } }));
  },

  /**
   * Prepend the page of messages before the oldest one currently held.
   *
   * The `beforeId` pagination pipeline has existed since M1 — `idb.ts` →
   * `repo.getMessages` — with ZERO callers, while hydration loaded a flat 200
   * per conversation. Everything older than that was in the database and
   * unreachable from the app: you could not scroll to it and search could not
   * find it, because search only ever looked at what the store held.
   *
   * Returns how many rows arrived, so the caller can stop asking at the top.
   */
  loadOlderMessages: async (convId, limit = 40) => {
    const existing = get().messages[convId] ?? EMPTY_MESSAGES;
    const oldest = existing[0]?.id;
    if (oldest == null) return 0;
    const older = await repo.getMessages(convId, { limit, beforeId: oldest });
    if (older.length === 0) return 0;
    set((s) => {
      const cur = s.messages[convId] ?? EMPTY_MESSAGES;
      // Guard against a concurrent load having already prepended these: ids
      // are the autoincrement primary key, so "already present" is exact.
      const have = new Set(cur.map((m) => m.id));
      const fresh = older.filter((m) => !have.has(m.id));
      if (fresh.length === 0) return s;
      return { messages: { ...s.messages, [convId]: [...fresh, ...cur] } };
    });
    return older.length;
  },
  reloadConversation: async (convId, limit = 60) => {
    if (get().messages[convId] == null) return;
    const rows = await repo.getMessages(convId, { limit });
    set((s) => ({ messages: { ...s.messages, [convId]: rows } }));
    // The tail may have changed shape (rollback trims scenes): the list row's
    // preview must follow, or a deleted line keeps advertising the thread.
    const s = get();
    const last = rows.at(-1);
    await s.patchConversation(convId, {
      lastMsgPreview: last ? previewOf(last, senderNameOf(s.contacts, last.senderId)) : '',
      ...(last ? { lastMsgAt: last.createdAt } : {}),
    });
  },
  conversationById: (id) => get().conversations.find((cc) => cc.id === id),
  personaFor: (contactId) => get().personas[contactId],
  setTyping: (convId, on) => set((s) => ({ typing: { ...s.typing, [convId]: on } })),
  likesFor: (momentId) => get().momentLikes[momentId] ?? EMPTY_LIKES,
  commentsFor: (momentId) => get().momentComments[momentId] ?? EMPTY_COMMENTS,

  hydrate: async () => {
    if (get().hydrated || hydrateInFlight) return;
    hydrateInFlight = true;
    set({ hydrateError: null });
    try {
      await doHydrate(set, get);
    } catch (e) {
      // An async rejection never reaches the ErrorBoundary — without this the
      // app would sit on the blank loading view forever (bug M7).
      set({ hydrateError: e instanceof Error ? e.message : String(e) });
    } finally {
      hydrateInFlight = false;
    }
  },

  setIncomingCall: (call) => set({ incomingCall: call }),

  showToast: (msg) => {
    set({ toast: msg });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => set({ toast: null }), 2_000);
  },

  setActiveConv: async (convId) => {
    set({ activeConvId: convId });
    if (!convId) return;
    const conv = get().conversations.find((c) => c.id === convId);
    if (conv && (conv.unreadCount > 0 || conv.mentionMe)) {
      await get().patchConversation(convId, { unreadCount: 0, mentionMe: false });
    }
  },

  appendMessage: async (msg) => {
    // Story mode (M-I7): while a beat is playing in this conversation, every
    // appended row — narration, actor lines, the user's replies — is tagged
    // with the run's (scriptId, seq). One choke point, so the group engine
    // and every other append path stay story-blind.
    const saved = await repo.addMessage(applyStoryStamp(msg));
    const s0 = get();
    const conv = s0.conversations.find((c) => c.id === msg.convId);
    set((s) => ({
      messages: { ...s.messages, [msg.convId]: [...(s.messages[msg.convId] ?? []), saved] },
    }));
    // Update the conversation preview + timestamp, and maintain the unread badge:
    // a peer message landing anywhere the user isn't looking counts as unread
    // (hidden AI↔AI threads excluded — their badge must never surface anywhere).
    const patch: Partial<ConversationVM> = {
      lastMsgPreview: previewOf(saved, senderNameOf(s0.contacts, saved.senderId)),
      lastMsgAt: saved.createdAt,
    };
    if (msg.senderId === 'self') {
      // Sending clears the draft — it became this message.
      if (conv?.draft) patch.draft = undefined;
    } else if (conv && !conv.isHidden && s0.activeConvId !== msg.convId) {
      patch.unreadCount = conv.unreadCount + 1;
      if (conv.type === 'group' && mentionsSelf(saved, s0.contacts)) patch.mentionMe = true;
    }
    await get().patchConversation(msg.convId, patch);
    return saved;
  },

  updateMessage: async (msg) => {
    await repo.updateMessage(msg);
    set((s) => ({
      messages: {
        ...s.messages,
        [msg.convId]: (s.messages[msg.convId] ?? []).map((m) => (m.id === msg.id ? msg : m)),
      },
    }));
    // If the conversation tail changed shape (a recall, an edit), the list
    // preview must follow — otherwise a recalled line keeps showing its text.
    const s = get();
    const rows = s.messages[msg.convId] ?? [];
    if (rows.length && rows[rows.length - 1].id === msg.id) {
      await get().patchConversation(msg.convId, {
        lastMsgPreview: previewOf(msg, senderNameOf(s.contacts, msg.senderId)),
      });
    }
  },

  deleteConversation: async (id) => {
    // Cancel the queue BEFORE the row goes: a heartbeat that fires between the
    // two finds a live conversation and re-chains itself, which is exactly the
    // orphan chain we're removing. Failure here must not block the delete.
    await cancelActionsForConversation(id).catch((e) => logError('deleteConv.cancel', e));
    await repo.deleteConversation(id);
    set((s) => {
      const messages = { ...s.messages };
      delete messages[id];
      return { conversations: s.conversations.filter((c) => c.id !== id), messages };
    });
  },

  deleteMessage: async (convId, msgId) => {
    await repo.deleteMessage(msgId);
    set((s) => ({
      messages: {
        ...s.messages,
        [convId]: (s.messages[convId] ?? []).filter((m) => m.id !== msgId),
      },
    }));
    const s = get();
    const last = (s.messages[convId] ?? []).at(-1);
    await s.patchConversation(convId, {
      lastMsgPreview: last ? previewOf(last, senderNameOf(s.contacts, last.senderId)) : '',
      ...(last ? { lastMsgAt: last.createdAt } : {}),
    });
  },

  patchConversation: async (id, patch) => {
    const cur = get().conversations.find((c) => c.id === id);
    if (!cur) return;
    const next = { ...cur, ...patch };
    await repo.putConversation(next);
    set((s) => ({
      conversations: s.conversations.map((c) => (c.id === id ? next : c)).sort(sortConversations),
    }));
  },

  addConversation: async (c) => {
    await repo.putConversation(c);
    set((s) =>
      s.conversations.some((x) => x.id === c.id)
        ? s
        : { conversations: [...s.conversations, c].sort(sortConversations) },
    );
  },

  putPersona: async (p) => {
    await repo.putPersona(p);
    set((s) => ({ personas: { ...s.personas, [p.contactId]: p } }));
  },

  putContact: async (c) => {
    await repo.putContact(c);
    set((s) => ({
      contacts: s.contacts.some((x) => x.id === c.id)
        ? s.contacts.map((x) => (x.id === c.id ? c : x))
        : [...s.contacts, c],
    }));
  },

  deleteComment: async (momentId, commentId) => {
    await repo.deleteComment(commentId);
    set((s) => ({
      momentComments: {
        ...s.momentComments,
        [momentId]: (s.momentComments[momentId] ?? []).filter((c) => c.id !== commentId),
      },
    }));
  },

  deleteMoment: async (momentId) => {
    await repo.deleteMoment(momentId);
    set((s) => {
      const momentLikes = { ...s.momentLikes };
      const momentComments = { ...s.momentComments };
      delete momentLikes[momentId];
      delete momentComments[momentId];
      return {
        moments: s.moments.filter((m) => m.id !== momentId),
        momentLikes,
        momentComments,
      };
    });
  },

  deleteContact: async (id) => {
    // Abort BEFORE the rows go: a reply landing after the cascade would
    // recreate messages for a thread whose contact no longer exists.
    const s0 = get();
    const deadConvs = s0.conversations.filter(
      (c) =>
        c.type === 'single' &&
        (c.peerId === id || (c.isHidden && (c.memberIds ?? []).includes(id))),
    );
    for (const c of deadConvs) abortConversation(c.id);

    await repo.deleteContact(id);

    // Mirror the cascade's visible slice in memory. Cheaper and less
    // disruptive than a full re-hydrate, and exact because the repo cascade's
    // rules are restated here 1:1 for the four stores the UI holds.
    set((s) => {
      const deadIds = new Set(deadConvs.map((c) => c.id));
      const messages = { ...s.messages };
      for (const cid of deadIds) delete messages[cid];
      const personas: typeof s.personas = {};
      for (const [pid, p] of Object.entries(s.personas)) {
        if (pid === id) continue;
        personas[pid] = id in p.relations
          ? { ...p, relations: Object.fromEntries(Object.entries(p.relations).filter(([k]) => k !== id)) }
          : p;
      }
      const deadMoments = new Set(s.moments.filter((m) => m.authorId === id).map((m) => m.id));
      const momentLikes: typeof s.momentLikes = {};
      for (const [mid, ls] of Object.entries(s.momentLikes)) {
        if (deadMoments.has(mid)) continue;
        momentLikes[mid] = ls.filter((l) => l.contactId !== id);
      }
      const momentComments: typeof s.momentComments = {};
      for (const [mid, cs] of Object.entries(s.momentComments)) {
        if (deadMoments.has(mid)) continue;
        momentComments[mid] = cs.filter((c) => c.authorId !== id);
      }
      return {
        contacts: s.contacts.filter((c) => c.id !== id),
        personas,
        conversations: s.conversations
          .filter((c) => !deadIds.has(c.id))
          .map((c) =>
            c.type === 'group' && c.memberIds?.includes(id)
              ? { ...c, memberIds: c.memberIds.filter((m) => m !== id) }
              : c,
          ),
        messages,
        moments: s.moments
          .filter((m) => !deadMoments.has(m.id))
          // Mirror the repo cascade's repost-snapshot scrub (M-I15) 1:1.
          .map((m) => {
            if (m.repostAuthorId !== id) return m;
            const { repostAuthorId: _drop, ...rest } = m;
            return { ...rest, repostExcerpt: '原内容已删除' };
          }),
        momentLikes,
        momentComments,
        activeConvId: s.activeConvId && deadIds.has(s.activeConvId) ? null : s.activeConvId,
      };
    });
  },

  /**
   * Pull a page of the feed plus each post's likes and comments.
   *
   * `force` re-reads even when already loaded. Without it the feed was frozen
   * for the life of the process: the guard below returned early forever, so
   * anything an agent posted in the background only appeared if `addMoment`
   * happened to run in this same session.
   */
  loadMoments: async (force = false) => {
    if (get().momentsLoaded && !force) return;
    const moments = await repo.getMoments();
    // Two queries for the page, not two per post: the old fan-out was 2N+1
    // round trips, so the feed got slower the more you had posted.
    const { likes: momentLikes, comments: momentComments } = await repo.getMomentSocial(
      moments.map((m) => m.id),
    );
    set({ moments, momentLikes, momentComments, momentsLoaded: true });
  },

  addMoment: async (m) => {
    await repo.putMoment(m);
    set((s) => ({
      moments: [m, ...s.moments].sort((a, b) => b.createdAt - a.createdAt),
      momentLikes: { ...s.momentLikes, [m.id]: EMPTY_LIKES },
      momentComments: { ...s.momentComments, [m.id]: EMPTY_COMMENTS },
    }));
    // A friend REPOSTING you is news the same way a like is (M-I15).
    if (m.authorId !== 'self' && m.repostOf) void get().refreshMomentsNews().catch(() => {});
  },

  toggleLike: async (momentId, contactId, now) => {
    const id = `${momentId}:${contactId}`;
    const existing = (get().momentLikes[momentId] ?? []).some((l) => l.id === id);
    if (existing) {
      await repo.deleteLike(id);
      set((s) => ({
        momentLikes: {
          ...s.momentLikes,
          [momentId]: (s.momentLikes[momentId] ?? []).filter((l) => l.id !== id),
        },
      }));
      return false;
    }
    const like: MomentLikeVM = { id, momentId, contactId, createdAt: now };
    await repo.putLike(like);
    set((s) => ({
      momentLikes: { ...s.momentLikes, [momentId]: [...(s.momentLikes[momentId] ?? []), like] },
    }));
    void relEventForLike(momentId, contactId, now);
    return true;
  },

  applyLike: async (like) => {
    await repo.putLike(like);
    void relEventForLike(like.momentId, like.contactId, like.createdAt);
    set((s) => {
      const cur = s.momentLikes[like.momentId] ?? [];
      if (cur.some((l) => l.id === like.id)) return s;
      return { momentLikes: { ...s.momentLikes, [like.momentId]: [...cur, like] } };
    });
    // A friend's like on one of YOUR posts is news (M-I15). Fire-and-forget:
    // the badge is bookkeeping and must never delay the reaction itself.
    if (like.contactId !== 'self') void get().refreshMomentsNews().catch(() => {});
  },

  addComment: async (c) => {
    await repo.putComment(c);
    set((s) => ({
      momentComments: {
        ...s.momentComments,
        [c.momentId]: [...(s.momentComments[c.momentId] ?? []), c].sort(
          (a, b) => a.createdAt - b.createdAt,
        ),
      },
    }));
    if (c.authorId !== 'self') void get().refreshMomentsNews().catch(() => {});
  },

  refreshMomentsNews: async () => {
    // Newest feed page only: the badge is about the recent past, and anything
    // older than a page of posts has scrolled out of "news" territory anyway.
    const moments = await repo.getMoments({ limit: 60 });
    const mine = moments.filter((m) => m.authorId === 'self');
    if (mine.length === 0) {
      if (get().momentsNews.count !== 0) set({ momentsNews: EMPTY_NEWS });
      return;
    }
    const { likes, comments } = await repo.getMomentSocial(mine.map((m) => m.id));
    const seenAt = (await repo.getSetting<number>('momentsSeenAt')) ?? 0;
    // The FULL page rides in (not just `mine`): a friend's repost of your post
    // is a new moment authored by them, and the collector spots it by repostOf.
    const news = collectMomentsNews(moments, likes, comments, seenAt);
    // Keep the stable EMPTY_NEWS reference for the common nothing-new case.
    set({ momentsNews: news.count === 0 ? EMPTY_NEWS : news });
  },

  markMomentsSeen: async (now) => {
    await repo.putSetting('momentsSeenAt', now);
    if (get().momentsNews.count !== 0) set({ momentsNews: EMPTY_NEWS });
  },
}));

/** Pinned first, then by last-message time desc — WeChat's ordering. */
function sortConversations(a: ConversationVM, b: ConversationVM): number {
  if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
  return b.lastMsgAt - a.lastMsgAt;
}

function senderNameOf(contacts: ContactVM[], senderId: string): string | undefined {
  const c = contacts.find((x) => x.id === senderId);
  return c?.remark ?? c?.name;
}

/** Did this group message @-mention the user? Matches WeChat's plain-text @名字. */
export function mentionsSelf(m: MessageVM, contacts: ContactVM[]): boolean {
  if (m.type !== 'text' || !m.content) return false;
  const self = contacts.find((c) => c.type === 'self');
  const name = self?.name ?? '我';
  return m.content.includes(`@${name}`) || m.content.includes('@所有人');
}

/** One-line preview text for the conversation list. */
export function previewOf(m: MessageVM, senderName?: string): string {
  if (m.isRecalled) {
    return m.senderId === 'self' ? '你撤回了一条消息' : `"${senderName ?? '对方'}" 撤回了一条消息`;
  }
  switch (m.type) {
    case 'text':
      return m.content ?? '';
    case 'voice':
      return '[语音]';
    case 'image':
      return '[图片]';
    case 'sticker':
      return '[动画表情]';
    case 'rp':
      return '[微信红包]';
    case 'transfer':
      return '[转账]';
    case 'merged':
      return '[聊天记录]';
    case 'location':
      return `[位置]${m.content ?? ''}`;
    case 'contact_card':
      return `[名片]${(m.meta?.name as string | undefined) ?? m.content ?? ''}`;
    case 'file':
      return `[文件]${(m.meta?.fileName as string | undefined) ?? m.content ?? ''}`;
    case 'link':
      return `[链接]${(m.meta?.title as string | undefined) ?? m.content ?? ''}`;
    case 'game':
      return '[动画表情]';
    default:
      return m.content ?? '';
  }
}
