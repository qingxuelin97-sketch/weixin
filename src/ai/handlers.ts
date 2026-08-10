/**
 * Every scheduled-action handler, as a plain exported function (M-E1).
 *
 * These used to live inside `useSchedulerRuntime`'s useEffect closure, reading
 * `useAppStore.getState()` and the module-level `repo` directly. That made them
 * completely untestable — you cannot call a closure, and there is no seam to
 * substitute storage or an LLM. Eleven handlers, ~200 lines of the app's most
 * consequential branching (does she speak? does she stay silent? does this
 * chain continue?), with zero unit tests, about to gain four more kinds.
 *
 * The shape here is deliberately boring: one `HandlerDeps` bag of narrow
 * functions, one exported handler per kind, no ambient state. `useSchedulerRuntime`
 * builds the bag from the store and registers them; tests build it from fakes.
 *
 * WHAT DOES NOT BELONG HERE: scheduling policy (heartbeat.ts / moments-service),
 * generation (engine / group-engine), and storage shape (repo). A handler
 * decides "should this still happen, and with what", then delegates.
 */
import type {
  ContactVM,
  ConversationVM,
  MessageVM,
  MomentVM,
  PersonaVM,
  MemoryFactVM,
  ConvSummaryVM,
  NsfwTierVM,
} from '../data/types';
import type { LlmRouter } from '../llm/router';
import type { ScheduledAction } from './scheduler';
import type { DmPlan } from './agent-dm';
import type { EngineHooks } from './engine';
import type { GroupMember } from './director';

/**
 * Everything the handlers are allowed to touch. Narrow on purpose: adding a
 * field here is a deliberate act, and a fake in a test has to implement it.
 */
export interface HandlerDeps {
  // --- read models (store-backed) ---
  contactById: (id: string) => ContactVM | undefined;
  personaFor: (id: string) => PersonaVM | undefined;
  conversationById: (id: string) => ConversationVM | undefined;
  messagesFor: (convId: string) => MessageVM[];
  /** Does this conversation still exist? A deleted one must stop its chains. */
  conversationExists: (convId: string) => boolean;

  // --- writes ---
  hooks: EngineHooks;
  updateMessage: (m: MessageVM) => Promise<void>;

  // --- storage ---
  getMessages: (convId: string, opts?: { limit?: number }) => Promise<MessageVM[]>;
  getMemory: (subjectId: string) => Promise<MemoryFactVM[]>;
  putConvSummary: (s: ConvSummaryVM) => Promise<void>;
  getGlobalTier: () => Promise<NsfwTierVM>;
  getMoment: (id: string) => Promise<MomentVM | undefined>;

  // --- collaborators ---
  getRouter: () => Promise<LlmRouter>;
  now: () => number;

  // --- domain services, injected so a handler test never reaches the network ---
  claimRedPacket: (rpId: string, contactId: string, name: string, hooks: EngineHooks) => Promise<unknown>;
  acceptTransfer: (transferId: string, hooks: EngineHooks) => Promise<unknown>;
  sendProactiveMessage: (
    convId: string,
    peer: ContactVM,
    persona: PersonaVM,
    tier: NsfwTierVM,
    hooks: EngineHooks,
    at?: number,
    opts?: { nudge?: boolean },
  ) => Promise<void>;
  sendGroupProactiveMessage: (
    conv: ConversationVM,
    speaker: GroupMember,
    members: GroupMember[],
    tier: NsfwTierVM,
    hooks: EngineHooks,
    contactById: (id: string) => ContactVM | undefined,
    at: number,
    hint?: string,
  ) => Promise<void>;
  runMemExtract: (args: { convId: string; contactId: string; uptoMsgId: number }) => Promise<void>;
  runAgentDm: (plan: DmPlan) => Promise<boolean>;
  runMomentPost: (persona: PersonaVM, peer: ContactVM, at?: number) => Promise<void>;
  runMomentLike: (momentId: string, contactId: string, at?: number) => Promise<void>;
  runMomentComment: (
    momentId: string,
    commenter: ContactVM,
    persona: PersonaVM,
    authorName: string,
    at?: number,
  ) => Promise<void>;

  // --- chaining ---
  chainHeartbeat: (persona: PersonaVM, convId: string, lastMsgAt?: number) => Promise<void>;
  chainAgentDm: () => Promise<void>;
  chainMomentPost: (persona: PersonaVM) => Promise<void>;

  // --- side effects ---
  playMessageSound: (at: number) => void;
  shouldFollowUpAfterRecall: (msgId: number) => boolean;
  recallFollowUpLine: (persona: PersonaVM, msgId: number) => string;
}

