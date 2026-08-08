/**
 * Group-chat engine. Where the single-chat engine has one actor, this has a
 * cast: the director picks who speaks, all chosen actors generate CONCURRENTLY,
 * and their lines then play back in the director's order with human delays.
 *
 * Concurrent generation is the whole trick — serial would stack 3 round-trips
 * (~20s+) before the first bubble; in parallel the first line lands as soon as
 * the fastest actor returns and the typing delays absorb the rest.
 */
import type { MessageVM, PersonaVM, ContactVM, NsfwTierVM, ConversationVM } from '../data/types';
import type { Bubble } from '../llm/types';
import { typingDelay } from '../llm/bubbles';
import { assembleSystemPrompt, relationsForPrompt } from './prompt';
import { selectFactsForInjection } from './memory';
import { effectiveTier, voiceMeta, preferredRoute, type EngineHooks } from './engine';
import { getRouter } from '../llm/service';
import { prefilter, callDirector, type GroupMember, type SpeakerPlan } from './director';
import { getAllEdges, pairKey, recordRelEvent } from './relationship';
import { playMessageSound } from '../lib/sound';
import { moodOf } from '../lib/mood';
import { repo } from '../db/repo';

const RECENT_WINDOW = 30;
const MAX_BUBBLES_PER_ACTOR = 3;

/** Per-conversation in-flight controller: a new user message cancels the round. */
const inFlight = new Map<string, AbortController>();

interface ActorOutput {
  plan: SpeakerPlan;
  member: GroupMember;
  bubbles: Bubble[];
}

/**
 * Handle a user message sent into a group: persist it, decide the cast, generate
 * concurrently, then play the lines in order.
 */
export async function sendGroupMessage(
  conv: ConversationVM,
  text: string,
  members: GroupMember[],
  globalTier: NsfwTierVM,
  hooks: EngineHooks,
  contactById: (id: string) => ContactVM | undefined,
): Promise<void> {
  const convId = conv.id;
  inFlight.get(convId)?.abort();
  const ctrl = new AbortController();
  inFlight.set(convId, ctrl);

  await hooks.appendMessage({
    convId,
    senderId: 'self',
    type: 'text',
    content: text,
    status: 'sent',
    createdAt: hooks.now(),
  });

  try {
    const recent = await repo.getMessages(convId, { limit: RECENT_WINDOW });
    const now = hooks.now();
    const nameOf = (id: string) =>
      id === 'self'
        ? (contactById('self')?.name ?? '我')
        : (contactById(id)?.remark ?? contactById(id)?.name ?? id);

    // 1) Cheap rules first — often skips the director entirely.
    const pre = prefilter(members, recent, now, `${convId}:${now}`);
    if (pre.mode === 'silence') return;

    let speakers = pre.speakers;
    if (pre.mode === 'director') {
      const router = await getRouter();
      // Long-term group dynamics: last round's topic + who's grown close feed
      // the casting decision — the group "remembers" instead of resetting.
      const prevTopic = await repo.getSetting<string>(`topic:${convId}`);
      const cliqueLine = await cliqueLineFor(members, nameOf, now);
      const decision = await callDirector(
        router,
        { candidates: pre.candidates, recent, nameOf, prevTopic, cliqueLine },
        convId,
        ctrl.signal,
      );
      if (ctrl.signal.aborted) return;
      if (decision.topicState) {
        void repo.putSetting(`topic:${convId}`, decision.topicState.slice(0, 60));
      }
      if (decision.silence || decision.speakers.length === 0) return;
      speakers = decision.speakers;
    }

    const byId = new Map(members.map((m) => [m.contactId, m]));
    const cast = speakers
      .map((plan) => ({ plan, member: byId.get(plan.agentId) }))
      .filter((x): x is { plan: SpeakerPlan; member: GroupMember } => Boolean(x.member?.persona));
    if (cast.length === 0) return;

    hooks.setTyping(convId, true);
    const tGenStart = hooks.now();

    // 2) All actors write at the same time.
    const roster = members.map((m) => m.name);
    const outputs = await Promise.all(
      cast.map(async ({ plan, member }): Promise<ActorOutput> => {
        const bubbles = await generateActorLines(
          conv,
          member,
          plan,
          recent,
          roster,
          globalTier,
          nameOf,
          now,
          ctrl.signal,
        );
        return { plan, member, bubbles };
      }),
    );
    if (ctrl.signal.aborted) return;

    // 3) Play back in the director's order, with human pacing.
    const ordered = outputs
      .filter((o) => o.bubbles.length > 0)
      .sort((a, b) => a.plan.priority - b.plan.priority);

    let firstPlayed = false;
    for (let i = 0; i < ordered.length; i++) {
      const { member, bubbles } = ordered[i];
      const persona = member.persona!;
      for (const b of bubbles.slice(0, MAX_BUBBLES_PER_ACTOR)) {
        // The slowest actor's real latency already elapsed inside Promise.all —
        // the very first played bubble only pays the remainder of its typing
        // delay (总等待 = max(真, 拟) 而非相加); the rest pace normally.
        const full = Math.min(typingDelay(b, persona.typingCpm), 6000);
        const delay = firstPlayed ? full : Math.max(250, full - (hooks.now() - tGenStart));
        firstPlayed = true;
        await sleep(delay, ctrl.signal);
        if (ctrl.signal.aborted) return;
        if (i === ordered.length - 1) hooks.setTyping(convId, false);
        await hooks.appendMessage({
          convId,
          senderId: member.contactId,
          type: b.type === 'sticker' ? 'sticker' : b.type === 'voice' ? 'voice' : 'text',
          content: b.content,
          ...(b.type === 'voice'
            ? { meta: await voiceMeta(b.content, persona, b.emotion, effectiveTier(globalTier, persona.nsfwPermit)) }
            : {}),
          status: 'sent',
          createdAt: hooks.now(),
        });
        playMessageSound(hooks.now());
      }
      // Relationship bookkeeping: speaking in the user's round is a light bond;
      // a staged disagreement cools the actor→target edge (both fire-and-forget).
      const { plan } = ordered[i];
      void recordRelEvent('self', member.contactId, 'group_chat', hooks.now(), persona.affinityInit).catch(() => {});
      if (plan.intent === 'disagree' && plan.target && plan.target !== 'user' && byId.has(plan.target)) {
        void recordRelEvent(member.contactId, plan.target, 'teased', hooks.now()).catch(() => {});
      }
    }
  } finally {
    hooks.setTyping(convId, false);
    if (inFlight.get(convId) === ctrl) inFlight.delete(convId);
  }
}

