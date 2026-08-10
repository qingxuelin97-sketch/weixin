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
import { registerMedia } from '../data/media-registry';
import { makePersona } from '../data/persona-defaults';
import { recordRelEvent } from '../ai/relationship';
import { cancelActionsForConversation } from '../ai/scheduler';
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

  /** Moments feed, newest first. Loaded lazily — the feed is not on the hot path. */
  moments: MomentVM[];
  momentsLoaded: boolean;
  /** Keyed by momentId so selectors can return a stable reference (see CLAUDE.md §3.5). */
  momentLikes: Record<string, MomentLikeVM[]>;
  momentComments: Record<string, MomentCommentVM[]>;

  // selectors (stable signatures)
  contactById: (id: string) => ContactVM | undefined;
  messagesFor: (convId: string) => MessageVM[];
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
  loadMoments: () => Promise<void>;
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

// Fixed timestamp for seeded rows so first-run state is deterministic.
const SEED_BASE = 1_754_500_000_000;

// Module-level so two near-simultaneous hydrate() calls can't seed twice.
let hydrateInFlight = false;

let toastTimer: ReturnType<typeof setTimeout> | undefined;

type Set = (partial: Partial<AppState>) => void;
type Get = () => AppState;

async function doHydrate(set: Set, _get: Get): Promise<void> {
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
  const messages: Record<string, MessageVM[]> = {};
  await Promise.all(
    conversations.map(async (conv) => {
      messages[conv.id] = await repo.getMessages(conv.id, { limit: 200 });
    }),
  );
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
  // Prime the media registry so `idb:` refs (avatars, photo pools) resolve
  // synchronously everywhere. Object URLs live for the process lifetime.
  for (const item of await repo.getMedia()) {
    registerMedia(item.id, {
      url: URL.createObjectURL(item.blob),
      kind: item.kind,
      tags: item.tags,
    });
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
  moments: [],
  momentsLoaded: false,
  momentLikes: {},
  momentComments: {},

  contactById: (id) => get().contacts.find((cc) => cc.id === id),
  messagesFor: (convId) => get().messages[convId] ?? EMPTY_MESSAGES,
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
    const saved = await repo.addMessage(msg);
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

  /** Pull the feed plus every post's likes/comments. Idempotent. */
  loadMoments: async () => {
    if (get().momentsLoaded) return;
    const moments = await repo.getMoments();
    const momentLikes: Record<string, MomentLikeVM[]> = {};
    const momentComments: Record<string, MomentCommentVM[]> = {};
    await Promise.all(
      moments.map(async (m) => {
        momentLikes[m.id] = await repo.getLikes(m.id);
        momentComments[m.id] = await repo.getComments(m.id);
      }),
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
    default:
      return m.content ?? '';
  }
}