/* ---------- payload readers (a malformed row must never throw) ---------- */

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const optNum = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;

/* ------------------------------ money ------------------------------ */

/** An AI member grabs a share of a red packet. */
export async function handleRpGrab(d: HandlerDeps, payload: Record<string, unknown>): Promise<void> {
  const contactId = str(payload.contactId);
  const rpId = str(payload.rpId);
  if (!contactId || !rpId) return;
  const who = d.contactById(contactId);
  await d.claimRedPacket(rpId, contactId, who?.remark ?? who?.name ?? contactId, d.hooks);
}

/** The peer accepts a transfer the user sent. */
export async function handleTransferAccept(
  d: HandlerDeps,
  payload: Record<string, unknown>,
): Promise<void> {
  const transferId = str(payload.transferId);
  if (transferId) await d.acceptTransfer(transferId, d.hooks);
}

/* ---------------------------- heartbeat ---------------------------- */

/**
 * Should this heartbeat still happen? Split out because it is the one decision
 * in the app that can silently cost money forever when it goes wrong: a
 * conversation deleted after the row was queued used to generate a full reply,
 * discover it had nowhere to put it, and chain the next one.
 */
export function heartbeatTarget(
  d: HandlerDeps,
  payload: Record<string, unknown>,
): { convId: string; peer: ContactVM; persona: PersonaVM } | null {
  const contactId = str(payload.contactId);
  const convId = str(payload.convId);
  if (!contactId || !convId) return null;
  const peer = d.contactById(contactId);
  const persona = d.personaFor(contactId);
  if (!peer || !persona) return null;
  if (!d.conversationExists(convId)) return null;
  return { convId, peer, persona };
}

/** Queue the NEXT heartbeat. Runs before the generation (see registerChainedHandler). */
export async function chainHeartbeat(
  d: HandlerDeps,
  payload: Record<string, unknown>,
): Promise<void> {
  const target = heartbeatTarget(d, payload);
  if (!target) return; // deleted conversation → chain ends here, deliberately
  const lastMsgAt = d.messagesFor(target.convId).at(-1)?.createdAt;
  await d.chainHeartbeat(target.persona, target.convId, lastMsgAt);
}

/** An AI reaches out on its own. */
export async function handleHeartbeat(
  d: HandlerDeps,
  payload: Record<string, unknown>,
  action: ScheduledAction,
): Promise<void> {
  const target = heartbeatTarget(d, payload);
  if (!target) return;
  const { convId, peer, persona } = target;
  const at = optNum(payload.at);
  const body = typeof payload.body === 'string' ? payload.body : undefined;

  if (body) {
    // A notification may already have shown this exact text on the lock screen.
    // Persist it verbatim, stamped at the time it was advertised — regenerating
    // here would contradict what the user already read.
    const stamp = at ?? action.fireAt;
    await d.hooks.appendMessage({
      convId,
      senderId: peer.id,
      type: 'text',
      content: body,
      status: 'sent',
      createdAt: stamp,
    });
    // Stamped so a backfilled past message stays silent; a live one dings.
    d.playMessageSound(stamp);
    return;
  }

  const tier = await d.getGlobalTier();
  await d.sendProactiveMessage(convId, peer, persona, tier, d.hooks, at, {
    nudge: payload.nudge === true,
  });
}

/* ------------------------------ recall ------------------------------ */

/**
 * Flip a sent message to recalled (the send-then-recall drama's second act).
 * Idempotent: a re-fired action finds isRecalled already true and stops.
 */
export async function handleRecall(d: HandlerDeps, payload: Record<string, unknown>): Promise<void> {
  const msgId = Number(payload.msgId);
  const convId = str(payload.convId);
  if (!msgId || !convId) return;
  const msg = d.messagesFor(convId).find((m) => m.id === msgId);
  if (!msg || msg.isRecalled) return;
  await d.updateMessage({ ...msg, isRecalled: true });

  // The cover line — sometimes they can't leave the recall alone.
  if (msg.senderId !== 'self' && d.shouldFollowUpAfterRecall(msgId)) {
    const persona = d.personaFor(msg.senderId);
    if (!persona) return;
    const now = d.now();
    await d.hooks.appendMessage({
      convId,
      senderId: msg.senderId,
      type: 'text',
      content: d.recallFollowUpLine(persona, msgId),
      status: 'sent',
      createdAt: now,
    });
    d.playMessageSound(now);
  }
}

/* ---------------------------- group chat ---------------------------- */

