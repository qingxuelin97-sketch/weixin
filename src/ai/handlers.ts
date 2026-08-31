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
import type { GiftPayload } from './gift-service';
import type { EngineHooks } from './engine';
import type { GroupMember } from './director';
import { getConvState, putConvState, refineConvState } from './conv-state';
import { logError } from '../lib/errlog';
import { maxTier } from '../lib/nsfw-tier';
import { dmConvId, participantsOf } from './agent-dm';
import { extractJson } from './generate-chain';
import type { ScheduledActionKind } from '../db/schema';
import {
  maybeJointPlan,
  jointMomentsSystem,
  parseJointMoments,
  jointStaggerMs,
  JOINT_ACTIVITIES,
  type JointKind,
} from './social-plans';
import { canForwardFrom, maybeForward, forwardLine } from './agent-forward';
import { inviteLine, inviteCardGapMs } from './agent-invite';
import { contactCardPayload } from './bubble-materialize';
import {
  nextPhase,
  phaseDelayMs,
  rsvpGapMs,
  rsvpSystem,
  parseRsvps,
  aftermathSystem,
  aftermathImageCount,
  EVENT_ACTIVITIES,
  RSVP_MAX,
  type EventActivity,
  type EventPhase,
} from './group-events';
import { pickImages } from '../data/moments-images';

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
  /** 24h uncollected → the money goes back (M-I18). No-op if already settled. */
  returnTransfer: (transferId: string, hooks: EngineHooks, at?: number) => Promise<unknown>;
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
  /** A close friend reposts the user's post (M-I15). */
  runMomentRepost: (
    momentId: string,
    reposter: ContactVM,
    persona: PersonaVM,
    at?: number,
  ) => Promise<void>;
  /** Deliver a planned red packet / transfer from an agent (M-H1). */
  runGift: (p: GiftPayload) => Promise<void>;
  /** Raise an incoming-call overlay. Returns false if it could not ring. */
  ringUser: (convId: string, contactId: string, reason: string) => boolean;

  // --- social fabric (M-I3) ---
  /** Publish a moment directly (joint plans write both sides themselves). */
  addMoment: (m: MomentVM) => Promise<void>;
  /** Queue a scheduled action. Stable id = idempotent upsert (see scheduler). */
  enqueue: (opts: {
    kind: ScheduledActionKind;
    fireAt: number;
    payload: Record<string, unknown>;
    id?: string;
  }) => Promise<void>;
  /** The contact's user-visible 1:1 thread, if any. Hidden DMs never match. */
  visibleConvWithUser: (contactId: string) => ConversationVM | undefined;

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

/**
 * 24h passed and nobody collected: the money goes home (M-I18).
 *
 * A no-op unless the transfer is still pending, so the row is safe to leave
 * queued after an accept rather than paying a pending-set scan to cancel it.
 */
export async function handleTransferReturn(
  d: HandlerDeps,
  payload: Record<string, unknown>,
): Promise<void> {
  const transferId = str(payload.transferId);
  if (transferId) await d.returnTransfer(transferId, d.hooks, optNum(payload.at));
}

/* ----------------------------- 斗图 (M-I18) ----------------------------- */

/**
 * Her wordless sticker comeback.
 *
 * The decision (does she play, with which sticker, after how long) was already
 * made and seeded when the user's sticker landed — this only delivers it. That
 * split is why the delay could move onto the queue at all: nothing here needs
 * an rng, a persona or a prompt, so a reply queued before the app was closed
 * still lands correctly whenever the queue is next drained.
 */
