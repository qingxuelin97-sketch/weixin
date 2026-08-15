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
import { assembleSystemPrompt, promptStats, relationsForPrompt } from './prompt';
import { getGroupCfg, spiceLine, topicsLine } from './group-config';
import { worldLinesFor } from './worldbook';
import { affectFor, affectLine } from '../lib/affect';
import { lifelineAt, lifelineDirective, personaEpoch } from './lifeline';
import { refreshConvState, convStateDirective } from './conv-state';
import { collectTurnImages } from './vision-context';
import { logError } from '../lib/errlog';
import { selectFactsForInjection } from './memory';
import { effectiveTier, voiceMeta, preferredRoute, cardResolver, type EngineHooks } from './engine';
import { materializeBubble } from './bubble-materialize';
import { gameDirective } from './game-react';
import { getRouter } from '../llm/service';
import { prefilter, callDirector, type GroupMember, type SpeakerPlan } from './director';
import {
  getAllEdges,
  pairKey,
  recordRelEvent,
  recordTease,
  describePeerEdges,
  getStance,
  stanceTier,
} from './relationship';
import {
  readTopic,
  advanceTopic,
  pacingDirective,
  socialDirective,
  topicKey,
} from './group-topic';
import { ownLines, styleNote, scrubBubbles } from './anti-ai';
import { maxTier } from '../lib/nsfw-tier';
import { playMessageSound } from '../lib/sound';
import { moodOf } from '../lib/mood';
import { repo } from '../db/repo';
import { renderMessageBody } from './render-msg';

const RECENT_WINDOW = 30;
const MAX_BUBBLES_PER_ACTOR = 3;

/**
 * Scale gate (M-H2): how many actors may generate at once.
 *
 * All chosen actors write CONCURRENTLY, which is the trick that keeps a group
 * reply under a few seconds. It is also unbounded by construction: the cap
 * exists today only because the director's schema happens to stop at three.
 * A twenty-person group is exactly the situation where some future change
 * ("let the whole room react") turns one turn into fifteen parallel LLM calls
 * and a guaranteed timeout. This is the ceiling that does not depend on
 * another module's schema.
 */
const MAX_CONCURRENT_ACTORS = 3;

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
/**
 * Ask the room to react to what is already there, appending nothing.
 *
 * Group counterpart of `engine.replyToLatest`. Photos are the caller: sending
 * pictures persists one message per file and then wants ONE round of reactions
 * to the batch — before M-H0 it wanted nothing, because sending a photo never
 * started a generation at all.
 */
export async function replyToLatestInGroup(
  conv: ConversationVM,
  members: GroupMember[],
  globalTier: NsfwTierVM,
  hooks: EngineHooks,
  contactById: (id: string) => ContactVM | undefined,
): Promise<void> {
  await sendGroupMessage(conv, '', members, globalTier, hooks, contactById, undefined, {
    alreadyPersisted: true,
  });
}

