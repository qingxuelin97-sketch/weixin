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
import { mergeRelationEdges } from '../data/persona-patch';
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
  /**
   * The conversation this build targets, when it already exists (rebuild).
   * A hit switches step 3 from "create the room" to "merge into the room":
   * union rosters, keep pin/mute/unread, adopt the blueprint's title.
   */
  getConversation?: (id: string) => Promise<ConversationVM | undefined>;
  /**
   * Newest existing message's timestamp for the target conversation.
   * The seeded backlog is floored here — a fabricated line stamped before a
   * real message breaks `rowid order == time order` (CLAUDE.md §3.5).
   */
  latestMessageAt?: (convId: string) => Promise<number | undefined>;
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

/**
 * Where an unfinished build is parked — one row PER TARGET CONVERSATION.
 *
 * The old singleton (`groupBuild`) meant a rebuild of group A silently
 * clobbered the resume state of a half-built group B, turning B's paid-for
 * cards into duplicates on the next attempt. Keying by convId (precedent:
 * `topic:<convId>`) makes concurrent states coexist; the ACTIVE pointer is
 * only a convenience for "continue where I left off" on the generate page.
 * It matters that states survive a reload: the CONTACTS are already in the
 * database by then, so a user who reloads mid-build and starts over gets a
 * second copy of everyone they already paid for.
 */
export const buildStateKey = (convId: string) => `groupBuild:${convId}`;
/** Points at the convId of the most recent unfinished build ('' = none). */
export const ACTIVE_BUILD_KEY = 'groupBuildActive';
/** The pre-I1 singleton row — read once for migration, never written again. */
export const LEGACY_BUILD_STATE_KEY = 'groupBuild';

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
 * A build state bound to an EXISTING group (一键重新配置).
 *
 * Blueprint members whose name matches a current member reuse that member's
 * contact — their card is already paid for, so they are pre-marked `made` and
 * the build only generates the genuinely new people. Existing members the
 * blueprint doesn't mention stay in the room (step 3 unions rosters).
 */
export function rebuildState(
  blueprint: GroupBlueprint,
  convId: string,
  existingByName: Record<string, string>,
  now: number,
): BuildState {
  const state = newBuildState(blueprint, now);
  state.convId = convId;
  for (const m of blueprint.members) {
    const contactId = existingByName[m.name];
    if (contactId) state.made[m.key] = contactId;
  }
  return state;
}

/**
 * A build state for a NEW room whose members ALREADY EXIST (M-I3).
 *
 * Two callers need this: 发起群聊 (the user hand-picks friends) and the AI's
 * 拉群提议 card, which lands on that same screen with its roster pre-ticked.
 * Neither has anything to generate — so every member is pre-marked `made`, the
 * same ledger `rebuildState` uses, and `buildGroup` writes zero persona cards
 * and costs zero calls.
 *
 * This exists so those flows go through THE build path instead of assembling a
 * conversation row of their own: one path means "what does creating a group
 * do" has one answer, and a later addition to it lands everywhere.
 */
export function presetState(
  members: Array<{ contactId: string; name: string }>,
  title: string,
  now: number,
): BuildState {
  const blueprint: GroupBlueprint = {
    title,
    topics: [],
    // No briefs and no relations: these people already have lives. Inventing
    // either here would overwrite what the user (or an earlier build) wrote.
    members: members.map((m, i) => ({ key: `p${i}`, name: m.name, brief: '' })),
    relations: [],
  };
  const state = newBuildState(blueprint, now);
  members.forEach((m, i) => {
    state.made[`p${i}`] = m.contactId;
  });
  return state;
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
  //
  // MERGED per edge, never replaced: a rebuild runs this pass over members
  // who already have lives outside this group, and a wholesale `relations:`
  // write would wipe every edge toward people the blueprint has never heard
  // of — irreversible social amnesia that nothing would ever report.
  for (const m of blueprint.members) {
    const contactId = state.made[m.key];
    if (!contactId) continue;
    const stored = deps.getPersona(contactId);
    // Never write a card we could not read: a patch built from a guess would
    // overwrite a perfectly good generated persona with an empty one.
    if (!stored) continue;
    const edges: Record<string, string> = {};
    for (const [key, text] of Object.entries(relationsFor(blueprint, m.key))) {
      const id = state.made[key];
      if (id) edges[id] = text;
    }
    const merged = mergeRelationEdges(stored, edges);
    if (merged !== stored) await deps.putPersona(merged);
  }

  // 3) The conversation itself — created fresh, or merged into the existing
  // room when this is a rebuild (union rosters, keep the user's pin/mute
  // state, adopt the blueprint's title and announcement).
  const now = deps.now();
  const existing = await deps.getConversation?.(state.convId);
  if (existing) {
    await deps.addConversation({
      ...existing,
      title: blueprint.title || existing.title,
      announcement: blueprint.announcement ?? existing.announcement,
      memberIds: [...new Set([...(existing.memberIds ?? []), ...created])],
    });
  } else {
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
  }

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
    // order`, which is what cursor pagination is built on. For a fresh group
    // there is nothing to floor on; for a rebuild the floor is the newest real
    // message, asked from the caller because only storage knows it.
    const floorAt = await deps.latestMessageAt?.(state.convId);
    for (const l of stampHistory(usable, now, floorAt)) {
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

/** Is this build finished? Used to decide whether to offer "继续建群". */
export function isBuildComplete(state: BuildState): boolean {
  return (
    state.historyDone &&
    state.blueprint.members.every((m) => Boolean(state.made[m.key]) || state.failed.includes(m.key))
  );
}