export async function handleStickerReply(
  d: HandlerDeps,
  payload: Record<string, unknown>,
): Promise<void> {
  const convId = str(payload.convId);
  const contactId = str(payload.contactId);
  const content = str(payload.content);
  if (!convId || !contactId || !content) return;
  // The conversation may have been deleted inside the 0.8–2.5s window.
  if (!d.conversationExists(convId)) return;
  const at = optNum(payload.at) ?? d.now();
  await d.hooks.appendMessage({
    convId,
    senderId: contactId,
    type: 'sticker',
    content,
    status: 'sent',
    createdAt: at,
  });
  d.playMessageSound(at);
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
  // From the conversation ROW, not the message slice: threads are loaded on
  // open now (M-G2), so a conversation the user has not visited this session
  // holds no messages in the store — and reading `undefined` here would make
  // every such agent behave as if you had never spoken.
  const lastMsgAt = d.conversationById(target.convId)?.lastMsgAt;
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
  // Straight from storage for the same reason: the recall fires minutes after
  // the message, by which time the user may never have opened that thread.
  const msg =
    d.messagesFor(convId).find((m) => m.id === msgId) ??
    (await d.getMessages(convId, { limit: 50 })).find((m) => m.id === msgId);
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

  // Channel 2 of the conversation state (M-G0). `specs/agents.md` specified a
  // dual channel — the per-turn regex fold plus a memory pass that corrects
  // it — and only channel 1 was ever built. The regex pass cannot tell that a
  // question was answered forty messages later, so its rows go stale and she
  // keeps chasing things you already settled.
  //
  // Riding this job means it costs no extra tokens: the facts were distilled
  // by the extraction that just ran. Never allowed to fail the handler —
  // conversational state is a nicety, memory is the point.
  try {
    const [state, facts] = await Promise.all([getConvState(convId), d.getMemory(contactId)]);
    await putConvState(convId, refineConvState(state, facts, d.now()));
  } catch (e) {
    logError('convState.refine', e);
  }
}

/* ------------------------------ agent DM ------------------------------ */

