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
} from '../data/types';
import {
  idbGetAll,
  idbGet,
  idbPut,
  idbAdd,
  idbDelete,
  idbBulkPut,
  idbCount,
  idbQueryByIndex,
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

  // messages (autoincrement id; per-conversation cursor pagination)
  getMessages(convId: string, opts?: { limit?: number; beforeId?: number }): Promise<MessageVM[]>;
  addMessage(msg: Omit<MessageVM, 'id'>): Promise<MessageVM>;
  updateMessage(msg: MessageVM): Promise<void>;

  // memory
  getMemory(subjectId: string): Promise<MemoryFactVM[]>;
  putMemory(f: MemoryFactVM): Promise<void>;
  deleteMemory(id: string): Promise<void>;

  // providers & settings
  getProviders(): Promise<ProviderVM[]>;
  putProvider(p: ProviderVM): Promise<void>;
  deleteProvider(id: string): Promise<void>;
  getSetting<T>(key: string): Promise<T | undefined>;
  putSetting<T>(key: string, value: T): Promise<void>;

  isEmpty(): Promise<boolean>;
}

/** IndexedDB-backed Repo (web / PWA driver). */
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

  async getMemory(subjectId: string) {
    return idbQueryBySubject<MemoryFactVM>('memory_facts', subjectId);
  }
  async putMemory(f: MemoryFactVM) {
    await idbPut('memory_facts', f);
  }
  async deleteMemory(id: string) {
    await idbDelete('memory_facts', id);
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

  async isEmpty() {
    return (await idbCount('conversations')) === 0;
  }

  async bulkSeed(data: {
    contacts: ContactVM[];
    personas: PersonaVM[];
    conversations: ConversationVM[];
    messages: Array<Omit<MessageVM, 'id'>>;
  }) {
    await idbBulkPut('contacts', data.contacts);
    await idbBulkPut('personas', data.personas);
    await idbBulkPut('conversations', data.conversations);
    // Messages use autoincrement — add in order so ids ascend with time.
    for (const m of data.messages) await idbAdd('messages', m);
  }
}

/** All memory rows for a subject. Memory ids are string UUIDs (not the numeric
 *  id the paginated cursor helper assumes), so filter in-memory here. */
async function idbQueryBySubject<T extends { subjectId?: string }>(
  store: string,
  subjectId: string,
): Promise<T[]> {
  const all = await idbGetAll<T>(store);
  return all.filter((r) => r.subjectId === subjectId);
}

/** The app's single Repo instance (web driver). */
export const repo: Repo & { bulkSeed?: IdbRepo['bulkSeed'] } = new IdbRepo();