/** A group member says something unprompted (backfill chatter, or a DM spill). */
export async function handleGroupMsg(
  d: HandlerDeps,
  payload: Record<string, unknown>,
  action: ScheduledAction,
): Promise<void> {
  const convId = str(payload.convId);
  const contactId = str(payload.contactId);
  const at = optNum(payload.at) ?? action.fireAt;
  if (!convId || !contactId) return;
  const conv = d.conversationById(convId);
  if (!conv || conv.type !== 'group') return;

  const members: GroupMember[] = (conv.memberIds ?? []).map((id) => {
    const c = d.contactById(id);
    return { contactId: id, name: c?.remark ?? c?.name ?? id, persona: d.personaFor(id) };
  });
  const speaker = members.find((m) => m.contactId === contactId);
  if (!speaker?.persona) return;

  const tier = await d.getGlobalTier();
  const hint = typeof payload.hint === 'string' ? payload.hint : undefined;
  await d.sendGroupProactiveMessage(conv, speaker, members, tier, d.hooks, d.contactById, at, hint);
}

/* ---------------------------- memory pass ---------------------------- */

/**
 * Post-conversation memory pass. The whole body lives in `runMemExtract` (it
 * needs the router and the tier authority); this is the payload gate.
 */
export async function handleMemExtract(
  d: HandlerDeps,
  payload: Record<string, unknown>,
): Promise<void> {
  const convId = str(payload.convId);
  const contactId = str(payload.contactId);
  const uptoMsgId = Number(payload.uptoMsgId ?? 0);
  if (!convId || !contactId || !uptoMsgId) return;
  // A deleted conversation has nothing to remember, and extracting from a
  // half-deleted one would write facts citing messages that no longer exist.
  if (!d.conversationExists(convId)) return;
  await d.runMemExtract({ convId, contactId, uptoMsgId });
}

/* ------------------------------ agent DM ------------------------------ */

export function dmPlanFrom(payload: Record<string, unknown>, fallbackNow: number): DmPlan | null {
  const plan: DmPlan = {
    a: str(payload.a),
    b: str(payload.b),
    groupId: str(payload.groupId),
    fireAt: optNum(payload.fireAt) ?? fallbackNow,
  };
  return plan.a && plan.b && plan.groupId ? plan : null;
}

/** Chain the next DM session. Runs first: one failed exchange must not end the mechanism. */
export async function chainAgentDm(d: HandlerDeps): Promise<void> {
  await d.chainAgentDm();
}

/** Two agents have a private exchange the user never sees. */
export async function handleAgentDm(
  d: HandlerDeps,
  payload: Record<string, unknown>,
): Promise<void> {
  const plan = dmPlanFrom(payload, d.now());
  if (!plan) return;
  await d.runAgentDm(plan);
}

/* ------------------------------ moments ------------------------------ */

/** Chain this persona's next post before writing the current one. */
export async function chainMomentPost(
  d: HandlerDeps,
  payload: Record<string, unknown>,
): Promise<void> {
  const persona = d.personaFor(str(payload.contactId));
  if (persona) await d.chainMomentPost(persona);
}

/** An AI publishes a post, which in turn queues the reactions it draws. */
export async function handleMomentPost(
  d: HandlerDeps,
  payload: Record<string, unknown>,
): Promise<void> {
  const contactId = str(payload.contactId);
  const peer = d.contactById(contactId);
  const persona = d.personaFor(contactId);
  if (!peer || !persona) return;
  await d.runMomentPost(persona, peer, optNum(payload.at));
}

export async function handleMomentLike(
  d: HandlerDeps,
  payload: Record<string, unknown>,
): Promise<void> {
  const momentId = str(payload.momentId);
  const contactId = str(payload.contactId);
  if (!momentId || !contactId) return;
  await d.runMomentLike(momentId, contactId, optNum(payload.at));
}

export async function handleMomentComment(
  d: HandlerDeps,
  payload: Record<string, unknown>,
): Promise<void> {
  const momentId = str(payload.momentId);
  const contactId = str(payload.contactId);
  if (!momentId || !contactId) return;
  const commenter = d.contactById(contactId);
  const persona = d.personaFor(contactId);
  if (!commenter || !persona) return;
  const moment = await d.getMoment(momentId);
  if (!moment) return;
  const author = d.contactById(moment.authorId);
  const authorName = moment.authorId === 'self' ? '你' : (author?.remark ?? author?.name ?? '朋友');
  await d.runMomentComment(momentId, commenter, persona, authorName, optNum(payload.at));
}
