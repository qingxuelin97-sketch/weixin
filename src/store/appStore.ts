/**
 * App store (zustand). For M1 it holds seeded conversations/messages/contacts in
 * memory. In M2 this is backed by the SQLite repository; the component-facing
 * selectors stay the same so the UI doesn't change when persistence lands.
 */
import { create } from 'zustand';
import type { ContactVM, ConversationVM, MessageVM } from '../data/types';
import { seedContacts, seedConversations, seedMessages } from '../data/seed';

interface AppState {
  contacts: ContactVM[];
  conversations: ConversationVM[];
  messages: Record<string, MessageVM[]>;
  contactById: (id: string) => ContactVM | undefined;
  messagesFor: (convId: string) => MessageVM[];
  conversationById: (id: string) => ConversationVM | undefined;
}

// Stable empty-array constant so `messagesFor` on an empty conversation never
// returns a fresh reference (which would loop useSyncExternalStore — React #185).
const EMPTY_MESSAGES: MessageVM[] = [];

export const useAppStore = create<AppState>((_set, get) => ({
  contacts: seedContacts,
  conversations: [...seedConversations].sort(sortConversations),
  messages: seedMessages,
  contactById: (id) => get().contacts.find((cc) => cc.id === id),
  messagesFor: (convId) => get().messages[convId] ?? EMPTY_MESSAGES,
  conversationById: (id) => get().conversations.find((cc) => cc.id === id),
}));

/** Pinned first, then by last-message time desc — WeChat's ordering. */
function sortConversations(a: ConversationVM, b: ConversationVM): number {
  if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
  return b.lastMsgAt - a.lastMsgAt;
}