/** Generate one actor's lines. Returns [] on failure — a quiet member beats an error. */
async function generateActorLines(
  conv: ConversationVM,
  member: GroupMember,
  plan: SpeakerPlan,
  recent: MessageVM[],
  roster: string[],
  globalTier: NsfwTierVM,
  nameOf: (id: string) => string,
  now: number,
  signal: AbortSignal,
): Promise<Bubble[]> {
  const persona = member.persona as PersonaVM;
  const tier = effectiveTier(globalTier, persona.nsfwPermit);
  const facts = await repo.getMemory(member.contactId);
  const memory = selectFactsForInjection(facts, now);

  let system = assembleSystemPrompt({
    persona: {
      name: member.name,
      core: persona.core,
      speechStyle: persona.speechStyle,
      fewShots: persona.fewShots,
      catchphrases: persona.catchphrases,
      nsfwStyleSamples: persona.nsfwStyleSamples,
    },
    // In a group, knowing who the others ARE to you is what turns turn-taking
    // into banter — 互称、拆台、护短 all come from here.
    relations: relationsForPrompt(persona.relations, (id) => {
      const n = nameOf(id);
      return n === id ? undefined : n; // nameOf falls back to the raw id; never leak it
    }),
    nsfwTier: tier,
    memory: memory.pinned.length || memory.topK.length ? memory : undefined,
    scene: {
      kind: 'group',
      now: new Date(now),
      groupRoster: roster,
      moodLine: moodOf(member.contactId, now).line,
    },
  });

  // The director's staging note rides at the end, where recency weighs most.
  const direction = [
    plan.intent && plan.intent !== 'reply' ? `本轮你的角色：${intentLabel(plan.intent)}` : '',
    plan.hint ? `方向提示：${plan.hint}` : '',
    plan.target && plan.target !== 'user' ? `你主要在回应：${nameOf(plan.target)}` : '',
    '在群里说话要短，1-2 条即可，不要复述别人的话。',
  ]
    .filter(Boolean)
    .join('\n');
  system += `\n\n# 本轮导演提示\n${direction}`;

  const messages = [
    { role: 'system' as const, content: system },
    ...recent.map((m) => ({
      role: m.senderId === member.contactId ? ('assistant' as const) : ('user' as const),
      content:
        m.senderId === member.contactId
          ? (m.content ?? `[${m.type}]`)
          : `${nameOf(m.senderId)}: ${m.content ?? `[${m.type}]`}`,
    })),
  ];

  try {
    const router = await getRouter();
    const out: Bubble[] = [];
    for await (const b of router.generate(
      { role: 'chat', nsfwTier: tier, ...preferredRoute(persona.modelChat) },
      { messages, signal, temperature: persona.temperature },
      {},
      `${conv.id}:${member.contactId}`,
    )) {
      out.push(b);
    }
    return out;
  } catch {
    return []; // stay silent rather than surface an error into the group
  }
}

