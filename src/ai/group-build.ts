/**
 * Turning a group blueprint into an actual群聊 (M-H2).
 *
 * Twelve members is one blueprint call plus twelve card calls: the most
 * expensive single operation this app has. Three consequences shape the whole
 * module:
 *
 *   - RESUMABLE. Progress is persisted after every member, so a network drop
 *     on member 7 costs member 7 and nothing else. Re-running continues from
 *     where it stopped rather than paying for 1-6 again.
 *   - INTERRUPTIBLE. The caller passes a `cancelled` predicate that is checked
 *     between members; a user who changes their mind should not have to watch
 *     eleven more calls complete.
 *   - PARTIAL IS VALID. A member whose card fails is skipped, not fatal. A
 *     nine-person group is a group; a rolled-back twelve-person group is a
 *     wasted twelve calls.
 *
 * Storage and generation are both injected, so the whole flow is testable
 * without a network or a database.
 */
import type { ContactVM, ConversationVM, MessageVM, PersonaVM } from '../data/types';
import { AVATAR_PALETTE } from '../data/avatar-palette';
import { relationsFor, stampHistory, type GroupBlueprint } from './group-generate';

/** Everything the build needs from the outside world. */
export interface BuildDeps {
  /** One member's card. Return null to skip this member. */
  generateCard: (args: {
    brief: string;
    contactId: string;
    takenNames: string[];
  }) => Promise<PersonaVM | null>;
  /** The group's opening backlog. Empty array = skip the history step. */
  generateHistory: (
    blueprint: GroupBlueprint,
  ) => Promise<Array<{ speaker: string; text: string }>>;
  putContact: (c: ContactVM) => Promise<void>;
  putPersona: (p: PersonaVM) => Promise<void>;
  /** Read a card back, for the relations pass. Undefined = not stored (yet). */
  getPersona: (contactId: string) => PersonaVM | undefined;
  addConversation: (c: ConversationVM) => Promise<void>;
  appendMessage: (m: Omit<MessageVM, 'id'>) => Promise<MessageVM>;
  /** Persist/read the resume state. */
  saveState: (s: BuildState) => Promise<void>;
  now: () => number;
  onProgress?: (note: string, done: number, total: number) => void;
  cancelled?: () => boolean;
}

export interface BuildState {
  id: string;
  blueprint: GroupBlueprint;
  convId: string;
  /** blueprint key → assigned contact id. The resume ledger. */
  made: Record<string, string>;
  /** Members whose card generation failed. Retried on a later run. */
  failed: string[];
  historyDone: boolean;
}

export function newBuildState(blueprint: GroupBlueprint, now: number): BuildState {
  const id = `g${now.toString(36)}`;
  return {
    id,
    blueprint,
    convId: `conv_${id}`,
    made: {},
    failed: [],
    historyDone: false,
  };
}

/**
 * A distinct avatar colour per member.
 *
 * Twelve identical grey squares is the fastest way to make a generated group
 * feel generated. The palette cycles when a group outgrows it, but the offset
 * keeps neighbours in the roster apart.
 */
export function avatarColor(index: number): string {
  return AVATAR_PALETTE[index % AVATAR_PALETTE.length];
}

export interface BuildResult {
  convId: string;
  created: string[];
  skipped: string[];
}

export async function buildGroup(state: BuildState, deps: BuildDeps): Promise<BuildResult> {
  const { blueprint } = state;
  const total = blueprint.members.length;

  // 1) Members, one at a time, checkpointing after each.
  for (let i = 0; i < blueprint.members.length; i++) {
    if (deps.cancelled?.()) break;
    const m = blueprint.members[i];
    if (state.made[m.key]) continue; // already paid for on an earlier run
    deps.onProgress?.(`正在写「${m.name}」的人设`, i, total);

    const contactId = `ai_${state.id}_${m.key}`.slice(0, 40);
    const takenNames = blueprint.members.filter((x) => x.key !== m.key).map((x) => x.name);
    let persona: PersonaVM | null = null;
    try {
      persona = await deps.generateCard({
        // The brief carries the group context, so the card is written to fit
        // this room rather than as a standalone character.
        brief: `${m.name}：${m.brief}。TA 在群「${blueprint.title}」里，这个群平时聊${
          blueprint.topics.join('、') || '日常'
        }。`,
        contactId,
        takenNames,
      });
    } catch {
      persona = null;
    }
    if (!persona) {
      if (!state.failed.includes(m.key)) state.failed.push(m.key);
      await deps.saveState(state);
      continue;
    }

    await deps.putContact({
      id: contactId,
      type: 'ai',
      name: m.name,
      avatarColor: avatarColor(i),
      avatarText: m.name.slice(0, 1),
      pinyinInitial: '#',
      wxid: contactId,
    });
    await deps.putPersona(persona);
    state.made[m.key] = contactId;
    state.failed = state.failed.filter((k) => k !== m.key);
    await deps.saveState(state);
  }

  const created = Object.values(state.made);
  const skipped = blueprint.members.filter((m) => !state.made[m.key]).map((m) => m.name);

  // 2) Relations, once every member exists.
  //
  // Written in a second pass on purpose: member 3's card cannot reference
  // member 9's contact id before member 9 has one, and a relations map keyed
  // by a blueprint key would silently resolve to nothing in the prompt layer.
  for (const m of blueprint.members) {
    const contactId = state.made[m.key];
    if (!contactId) continue;
    const stored = deps.getPersona(contactId);
    // Never write a card we could not read: a patch built from a guess would
    // overwrite a perfectly good generated persona with an empty one.
    if (!stored) continue;
    const relations: Record<string, string> = {};
    for (const [key, text] of Object.entries(relationsFor(blueprint, m.key))) {
      const id = state.made[key];
      if (id) relations[id] = text;
    }
    if (Object.keys(relations).length === 0) continue;
    await deps.putPersona({ ...stored, relations });
  }

  // 3) The conversation itself.
  const now = deps.now();
  await deps.addConversation({
    id: state.convId,
    type: 'group',
    title: blueprint.title,
    avatarColor: avatarColor(0),
    avatarText: blueprint.title.slice(0, 1),
    memberIds: created,
    isPinned: false,
    isMuted: false,
    unreadCount: 0,
    mentionMe: false,
    lastMsgPreview: '',
    lastMsgAt: now,
    announcement: blueprint.announcement,
  });

  // 4) A short backlog, so the group does not open as an empty room.
  if (!state.historyDone && created.length > 0 && !deps.cancelled?.()) {
    deps.onProgress?.('正在生成群里已有的聊天', total, total);
    let lines: Array<{ speaker: string; text: string }> = [];
    try {
      lines = await deps.generateHistory(blueprint);
    } catch {
      lines = [];
    }
    const usable = lines
      .filter((l) => state.made[l.speaker] && l.text.trim())
      .slice(0, 30);
    // Timestamps must never predate the conversation's own newest message —
    // the row is inserted NOW, and an older stamp inverts `rowid order == time
    // order`, which is what cursor pagination is built on.
    for (const l of stampHistory(usable, now, undefined)) {
      await deps.appendMessage({
        convId: state.convId,
        senderId: state.made[l.speaker],
        type: 'text',
        content: l.text.trim().slice(0, 120),
        status: 'sent',
        createdAt: l.at,
      });
    }
    state.historyDone = true;
    await deps.saveState(state);
  }

  return { convId: state.convId, created, skipped };
}
