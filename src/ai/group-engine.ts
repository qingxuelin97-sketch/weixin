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
import { getGroupCfg, prefilterKnobs, spiceLine, topicsLine, type GroupCfg } from './group-config';
import { worldLinesFor } from './worldbook';
import { affectFor, affectLine } from '../lib/affect';
import { lifelineAt, lifelineDirective, personaEpoch } from './lifeline';
import { refreshConvState, convStateDirective } from './conv-state';
import { collectTurnImages } from './vision-context';
import { logError } from '../lib/errlog';
import { selectFactsForInjection, withConvSummary } from './memory';
import {
  effectiveTier,
  voiceMeta,
  preferredRoute,
  cardResolver,
  toPersonaView,
  peersOf,
  usedThreadIds,
  type EngineHooks,
} from './engine';
import { materializeBubble } from './bubble-materialize';
import { gameDirective } from './game-react';
import { getDrift, applyDrift, driftToneLine } from './drift';
import { goalDirective } from './goals';
import { goalStateFor } from './goal-service';
import { occasionsFor, occasionDirective, firstSpokeAt } from './occasions';
import { arcAwareness } from './rel-arcs';
import { voiceDirective } from './voice-send';
import { isTtsAvailable } from '../llm/tts';
import { resolvePhotoBubble, photoDirective } from './photo-send';
import {
  detectThreads,
  threadsFromFacts,
  pickThread,
  shouldSurfaceThread,
  threadAwareness,
} from './threads';
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
import { ownLines, styleNote, makeScrubber } from './anti-ai';
import { playbackFeed, type BubbleFeed } from './bubble-feed';
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

    // Per-group knobs (M-I1): read ONCE for the whole round. They shape the
    // prefilter BEFORE any casting happens (a 冷清 room holds people on
    // cooldown longer and answers less readily) and the actor prompt after.
    const cfg = await getGroupCfg(convId);

    // 1) Cheap rules first — often skips the director entirely.
    const pre = prefilter(members, recent, now, `${convId}:${now}`, prefilterKnobs(cfg));
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
    // Per-group knobs (M-I1): the cfg row was already read above for the
    // director's prefilter, so this is the prompt side of the SAME read —
    // one settings round-trip per round, not two.
    const cfgLine = groupCfgLine(cfg);
    // Playback order is decided BEFORE anyone writes, so the room can start
    // speaking while the later actors are still generating (M-I5 渐进上屏).
    // The concurrency that makes a group round fast is unchanged — every actor
    // is still started in the same tick; only the drain moved downstream.
    const ordered = cast
      .slice(0, MAX_CONCURRENT_ACTORS)
      .sort((a, b) => a.plan.priority - b.plan.priority)
      .map(({ plan, member }) => ({
        plan,
        member,
        // Rejections are caught HERE, at creation: these promises sit unawaited
        // while earlier actors play, and an unhandled rejection in that window
        // takes the process down instead of making one member quiet.
        feed: startActorLines(
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
        ).catch((e) => {
          logError('group.actor', e);
          return null; // a quiet member beats an error in the room
        }),
      }));

    // For `contact` bubbles (M-I13): the full contact list, read once per
    // round, feeds the same name→card resolver the single chat uses.
    const allContacts = await repo.getContacts();

    let firstPlayed = false;
    for (let i = 0; i < ordered.length; i++) {
      const { member, plan } = ordered[i];
      const persona = member.persona!;
      const feed = await ordered[i].feed;
      if (ctrl.signal.aborted) return;
      if (!feed) continue;
      let spoke = 0;
      for (let bi = 0; bi < MAX_BUBBLES_PER_ACTOR; bi++) {
        // A break mid-actor keeps what landed and moves on: in a room, someone
        // stopping after one line is normal, and nothing here may surface an error.
        const b = await feed.next().catch(() => null);
        if (b === null) break;
        // The slowest actor's real latency already elapsed while they generated
        // in parallel — the very first played bubble only pays the remainder of
        // its typing delay (总等待 = max(真, 拟) 而非相加); the rest pace normally.
        const full = Math.min(typingDelay(b, persona.typingCpm), 6000);
        const delay = firstPlayed ? full : Math.max(250, full - (hooks.now() - tGenStart));
        firstPlayed = true;
        await sleep(delay, ctrl.signal);
        if (ctrl.signal.aborted) return;
        spoke++;
        // Typing goes down when the round is over: the last cast member, with
        // nothing left buffered and their stream exhausted.
        if (i === ordered.length - 1 && feed.finished) hooks.setTyping(convId, false);
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
        // A photo bubble resolves against the shared pool exactly as in the
        // single chat (M-J1) — the prompt now offers photos to group actors,
        // and an offer the playback cannot honour would render as a bug.
        const photo =
          b.type === 'image'
            ? resolvePhotoBubble(b, persona, convId, `${convId}:${member.contactId}:${at}:${bi}`)
            : null;
        await hooks.appendMessage({
          convId,
          senderId: member.contactId,
          type:
            b.type === 'sticker'
              ? 'sticker'
              : b.type === 'voice'
                ? 'voice'
                : photo
                  ? 'image'
                  : 'text',
          content: photo ? photo.ref : b.content,
          ...(photo ? { meta: { caption: photo.caption } } : {}),
          ...(b.type === 'voice'
            ? { meta: await voiceMeta(b.content, persona, effectiveTier(globalTier, persona.nsfwPermit), b.emotion) }
            : {}),
          status: 'sent',
          createdAt: hooks.now(),
        });
        playMessageSound(hooks.now());
      }
      // Relationship bookkeeping: speaking in the user's round is a light bond;
      // a staged disagreement cools the actor→target edge (both fire-and-forget).
      // Only for members who actually spoke — a silent actor bonds with nobody.
      if (spoke === 0) continue;
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

/**
 * Generate one actor's lines, drained into an array. Returns [] on failure —
 * a quiet member beats an error in the room.
 *
 * The ambient path (`sendGroupProactiveMessage`) plays exactly one line and has
 * nothing to overlap, so it takes the whole set. The user-facing round takes the
 * feed instead and plays as the lines arrive — see `startActorLines`.
 */
async function generateActorLines(
  ...args: Parameters<typeof startActorLines>
): Promise<Bubble[]> {
  const out: Bubble[] = [];
  try {
    const feed = await startActorLines(...args);
    for (;;) {
      const b = await feed.next();
      if (b === null) break;
      out.push(b);
    }
  } catch {
    // Whatever landed before the break stands; the rest is silence.
  }
  return out;
}

/**
 * Build this actor's prompt and hand back a live feed of their bubbles.
 *
 * The scrub (her own repeats, assistant-speak) runs inside the feed, on whole
 * bubbles in playback order — same decisions the batch `scrubBubbles` made,
 * including its never-empty rule, which is what `keepLast` restores.
 */
async function startActorLines(
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
): Promise<BubbleFeed> {
  const rawPersona = member.persona as PersonaVM;
  // 双轨消灭 (M-J1): the group actor speaks from the same drifted persona her
  // behavioural reads (heartbeat pacing, gifts, moments) have used since M-H1.
  const drift = await getDrift(member.contactId, now);
  const persona = applyDrift(rawPersona, drift);
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
  // The room's rolling summary from the memory loop (M-D2, wired here in
  // M-I18). The writer side (`putConvSummary`) never cared whether the
  // conversation was a group, but the only reader was engine.ts — so a group
  // summary was generated, backed up and cascade-deleted while never once
  // entering a prompt: come back a day later and she picked up the thread in
  // your DM but had no idea what the group had been talking about.
  // Same shape as the 1:1 side on purpose — inside the memory layer, ahead of
  // the retrieved facts, layer order untouched (constitution §2).
  const summaryRow = await repo.getConvSummary(conv.id);
  memory.topK = withConvSummary(memory.topK, summaryRow?.summary, 'group');
  // Worldbook (M-I4): lore scoped to this member or this room rides along.
  memory.world = await worldLinesFor({
    query: groupQuery,
    contactId: member.contactId,
    convId: conv.id,
    tier,
  });

  let system = assembleSystemPrompt({
    // Through toPersonaView (M-J1) — the same funnel the single chat and the
    // Moments generators use. The hand-rolled inline view this replaces had
    // silently dropped `stickerRate`, so the "群聊继承表情使用率" the M-I18
    // comment promised was a broken wire: 高冷 in your DM, 斗图狂魔 in the room.
    persona: toPersonaView(persona, member.name),
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
  // 群演员补脑 (M-J1): the six layers the single chat has carried since M-H/I
  // and the group actor never got — goal, drift temperature, loose threads,
  // occasions, social arcs, voice & photo urges. Same sources, same order
  // convention (appended after scene, mirroring engine.ts), so the same
  // character stops splitting into a DM self and a poorer group self.
  const goalLine = goalDirective(await goalStateFor(member.contactId, now), now);
  if (goalLine) system += `\n\n${goalLine}`;
  const toneLine = driftToneLine(drift);
  if (toneLine) system += `\n\n${toneLine}`;
  if (convStateLine) system += `\n\n${convStateLine}`;
  // A loose thread she still remembers — same once-ever ledger as the 1:1
  // (`threads:<contactId>`), surfaced as background, never marked used here.
  if (shouldSurfaceThread(recent, now)) {
    const openThread = pickThread(
      [...detectThreads(recent, conv.id), ...threadsFromFacts(facts, member.contactId)],
      recent,
      now,
      {
        used: await usedThreadIds(member.contactId),
        seed: `${conv.id}:${member.contactId}:${recent.at(-1)?.id ?? 0}`,
      },
    );
    if (openThread) system += `\n\n${threadAwareness(openThread, now)}`;
  }

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
  // Only advertised when a pool exists (M-J1) — same rule as the single chat;
  // the playback below resolves image bubbles against the same pool.
  const photoLine = photoDirective(persona);
  if (photoLine) system += `\n\n${photoLine}`;
  // What day it is — her memory of the members' dates rides her own facts.
  const occasionLine = occasionDirective(
    occasionsFor({ now, facts, firstMsgAt: await firstSpokeAt(conv.id) }),
  );
  if (occasionLine) system += `\n\n${occasionLine}`;
  // Where she stands with the people SHE knows — the falling-out that colours
  // how she picks someone up in the room today.
  const arcAware = await arcAwareness(member.contactId, await peersOf(persona), now);
  if (arcAware) system += `\n\n${arcAware}`;
  // Her own habits in THIS room (M-H1). Group turns are short, which makes
  // repetition far more visible than in a DM: three "哈哈哈" from the same
  // member inside one screen is the loudest tell a group chat has.
  const ownRecent = ownLines(recent, member.contactId);
  const habit = styleNote(ownRecent, persona.catchphrases);
  if (habit) system += `\n\n${habit}`;
  // Reaching for the mic in the room too (M-J1) — same urges as the 1:1.
  const voiceLine = voiceDirective(
    persona,
    {
      now,
      mood: moodOf(member.contactId, now).key,
      lastUserText: [...recent].reverse().find((m) => m.senderId === 'self' && m.type === 'text')
        ?.content,
      seed: `${conv.id}:${member.contactId}:${recent.at(-1)?.id ?? 0}`,
    },
    await isTtsAvailable().catch(() => false),
  );
  if (voiceLine) system += `\n\n${voiceLine}`;
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

  const router = await getRouter();
  // Same scrub as the single chat: her own repeats and any assistant-speak that
  // got past the rules, judged one whole bubble at a time as they arrive.
  //
  // No `personaTruncation` in the router context here, deliberately: a member
  // whose stream dies after one line has simply stopped talking, and a room
  // where three people each tack on "先不说了" is worse than a short line.
  const scrubber = makeScrubber<Bubble>(ownRecent);
  return playbackFeed(
    router.generate(
      { role: 'chat', nsfwTier: tier, ...preferredRoute(persona.modelChat) },
      { messages, signal, temperature: persona.temperature, ...(images.length ? { images } : {}) },
      {},
      `${conv.id}:${member.contactId}`,
    ),
    { signal, keepLast: true, accept: (b) => scrubber.accept(b) },
  );
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
    // All directed pairs in ONE parallel batch (M-J2). This used to be an
    // await inside a double loop — up to 30 SERIAL storage reads sitting on
    // the critical path between the user pressing send and the director even
    // being asked. Same reads, same order of results, one round-trip depth.
    const pairs: Array<[string, string]> = [];
    for (const from of ids) {
      for (const to of ids) if (from !== to) pairs.push([from, to]);
    }
    const stances = await Promise.all(pairs.map(([from, to]) => getStance(from, to, now)));
    pairs.forEach(([from, to], i) => {
      if (stanceTier(stances[i]) === 'hostile') cold.push([nameOf(from), nameOf(to)]);
    });
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
    const recent = await repo.getMessages(conv.id, { limit: RECENT_WINDOW });
    // 时间戳不得倒挂: a queued past stamp firing after newer live rows (e.g. a
    // budget-deferred backfill line, M-J1) clamps forward instead of breaking
    // rowid order — same rule as the single-chat proactive path.
    const lastAt = recent.at(-1)?.createdAt ?? 0;
    const raw = at ?? hooks.now();
    const stamp = raw <= lastAt ? Math.min(hooks.now(), lastAt + 1000) : raw;
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
  return groupCfgLine(await getGroupCfg(convId));
}

/** The same line from knobs already in hand — pure, no second settings read. */
function groupCfgLine(cfg: GroupCfg): string {
  return [spiceLine(cfg), topicsLine(cfg)].filter(Boolean).join('\n');
}