function intentLabel(intent: SpeakerPlan['intent']): string {
  switch (intent) {
    case 'follow':
      return '接话、顺着聊';
    case 'disagree':
      return '提出不同意见';
    case 'newtopic':
      return '开个新话题';
    case 'wrapup':
      return '收个尾';
    case 'sticker_only':
      return '只发一个表情';
    default:
      return '回应';
  }
}

/** "X和Y走得近" — social intel for the director, derived from live edges. */
async function cliqueLineFor(
  members: GroupMember[],
  nameOf: (id: string) => string,
  now: number,
): Promise<string | undefined> {
  try {
    const edges = await getAllEdges(now);
    const ids = members.map((m) => m.contactId);
    const pairs: string[] = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const e = edges[pairKey(ids[i], ids[j])];
        if (e && e.aff >= 65) pairs.push(`${nameOf(ids[i])}和${nameOf(ids[j])}走得近`);
      }
    }
    return pairs.length ? pairs.slice(0, 2).join('；') : undefined;
  } catch {
    return undefined;
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * One member says something in the group unprompted — nobody messaged first.
 *
 * This is the offline-backfill path: `simulate()` decides a group ticked over
 * while the app was closed, and each planned slot becomes one line here. It
 * deliberately skips the director (there is no turn to allocate — the speaker is
 * already chosen) and plays a single short line, because backfilled chatter
 * should read as ambient, not as a scene.
 *
 * @param at the message's intended timestamp; in the past when backfilling
 */
export async function sendGroupProactiveMessage(
  conv: ConversationVM,
  speaker: GroupMember,
  members: GroupMember[],
  globalTier: NsfwTierVM,
  hooks: EngineHooks,
  contactById: (id: string) => ContactVM | undefined,
  at?: number,
  /** Topic steer (≤20 chars) — e.g. what an off-screen DM was about. */
  hint?: string,
): Promise<void> {
  if (!speaker.persona) return;
  // Never talk over a live exchange in this group.
  if (inFlight.has(conv.id)) return;

  const ctrl = new AbortController();
  inFlight.set(conv.id, ctrl);
  try {
    const stamp = at ?? hooks.now();
    const recent = await repo.getMessages(conv.id, { limit: RECENT_WINDOW });
    const nameOf = (id: string) =>
      id === 'self'
        ? (contactById('self')?.name ?? '我')
        : (contactById(id)?.remark ?? contactById(id)?.name ?? id);

    const bubbles = await generateActorLines(
      conv,
      speaker,
      // No director ran, so hand it a neutral plan: start something, don't reply.
      { agentId: speaker.contactId, intent: 'newtopic', priority: 0, hint },
      recent,
      members.map((m) => m.name),
      globalTier,
      nameOf,
      stamp,
      ctrl.signal,
    );
    if (ctrl.signal.aborted || bubbles.length === 0) return;

    // One line only — ambient chatter, not a monologue.
    const b = bubbles[0];
    await hooks.appendMessage({
      convId: conv.id,
      senderId: speaker.contactId,
      type: b.type === 'sticker' ? 'sticker' : 'text',
      content: b.content,
      status: 'sent',
      createdAt: stamp,
    });
  } finally {
    if (inFlight.get(conv.id) === ctrl) inFlight.delete(conv.id);
  }
}