export function dmPlanFrom(payload: Record<string, unknown>, fallbackNow: number): DmPlan | null {
  // `c` is the optional third participant (M-I3 bounded trio). A payload that
  // names the same person twice, or one the plan already has, collapses back to
  // a pair — `participantsOf` dedupes and caps at MAX_DM_PARTICIPANTS.
  const third = str(payload.c);
  const plan: DmPlan = {
    a: str(payload.a),
    b: str(payload.b),
    ...(third ? { c: third } : {}),
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
  const ok = await d.runAgentDm(plan);
  if (!ok) return;

  // Social fabric (M-I3): a completed private exchange occasionally hatches
  // visible consequences. Both decisions are pure and seeded off the DM's
  // identity, and both enqueue with STABLE ids — replaying this handler
  // (backfill, retry) upserts the same rows instead of multiplying them.
  const now = d.now();
  const dmId = dmConvId(...participantsOf(plan));
  try {
    const jp = maybeJointPlan(dmId, now);
    if (jp) {
      await d.enqueue({
        kind: 'joint_plan',
        fireAt: jp.fireAt,
        payload: { a: plan.a, b: plan.b, kind: jp.kind, dmId, at: jp.fireAt },
        id: `joint_${dmId}_${jp.fireAt}`,
      });
    }
    // A forward quotes the user's own words into the group — allowed ONLY
    // from a user-visible thread. The hidden DM that triggered this handler
    // is never a quotable source; `maybeForward` re-checks that too.
    const src = d.visibleConvWithUser(plan.a);
    if (src) {
      const lastUser = [...d.messagesFor(src.id)]
        .reverse()
        .find((m) => m.senderId === 'self' && m.type === 'text' && m.content && !m.isRecalled);
      const fw = maybeForward(src, lastUser?.content, dmId, now);
      if (fw) {
        await d.enqueue({
          kind: 'agent_forward',
          fireAt: fw.fireAt,
          payload: {
            speakerId: plan.a,
            sourceConvId: src.id,
            groupId: plan.groupId,
            quote: fw.quote,
            at: fw.fireAt,
          },
          id: `fwd_${dmId}_${fw.fireAt}`,
        });
      }
    }
  } catch (e) {
    logError('social.hatch', e); // the DM itself succeeded — never undo that
  }
}

/* --------------------------- social fabric (M-I3) --------------------------- */

/**
 * A joint plan materializes: ONE LLM call writes BOTH members' moments about
 * the same outing, staggered by a believable gap. Either contact having been
 * deleted since the plan was hatched drops the whole thing silently.
 */
export async function handleJointPlan(
  d: HandlerDeps,
  payload: Record<string, unknown>,
): Promise<void> {
  const a = str(payload.a);
  const b = str(payload.b);
  const kindRaw = str(payload.kind);
  const dmId = str(payload.dmId);
  if (!(kindRaw in JOINT_ACTIVITIES)) return;
  const kind = kindRaw as JointKind;
  const ca = d.contactById(a);
  const cb = d.contactById(b);
  const pa = d.personaFor(a);
  const pb = d.personaFor(b);
  if (!ca || !cb || !pa || !pb) return;
  const at = optNum(payload.at) ?? d.now();

  const router = await d.getRouter();
  // Rule #6: the pair's real tier, derived — moments are user-visible surface.
  const tier = maxTier(await d.getGlobalTier(), [pa, pb]);
  const raw = await router.complete(
    {
      role: 'chat',
      nsfwTier: tier,
    },
    {
      messages: [
        {
          role: 'system',
          content: jointMomentsSystem(
            kind,
            { name: ca.remark ?? ca.name, style: pa.speechStyle },
            { name: cb.remark ?? cb.name, style: pb.speechStyle },
          ),
        },
        { role: 'user', content: '写吧。' },
      ],
      json: true,
      maxTokens: 300,
    },
    {},
    `joint:${dmId}`,
  );
  const texts = parseJointMoments(extractJson(raw.text));
  if (!texts) return;

  await d.addMoment({
    id: `m_joint_${dmId}_${at}_a`,
    authorId: a,
    text: texts.a,
    imageRefs: [],
    // M-J0: was hard-coded false while the ROUTE was tier-derived — a
    // full-tier pair could publish permissive-channel output stamped 全年龄.
    // The stamp now tells the truth the router already knew.
    isNsfw: tier === 'full',
    createdAt: at,
  });
  await d.addMoment({
    id: `m_joint_${dmId}_${at}_b`,
    authorId: b,
    text: texts.b,
    imageRefs: [],
    isNsfw: tier === 'full',
    createdAt: at + jointStaggerMs(dmId, at),
  });
}

/**
 * Chain the group event's next phase BEFORE this phase's work runs — a flaky
 * propose call must not kill the whole arc (the story_tick lesson). A deleted
 * room, or a terminal phase, simply stops chaining.
 */
export async function chainGroupEvent(
  d: HandlerDeps,
  payload: Record<string, unknown>,
): Promise<void> {
  const convId = str(payload.convId);
  const eventId = str(payload.eventId);
  const next = nextPhase(str(payload.phase));
  if (!next || !eventId || !d.conversationExists(convId)) return;
  const at = (optNum(payload.at) ?? d.now()) + phaseDelayMs(next, eventId);
  await d.enqueue({
    kind: 'group_event',
    fireAt: at,
    payload: { ...payload, phase: next, at },
    id: `${eventId}_${next}`,
  });
}

/**
 * One phase of the聚会 arc fires. Every phase costs at most ONE LLM call
 * (GROUP_EVENT_LLM_CALLS_PER_PHASE) — the RSVP round in particular is a
 * single dispatch that writes every member's line.
 */
export async function handleGroupEvent(
  d: HandlerDeps,
  payload: Record<string, unknown>,
): Promise<void> {
  const convId = str(payload.convId);
  const eventId = str(payload.eventId);
  const initiator = str(payload.initiator);
  const activityRaw = str(payload.activity);
  const phase = str(payload.phase) as EventPhase;
  if (!(activityRaw in EVENT_ACTIVITIES)) return;
  const activity = activityRaw as EventActivity;
  const conv = d.conversationById(convId);
  if (!conv || conv.type !== 'group' || conv.isHidden) return;
  const memberIds = (conv.memberIds ?? []).filter((id) => d.personaFor(id));
  if (!memberIds.includes(initiator)) return; // initiator left the room
  const at = optNum(payload.at) ?? d.now();
  const nameOf = (id: string) => {
    const c = d.contactById(id);
    return c?.remark ?? c?.name ?? id;
  };

  if (phase === 'propose') {
    const speaker = {
      contactId: initiator,
      name: nameOf(initiator),
      persona: d.personaFor(initiator),
    };
    const tier = maxTier(
      await d.getGlobalTier(),
      memberIds.map((id) => d.personaFor(id)),
    );
    // Rides the ordinary group proactive machinery — one call, persona voice.
    await d.sendGroupProactiveMessage(
      conv,
      speaker,
      memberIds.map((id) => ({ contactId: id, name: nameOf(id), persona: d.personaFor(id) })),
      tier,
      d.hooks,
      d.contactById,
      at,
      `你想${EVENT_ACTIVITIES[activity]}，现在在群里发起提议，问大家谁有空、定哪天`,
    );
    return;
  }

  if (phase === 'rsvp') {
    const answering = memberIds.filter((id) => id !== initiator).slice(0, RSVP_MAX);
    if (answering.length === 0) return;
    const names = answering.map(nameOf);
    const tier = maxTier(
      await d.getGlobalTier(),
      memberIds.map((id) => d.personaFor(id)),
    );
    const router = await d.getRouter();
    const raw = await router.complete(
      { role: 'chat', nsfwTier: tier },
      {
        messages: [
          { role: 'system', content: rsvpSystem(activity, names) },
          { role: 'user', content: '写吧。' },
        ],
        json: true,
        maxTokens: 400,
      },
      {},
      `gevt:${eventId}`,
    );
    const lines = parseRsvps(extractJson(raw.text), new Set(names));
    if (!lines) return;
    const idByName = new Map(answering.map((id) => [nameOf(id), id]));
    let t = at;
    for (let i = 0; i < lines.length; i++) {
      const senderId = idByName.get(lines[i].name);
      if (!senderId) continue;
      t += rsvpGapMs(eventId, i);
      await d.hooks.appendMessage({
        convId,
        senderId,
        type: 'text',
        content: lines[i].text,
        status: 'sent',
        createdAt: t,
      });
    }
    return;
  }

  if (phase === 'aftermath') {
    const router = await d.getRouter();
    const pInit = d.personaFor(initiator);
    const tier = maxTier(await d.getGlobalTier(), [pInit]);
    const raw = await router.complete(
      { role: 'chat', nsfwTier: tier },
      {
        messages: [
          { role: 'system', content: aftermathSystem(activity, nameOf(initiator)) },
          { role: 'user', content: '写吧。' },
        ],
        maxTokens: 150,
      },
      {},
      `gevt:${eventId}:after`,
    );
    const text = raw.text.trim().slice(0, 80);
    if (!text) return;
    // 聚会事后照片 (M-I3): the same seeded `pickImages` path an ordinary post
    // uses — persona `imageTags` respected, and an empty material pool simply
    // yields no refs, which degrades the post to text instead of throwing.
    // Writing `imageRefs: []` unconditionally was the one thing that made this
    // post read as generated: nobody comes back from 火锅 with zero pictures.
    await d.addMoment({
      id: `m_${eventId}`,
      authorId: initiator,
      text,
      imageRefs: pickImages(`gevt:${eventId}`, aftermathImageCount(eventId), pInit?.imageTags),
      isNsfw: tier === 'full', // M-J0: same truth-in-stamping fix as joint_plan

      createdAt: at,
    });
  }
}

/**
 * A group proposal fires: she suggests the trio in her own 1:1, then hands you
 * the two friends' 名片.
 *
 * The suggested roster rides in `meta.suggestGroup` — the chat UI turns that
 * into a tappable 群聊邀请 card that opens 发起群聊 with those people ticked
 * (`agent-invite.suggestGroupHref`). Creating the room is still the user's
 * move, and ignoring the whole thing is a legal, cost-free outcome.
 *
 * The name cards are the introduction itself: "把 Ada 和陈叔拉一个群" means
 * nothing if you cannot see who they are. They go through the same
 * `contactCardPayload` the model's own 名片 bubbles use — one card shape.
 */
export async function handleAgentInvite(
  d: HandlerDeps,
  payload: Record<string, unknown>,
): Promise<void> {
  const contactId = str(payload.contactId);
  const f1 = str(payload.friend1);
  const f2 = str(payload.friend2);
  if (!contactId || !f1 || !f2) return;
  // Everyone involved must still exist — deletion since planning drops it.
  const her = d.contactById(contactId);
  const friends = [d.contactById(f1), d.contactById(f2)];
  if (!her || !friends.every(Boolean)) return;
  const conv = d.visibleConvWithUser(contactId);
  if (!conv) return;
  const nameOf = (c: ContactVM) => c.remark ?? c.name;
  const at = optNum(payload.at) ?? d.now();
  const inviteId = `${contactId}:${at}`;

  await d.hooks.appendMessage({
    convId: conv.id,
    senderId: contactId,
    type: 'text',
    content: inviteLine(nameOf(friends[0]!), nameOf(friends[1]!)),
    status: 'sent',
    createdAt: at,
    meta: { suggestGroup: [contactId, f1, f2] },
  });

  // …and then their cards, a few seconds apart (seeded — replay-identical).
  let t = at;
  for (let i = 0; i < friends.length; i++) {
    const f = friends[i]!;
    t += inviteCardGapMs(inviteId, i);
    const card = contactCardPayload({
      contactId: f.id,
      name: nameOf(f),
      wxid: f.wxid,
      avatarColor: f.avatarColor,
      avatarText: f.avatarText,
    });
    await d.hooks.appendMessage({
      convId: conv.id,
      senderId: contactId,
      type: card.type,
      content: card.content,
      status: 'sent',
      createdAt: t,
      meta: card.meta,
    });
  }
}

/**
 * A planned forward fires. The hidden-source check runs AGAIN here — the
 * plan-time check protects the queue, this one protects the screen, and the
 * screen is the one that cannot be un-shown.
 */
export async function handleAgentForward(
  d: HandlerDeps,
  payload: Record<string, unknown>,
): Promise<void> {
  const speakerId = str(payload.speakerId);
  const sourceConvId = str(payload.sourceConvId);
  const groupId = str(payload.groupId);
  const quote = str(payload.quote);
  if (!speakerId || !sourceConvId || !groupId || !quote.trim()) return;

  const src = d.conversationById(sourceConvId);
  if (!canForwardFrom(src)) return; // hidden content NEVER leaves verbatim

  const group = d.conversationById(groupId);
  if (!group || group.type !== 'group' || group.isHidden) return;
  if (!(group.memberIds ?? []).includes(speakerId)) return; // left the room since

  await d.hooks.appendMessage({
    convId: groupId,
    senderId: speakerId,
    type: 'text',
    content: forwardLine(quote),
    status: 'sent',
    createdAt: optNum(payload.at) ?? d.now(),
  });
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

/**
 * A planned repost of the user's post fires (M-I15). Same staleness re-checks
 * as every other reaction: the reposter may have been deleted since planning,
 * and the source may be gone — `runMomentRepost` re-reads it from storage,
 * which is also what keeps the quote's content feed-derived (leak rule).
 */
export async function handleMomentRepost(
  d: HandlerDeps,
  payload: Record<string, unknown>,
): Promise<void> {
  const momentId = str(payload.momentId);
  const contactId = str(payload.contactId);
  if (!momentId || !contactId) return;
  const reposter = d.contactById(contactId);
  const persona = d.personaFor(contactId);
  if (!reposter || !persona) return;
  await d.runMomentRepost(momentId, reposter, persona, optNum(payload.at));
}

/* ------------------------------ calls ------------------------------ */

/**
 * She calls (M-H1).
 *
 * The row was queued minutes ago and a call is synchronous: if the user has
 * meanwhile started typing in that very conversation, ringing them is the
 * worst possible timing. Everything else is the same staleness re-check the
 * money handler does — a call to a deleted contact must not reach the screen.
 */
export async function handleAiCall(
  d: HandlerDeps,
  payload: Record<string, unknown>,
): Promise<void> {
  const convId = str(payload.convId);
  const contactId = str(payload.contactId);
  if (!convId || !contactId) return;
  if (!d.conversationExists(convId)) return;
  if (!d.contactById(contactId) || !d.personaFor(contactId)) return;
  d.ringUser(convId, contactId, str(payload.reason));
}

/* ------------------------------ money ------------------------------ */

/**
 * She sends money (M-H1).
 *
 * The row was queued days or hours ago, so everything it assumed has to be
 * re-checked here — the contact may have been deleted, the conversation may be
 * gone, and a payload that has lost its amount must not become a ¥0.00 packet.
 * Money is the one place in this app where acting on a stale plan is worse than
 * not acting at all.
 */
export async function handleAiMoney(
  d: HandlerDeps,
  payload: Record<string, unknown>,
): Promise<void> {
  const convId = str(payload.convId);
  const contactId = str(payload.contactId);
  if (!convId || !contactId) return;
  if (!d.conversationExists(convId)) return;
  if (!d.contactById(contactId) || !d.personaFor(contactId)) return;
  const amountFen = optNum(payload.amountFen);
  if (!amountFen || amountFen <= 0 || !Number.isInteger(amountFen)) return;

  await d.runGift({
    convId,
    contactId,
    kind: payload.kind === 'transfer' ? 'transfer' : 'rp',
    reason: str(payload.reason),
    amountFen,
    note: str(payload.note),
    line: str(payload.line),
    count: optNum(payload.count),
  });
  // Same stamp rule as a heartbeat: a gift that lands while you are looking at
  // the screen should ding.
  d.playMessageSound(d.now());
}