export async function sendGroupMessage(
  conv: ConversationVM,
  text: string,
  members: GroupMember[],
  globalTier: NsfwTierVM,
  hooks: EngineHooks,
  contactById: (id: string) => ContactVM | undefined,
  /** Quoted-reply payload, same shape the single chat uses. */
  meta?: Record<string, unknown>,
  opts: { alreadyPersisted?: boolean } = {},
): Promise<void> {
  const convId = conv.id;
  inFlight.get(convId)?.abort();
  const ctrl = new AbortController();
  inFlight.set(convId, ctrl);

  if (!opts.alreadyPersisted) {
    await hooks.appendMessage({
      convId,
      senderId: 'self',
      type: 'text',
      content: text,
      status: 'sent',
      createdAt: hooks.now(),
      ...(meta ? { meta } : {}),
    });
  }

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
      const topic = readTopic(await repo.getSetting(topicKey(convId)), now);
      const cliqueLine = await cliqueLineFor(pre.candidates, nameOf, now);
      const decision = await callDirector(
        router,
        {
          candidates: pre.candidates,
          recent,
          nameOf,
          prevTopic: topic?.text,
          // How long this subject has run, what was just finished, how long the
          // room has been quiet. Without it the director had no way to know a
          // topic was exhausted — so nothing ever moved on by itself.
          pacing: pacingDirective(topic, now, recent[recent.length - 1]?.createdAt),
          cliqueLine,
          moodLine: castMoodLine(pre.candidates, nameOf, now),
          // The transcript's real tier — never 'off' by assumption (rule #6).
          tier: maxTier(globalTier, members.map((m) => m.persona)),
        },
        convId,
        ctrl.signal,
      );
      if (ctrl.signal.aborted) return;
      if (decision.topicState) {
        void repo.putSetting(topicKey(convId), advanceTopic(topic, decision.topicState, now));
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
    // Folded ONCE for the round, then handed to every actor: N actors folding
    // the same window would be N redundant passes and N concurrent writers
    // racing over a single settings row.
    const convStateLine = convStateDirective(
      await refreshConvState(convId, recent, now),
      now,
    );
    // Per-group knobs (M-I1): read ONCE for the round, same reason as above.
    const cfgLine = await groupCfgDirective(convId);
    const outputs = await Promise.all(
      cast.slice(0, MAX_CONCURRENT_ACTORS).map(async ({ plan, member }): Promise<ActorOutput> => {
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
          members.map((m) => ({ contactId: m.contactId, name: m.name })),
          convStateLine,
          '',
          cfgLine,
        );
        return { plan, member, bubbles };
      }),
    );
    if (ctrl.signal.aborted) return;

    // 3) Play back in the director's order, with human pacing.
    const ordered = outputs
      .filter((o) => o.bubbles.length > 0)
      .sort((a, b) => a.plan.priority - b.plan.priority);

    // For `contact` bubbles (M-I13): the full contact list, read once per
    // round, feeds the same name→card resolver the single chat uses.
    const allContacts = await repo.getContacts();

    let firstPlayed = false;
    for (let i = 0; i < ordered.length; i++) {
      const { member, bubbles } = ordered[i];
      const persona = member.persona!;
      const played = bubbles.slice(0, MAX_BUBBLES_PER_ACTOR);
      for (let bi = 0; bi < played.length; bi++) {
        const b = played[bi];
        // The slowest actor's real latency already elapsed inside Promise.all —
        // the very first played bubble only pays the remainder of its typing
        // delay (总等待 = max(真, 拟) 而非相加); the rest pace normally.
        const full = Math.min(typingDelay(b, persona.typingCpm), 6000);
        const delay = firstPlayed ? full : Math.max(250, full - (hooks.now() - tGenStart));
        firstPlayed = true;
        await sleep(delay, ctrl.signal);
        if (ctrl.signal.aborted) return;
        if (i === ordered.length - 1) hooks.setTyping(convId, false);
        // M-I13 rich types go through the SAME materializer as the single
        // chat. `at` is read once so a game's seed and its stored createdAt
        // are the same number (rule #4: the throw replays identically).
        const at = hooks.now();
        const rich = materializeBubble(b, {
          convId,
          at,
          index: bi,
          resolveContact: cardResolver(allContacts, member.contactId),
        });
        if (rich) {
          await hooks.appendMessage({
            convId,
            senderId: member.contactId,
            type: rich.type,
            content: rich.content,
            ...(rich.meta ? { meta: rich.meta } : {}),
            status: 'sent',
            createdAt: at,
          });
          playMessageSound(hooks.now());
          continue;
        }
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
        // One-way (M-E4): the needled cools toward the needler, not both ways.
        // Symmetric accounting read as "everyone drifts apart whenever anyone
        // is teased", which is the opposite of a group developing dynamics.
        void recordTease(member.contactId, plan.target, hooks.now()).catch(() => {});
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
  /** The other members, for the stance line (M-E4). */
  peers: Array<{ contactId: string; name: string }> = [],
  /**
   * What this conversation is still in the middle of, computed ONCE per round
   * by the caller. Per-actor would mean N redundant folds of the same window —
   * and N concurrent writers racing over one settings row (M-G0).
   */
  convStateLine = '',
  /**
   * Pacing note for the ambient path (see `sendGroupProactiveMessage`). The
   * user-message path gets its pacing through the director instead, which is
   * the right place for it — but backfilled chatter never asks a director, so
   * without this a group left alone overnight rediscovers the same subject
   * every fifteen minutes.
   */
  pacingLine = '',
  /** This room's knob-derived tone/topics line (M-I1), computed once per round. */
  cfgLine = '',
): Promise<Bubble[]> {
  const persona = member.persona as PersonaVM;
  const tier = effectiveTier(globalTier, persona.nsfwPermit);
  const facts = await repo.getMemory(member.contactId);
  // The GROUP's own memory, keyed by convId (M-E4): shared history every member
  // can refer to, distinct from what each of them privately knows.
  const groupFacts = await repo.getMemory(conv.id);
  // Groups never carry graded facts, whatever the tier — the other members'
  // personas are not party to what was said in a private chat.
  const { affect } = await affectFor(member.contactId, now);
  // Group actors see the room's photos too — same list, same route, same tier.
  const images = await collectTurnImages(recent);
  const groupQuery = recent
    .slice(-4)
    .map((m) => m.content ?? '')
    .join(' ')
    .slice(0, 200);
  const memory: ReturnType<typeof selectFactsForInjection> & { world?: string[] } =
    selectFactsForInjection([...facts, ...groupFacts], now, {
      surface: 'group',
      tier,
      // Topical retrieval for the actor too: what the group is talking about now.
      query: groupQuery,
    });
  // Worldbook (M-I4): lore scoped to this member or this room rides along.
  memory.world = await worldLinesFor({
    query: groupQuery,
    contactId: member.contactId,
    convId: conv.id,
    tier,
  });

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
    memory: memory.pinned.length || memory.topK.length || memory.world?.length ? memory : undefined,
    scene: {
      kind: 'group',
      now: new Date(now),
      groupRoster: roster,
      // The affect pulse rides the group's mood line too (M-G0). It used to be
      // the bare daily mood here while the single chat had the pulse since
      // M-E3 — so the same character could be visibly hurt in your DM and
      // completely unaffected in the group ten seconds later.
      moodLine: affectLine(moodOf(member.contactId, now).line, affect),
    },
  });

  // Her own life, and what the room is still in the middle of. Both appended
  // after the scene layer, never inserted into it: the six-layer order is
  // fixed (constitution §2) and the prefix has to stay cacheable.
  const arcLine = lifelineDirective(lifelineAt(persona, now, personaEpoch(member.contactId)));
  if (arcLine) system += `\n\n${arcLine}`;
  if (convStateLine) system += `\n\n${convStateLine}`;

  // The director's staging note rides at the end, where recency weighs most.
  const direction = [
    plan.intent && plan.intent !== 'reply' ? `本轮你的角色：${intentLabel(plan.intent)}` : '',
    plan.hint ? `方向提示：${plan.hint}` : '',
    plan.target && plan.target !== 'user' ? `你主要在回应：${nameOf(plan.target)}` : '',
    '在群里说话要短，1-2 条即可，不要复述别人的话。',
  ]
    .filter(Boolean)
    .join('\n');
  // How this actor currently carries themselves toward the other members
  // (M-E4). Appended after the scene layer, never inserted into it — the
  // six-layer order is fixed and the prefix has to stay cacheable.
  const stanceLine = await describePeerEdges(member.contactId, peers, now);
  if (stanceLine) system += `\n\n${stanceLine}`;
  if (pacingLine) system += `\n\n${pacingLine}`;
  // The room's own tone (火药味/常聊话题, M-I1) — appended after the scene
  // layer like every other room-level directive, never inserted into it.
  if (cfgLine) system += `\n\n${cfgLine}`;
  // Her own habits in THIS room (M-H1). Group turns are short, which makes
  // repetition far more visible than in a DM: three "哈哈哈" from the same
  // member inside one screen is the loudest tell a group chat has.
  const ownRecent = ownLines(recent, member.contactId);
  const habit = styleNote(ownRecent, persona.catchphrases);
  if (habit) system += `\n\n${habit}`;
  // A live game at the tail (M-I13): same etiquette line as the single chat —
  // in a group the thrower may be the user OR another member.
  const gameLine = gameDirective(recent, member.contactId);
  if (gameLine) system += `\n\n${gameLine}`;
  system += `\n\n# 本轮导演提示\n${direction}`;

  const size = promptStats(system);
  if (size.overBudget) logError('prompt.oversize', new Error(`群聊系统 prompt ${size.chars} 字`));

  const messages = [
    { role: 'system' as const, content: system },
    ...recent.map((m) => {
      // Own lines unprefixed (they are this actor's assistant turns); everyone
      // else's carry a display name. Bodies go through the shared projection so
      // a red packet in the group is a red packet, not the string "[rp]".
      const body = renderMessageBody(m, { maxChars: 200 });
      return {
        role: m.senderId === member.contactId ? ('assistant' as const) : ('user' as const),
        content: m.senderId === member.contactId ? body : `${nameOf(m.senderId)}: ${body}`,
      };
    }),
  ];

  try {
    const router = await getRouter();
    const out: Bubble[] = [];
    for await (const b of router.generate(
      { role: 'chat', nsfwTier: tier, ...preferredRoute(persona.modelChat) },
      { messages, signal, temperature: persona.temperature, ...(images.length ? { images } : {}) },
      {},
      `${conv.id}:${member.contactId}`,
    )) {
      out.push(b);
    }
    // Same scrub as the single chat: her own repeats and any assistant-speak
    // that got past the rules. Unlike the single chat, an emptied result is
    // fine here — one member staying quiet is a normal thing in a group, so
    // `scrubBubbles` is only asked to keep the turn non-empty, not to speak.
    return scrubBubbles(out, ownRecent);
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

/**
 * "X和Y走得近；A对B有点意见" — social intel for the director.
 *
 * Both halves matter. Until M-H1 this only reported closeness, so the director
 * could stage 附和 but every 拉踩 it cast was arbitrary — nothing told it who
 * actually has friction with whom, and friction is where a group chat gets its
 * texture. Friction comes from the DIRECTIONAL stance rows (M-E4), which are
 * exactly what a tease writes to.
 *
 * Scoped to the candidates rather than the whole room: it is read once per
 * director call, and a twenty-person group would otherwise be 190 pairs.
 */
async function cliqueLineFor(
  members: GroupMember[],
  nameOf: (id: string) => string,
  now: number,
): Promise<string | undefined> {
  try {
    const edges = await getAllEdges(now);
    const ids = members.map((m) => m.contactId).slice(0, 6);
    const warm: Array<[string, string]> = [];
    const cold: Array<[string, string]> = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const e = edges[pairKey(ids[i], ids[j])];
        if (e && e.aff >= 65) warm.push([nameOf(ids[i]), nameOf(ids[j])]);
      }
    }
    for (const from of ids) {
      for (const to of ids) {
        if (from === to) continue;
        if (stanceTier(await getStance(from, to, now)) === 'hostile') {
          cold.push([nameOf(from), nameOf(to)]);
        }
      }
    }
    return socialDirective(warm, cold) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Who is in what mood today, for the casting decision only.
 *
 * The actors already get their own mood in their own prompt; the director
 * getting it is what lets it cast AROUND a mood — the one who is down today is
 * not the one who should be opening a new topic.
 */
function castMoodLine(
  members: GroupMember[],
  nameOf: (id: string) => string,
  now: number,
): string | undefined {
  const parts = members.slice(0, 6).flatMap((m) => {
    const key = moodOf(m.contactId, now).key;
    // 'calm' is most days for most people; saying so for six members is six
    // lines of noise in a prompt where the tail is a budget.
    const word = MOOD_WORD[key];
    return word ? [`${nameOf(m.contactId)}${word}`] : [];
  });
  return parts.length ? parts.slice(0, 3).join('，') : undefined;
}

const MOOD_WORD: Record<string, string> = {
  happy: '今天心情不错',
  annoyed: '今天有点烦',
  tired: '今天挺累',
  excited: '今天有点兴奋',
  down: '今天情绪有点低',
};

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
      members.map((m) => ({ contactId: m.contactId, name: m.name })),
      '',
      pacingDirective(readTopic(await repo.getSetting(topicKey(conv.id)), stamp), stamp, recent[recent.length - 1]?.createdAt),
      await groupCfgDirective(conv.id),
    );
    if (ctrl.signal.aborted || bubbles.length === 0) return;

    // One line only — ambient chatter, not a monologue. Rich types (a shared
    // link, a thrown die) are legal ambient chatter too and go through the
    // same materializer; seeded on the planned `stamp`, so backfill replays.
    const b = bubbles[0];
    const rich = materializeBubble(b, {
      convId: conv.id,
      at: stamp,
      index: 0,
      resolveContact: cardResolver(await repo.getContacts(), speaker.contactId),
    });
    await hooks.appendMessage({
      convId: conv.id,
      senderId: speaker.contactId,
      type: rich ? rich.type : b.type === 'sticker' ? 'sticker' : 'text',
      content: rich ? rich.content : b.content,
      ...(rich?.meta ? { meta: rich.meta } : {}),
      status: 'sent',
      createdAt: stamp,
    });
  } finally {
    if (inFlight.get(conv.id) === ctrl) inFlight.delete(conv.id);
  }
}

/**
 * The room's knob line (M-I1): spice tone + preferred topics, joined for the
 * actor prompt. Reads the settings row; absent knobs produce '' and the
 * prompt is byte-identical to the pre-knob era.
 */
async function groupCfgDirective(convId: string): Promise<string> {
  const cfg = await getGroupCfg(convId);
  return [spiceLine(cfg), topicsLine(cfg)].filter(Boolean).join('\n');
}
