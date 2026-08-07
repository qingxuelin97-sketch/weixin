/**
 * App store (zustand), backed by the Repo (IndexedDB in M2, native SQLite at M3).
 * State is hydrated from the Repo on startup; mutations write through to the Repo
 * so data survives refresh. Component-facing selectors keep their M1 signatures.
 */
import { create } from 'zustand';
import type { ContactVM, ConversationVM, MessageVM, PersonaVM } from '../data/types';
import { seedContacts, seedConversations, seedMessages, seedPersonas } from '../data/seed';
import { repo, IdbRepo } from '../db/repo';

interface AppState {
  hydrated: boolean;
  contacts: ContactVM[];
  conversations: ConversationVM[];
  messages: Record<string, MessageVM[]>;
  personas: Record<string, PersonaVM>;
  /** Conversations currently showing "对方正在输入…". */
  typing: Record<string, boolean>;

  // selectors (stable signatures)
  contactById: (id: string) => ContactVM | undefined;
  messagesFor: (convId: string) => MessageVM[];
  conversationById: (id: string) => ConversationVM | undefined;
  personaFor: (contactId: string) => PersonaVM | undefined;
  setTyping: (convId: string, on: boolean) => void;

  // lifecycle & mutations (write through to Repo)
  hydrate: () => Promise<void>;
  appendMessage: (msg: Omit<MessageVM, 'id'>) => Promise<MessageVM>;
  updateMessage: (msg: MessageVM) => Promise<void>;
  patchConversation: (id: string, patch: Partial<ConversationVM>) => Promise<void>;
  putPersona: (p: PersonaVM) => Promise<void>;
  putContact: (c: ContactVM) => Promise<void>;
}

const EMPTY_MESSAGES: MessageVM[] = [];

export const useAppStore = create<AppState>((set, get) => ({
  hydrated: false,
  contacts: [],
  conversations: [],
  messages: {},
  personas: {},
  typing: {},

  contactById: (id) => get().contacts.find((cc) => cc.id === id),
  messagesFor: (convId) => get().messages[convId] ?? EMPTY_MESSAGES,
  conversationById: (id) => get().conversations.find((cc) => cc.id === id),
  personaFor: (contactId) => get().personas[contactId],
  setTyping: (convId, on) => set((s) => ({ typing: { ...s.typing, [convId]: on } })),

  hydrate: async () => {
    if (get().hydrated) return;
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
          if (p) personas[cc.id] = p;
        }),
    );
    conversations.sort(sortConversations);
    set({ hydrated: true, contacts, conversations, messages, personas });
  },

  appendMessage: async (msg) => {
    const saved = await repo.addMessage(msg);
    set((s) => ({
      messages: { ...s.messages, [msg.convId]: [...(s.messages[msg.convId] ?? []), saved] },
    }));
    // Update the conversation preview + timestamp.
    await get().patchConversation(msg.convId, {
      lastMsgPreview: previewOf(saved),
      lastMsgAt: saved.createdAt,
    });
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
}));

/** Pinned first, then by last-message time desc — WeChat's ordering. */
function sortConversations(a: ConversationVM, b: ConversationVM): number {
  if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
  return b.lastMsgAt - a.lastMsgAt;
}

/** One-line preview text for the conversation list. */
function previewOf(m: MessageVM): string {
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
