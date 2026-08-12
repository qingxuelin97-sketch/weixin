/**
 * Single-chat engine. Turns a user message into a believable AI reply:
 * assemble the layered prompt → route through the LLM (with the degradation
 * ladder) → play the returned bubbles one at a time with human typing delays,
 * a "对方正在输入…" indicator, persistence, and a notification sound.
 *
 * A new user message hard-interrupts an in-flight reply (AbortController) and the
 * unplayed queue is dropped — being interruptible is core to feeling real.
 */
import type { MessageVM, PersonaVM, ContactVM, NsfwTierVM } from '../data/types';
import type { Bubble } from '../llm/types';
import { typingDelay } from '../llm/bubbles';
import { getEdge, effectiveAffinity, relationTier, tierDirective, recordRelEvent } from './relationship';
import { noteUserReplied } from './agent-state';
import { assembleSystemPrompt, promptStats, relationsForPrompt, type PersonaView } from './prompt';
import { selectFactsForInjection, touchFacts } from './memory';
import { getRouter } from '../llm/service';
import type { GenerateContext, NsfwTier } from '../llm/router';
import { playMessageSound } from '../lib/sound';
import { ensureVoiceAudio } from '../lib/voice';
import { DEFAULT_VOICE } from '../llm/tts';
import { repo } from '../db/repo';
import { enqueue } from './scheduler';
import { moodOf, moodParams } from '../lib/mood';
import { logError } from '../lib/errlog';
import { pickOpener } from './heartbeat';
import { seededRng } from '../lib/money';
import { renderTurns } from './render-msg';
import { collectTurnImages } from './vision-context';
import { resolvePhotoBubble, photoDirective } from './photo-send';
import { occasionsFor, occasionDirective, firstSpokeAt } from './occasions';
import { affectFor, affectLine, recordAffect, classifyUserMessage } from '../lib/affect';
import { lifelineAt, lifelineDirective, personaEpoch } from './lifeline';
import { refreshConvState, convStateDirective } from './conv-state';
import {
  detectThreads,
  threadsFromFacts,
  pickThread,
  threadDirective,
  shouldSurfaceThread,
  threadAwareness,
} from './threads';

export interface EngineHooks {
  /** Persist + push a new message to the UI. Returns the saved message (with id). */
  appendMessage: (msg: Omit<MessageVM, 'id'>) => Promise<MessageVM>;
  updateMessage: (msg: MessageVM) => Promise<void>;
  /** Toggle the header "对方正在输入…" indicator for a conversation. */
  setTyping: (convId: string, typing: boolean) => void;
  /** Current wall-clock ms (injected for testability / determinism). */
  now: () => number;
}

/** Per-conversation in-flight controller so a new send cancels the old reply. */
const inFlight = new Map<string, AbortController>();

/**
 * Release the slot, but only if it is still ours — a newer send may have taken
 * it over, and deleting unconditionally would let two replies play at once.
 *
 * The slot doubles as the "she is mid-conversation" guard for heartbeats, so a
 * leaked entry does not merely waste a Map key: it permanently silences that
 * AI's proactive messages for the rest of the process. It leaked whenever a
 * storage read threw between claiming the slot and entering the generator's
 * own try/finally — i.e. exactly on the failure paths, where losing her voice
 * is least recoverable and hardest to notice.
 */
function releaseInFlight(convId: string, ctrl: AbortController): void {
  if (inFlight.get(convId) === ctrl) inFlight.delete(convId);
}

const RECENT_WINDOW = 30; // messages of context sent to the model

/** Threads already followed up on. One question per thread, ever. */
async function usedThreadIds(contactId: string): Promise<Set<string>> {
  const rows = (await repo.getSetting<string[]>(`threads:${contactId}`)) ?? [];
  return new Set(Array.isArray(rows) ? rows : []);
}

async function markThreadUsed(contactId: string, threadId: string): Promise<void> {
  const used = await usedThreadIds(contactId);
  used.add(threadId);
  // Bounded: only the newest 200 matter, and an unbounded settings row would
  // grow forever in a store that is read on every proactive message.
  await repo.putSetting(`threads:${contactId}`, [...used].slice(-200));
}

/** Persona row → the prompt layer's view. Shared with the Moments engine. */
export function toPersonaView(p: PersonaVM, name: string): PersonaView {
  return {
    name,
    core: p.core,
    speechStyle: p.speechStyle,
    fewShots: p.fewShots,
    catchphrases: p.catchphrases,
    nsfwStyleSamples: p.nsfwStyleSamples,
  };
}

/** Effective NSFW tier = min(global, persona permit, conversation temp). */
export function effectiveTier(global: NsfwTierVM, personaPermit: boolean): NsfwTier {
  if (!personaPermit) return 'off';
  return global; // persona allows; global is the ceiling
}

/** A persona-styled fallback line so a total failure never shows a raw error. */
function personaRefusalBubbles(persona: PersonaVM): Bubble[] {
  const line = persona.catchphrases[0] ? `${persona.catchphrases[0]}…信号好像不太好，等下回你哈` : '信号不太好，等下回你哈';
  return [{ type: 'text', content: line }];
}

/**
 * Send a user message and generate the AI reply for a single chat.
 * @param convId conversation id
 * @param text user's text
 * @param peer the AI contact
 * @param persona the AI's persona card
 * @param globalTier global NSFW tier setting
 * @param hooks persistence/UI callbacks
 */
/**
 * Flag the newest outgoing message as undelivered.
 *
 * Reads the row back from storage rather than trusting a captured object: the
 * append happened earlier in this turn and the id is assigned by the store.
 */
async function markLastUserMessageFailed(convId: string, hooks: EngineHooks): Promise<void> {
  const recent = await repo.getMessages(convId, { limit: 5 });
  const mine = [...recent].reverse().find((m) => m.senderId === 'self');
  if (!mine || mine.status === 'failed') return;
  await hooks.updateMessage({ ...mine, status: 'failed' });
}

export interface SendOptions {
  /**
   * The caller has already written the user's row(s).
   *
   * Photos are the reason this exists: `sendImages` persists one message per
   * file through the media library, then needs ONE reply to the batch. Without
   * it the only way to get a reply was to append a second, fake text message.
   */
  alreadyPersisted?: boolean;
}

/**
 * Ask for a reply to the conversation as it now stands, appending nothing.
 *
 * The gap this closes: sending a photo used to call `appendMessage` and stop
 * there — no code path anywhere started a generation, so **she never answered
 * a picture**. Every richer plan for images (captions, real vision) was
 * downstream of a reply that was never requested.
 *
 * The transcript already carries the photo through the projection layer, so
 * the model sees it in context; nothing extra is invented on the user's behalf.
 */
export async function replyToLatest(
  convId: string,
  peer: ContactVM,
  persona: PersonaVM,
  globalTier: NsfwTierVM,
  hooks: EngineHooks,
): Promise<void> {
  await sendUserMessage(convId, '', peer, persona, globalTier, hooks, undefined, {
    alreadyPersisted: true,
  });
}

export async function sendUserMessage(
  convId: string,
  text: string,
  peer: ContactVM,
  persona: PersonaVM,
  globalTier: NsfwTierVM,
  hooks: EngineHooks,
  meta?: Record<string, unknown>,
  opts: SendOptions = {},
): Promise<void> {
  // Hard-interrupt any in-flight reply for this conversation.
  inFlight.get(convId)?.abort();
  const ctrl = new AbortController();
  inFlight.set(convId, ctrl);

  // 1) Persist the user's message immediately (meta carries e.g. a quote).
  //    Skipped when the caller already wrote the row — sending photos persists
  //    one message per file and then asks for a single reply to all of them.
  try {
    if (!opts.alreadyPersisted) {
      await hooks.appendMessage({
        convId,
        senderId: 'self',
        type: 'text',
        content: text,
        ...(meta ? { meta } : {}),
        status: 'sent',
        createdAt: hooks.now(),
      });
    }
  } catch (e) {
    // A failed write must not keep the slot: the user would see their message
    // vanish AND the AI would go quiet forever.
    releaseInFlight(convId, ctrl);
    logError('chat.persistUserMsg', e);
    throw e;
  }

  // Relationship + anti-spam bookkeeping: a reply warms the edge and resets
  // the proactive-consec counter (forgiveness is immediate). Fire-and-forget —
  // bookkeeping must never delay the visible reply.
  void recordRelEvent('self', peer.id, 'user_reply', hooks.now(), persona.affinityInit).catch(() => {});
  void noteUserReplied(peer.id).catch(() => {});
  // How she FEELS about it, not just how close you are. `user_reply` is the
  // small baseline good thing; an apology or an insult is classified separately.
  void recordAffect(peer.id, classifyUserMessage(text) ?? 'user_reply', hooks.now()).catch(() => {});

  // 2) Build context, 3) generate and play.
  await generateAndPlay(convId, peer, persona, globalTier, hooks, ctrl);
}

/**
 * Build the context, run the router, and play the resulting bubbles with human
 * pacing. Shared by user-triggered replies and proactive (heartbeat) messages —
 * the only difference is whether a user message preceded it.
 *
 * @param extraDirective appended to the system prompt (e.g. "you're reaching out first")
 * @param mode 'reply' answers a message the user just sent; 'proactive' opens cold
 */
async function generateAndPlay(
  convId: string,
  peer: ContactVM,
  persona: PersonaVM,
  globalTier: NsfwTierVM,
  hooks: EngineHooks,
  ctrl: AbortController,
  extraDirective?: string,
  mode: 'reply' | 'proactive' = 'reply',
): Promise<void> {
  try {
    await generateAndPlayInner(convId, peer, persona, globalTier, hooks, ctrl, extraDirective, mode);
  } catch (e) {
    // NOTHING may fail silently here. Before this guard, an exception in the
    // context-loading awaits below (storage reads, all OUTSIDE the inner try)
    // became an unhandled rejection: no reply, no error, not even a typing
    // indicator — the exact "什么都没发生" the user hit on device while the
    // browser build worked fine.
    logError('chat.generate', e);
    if (ctrl.signal.aborted) return;
    hooks.setTyping(convId, false);
    // Mark the USER's message failed rather than appending a system bubble.
    //
    // A system line stated the problem but could not act on it: there was no
    // retry, and it sat in the transcript permanently (and in the model's
    // context) narrating a network error. WeChat's answer — and now ours — is
    // the red mark on the message you sent, which is also the retry button.
    // `status: 'failed'` has been in the schema since M1 with zero producers;
    // this is the producer.
    await markLastUserMessageFailed(convId, hooks).catch(() => {});
  } finally {
    // Belt and braces: the inner generator releases the slot on its own paths,
    // but only this finally covers a throw from the context-loading awaits that
    // run before the generator's try is even entered.
    releaseInFlight(convId, ctrl);
  }
}

async function generateAndPlayInner(
  convId: string,
  peer: ContactVM,
  persona: PersonaVM,
  globalTier: NsfwTierVM,
  hooks: EngineHooks,
  ctrl: AbortController,
  extraDirective?: string,
  mode: 'reply' | 'proactive' = 'reply',
): Promise<void> {
  const recent = await repo.getMessages(convId, { limit: RECENT_WINDOW });
  const facts = await repo.getMemory(peer.id);
  const tier = effectiveTier(globalTier, persona.nsfwPermit);
  // Declared surface + tier: single chat is the ONE place graded facts may be
  // injected, and only up to this conversation's own tier (specs/nsfw.md).
  // The query that makes retrieval topical (M-E2): the last few turns. Without
  // it the twenty "most important" facts get injected whatever you are talking
  // about — mention your sister and she recalls nothing about her.
  const query = recent
    .slice(-4)
    .map((m) => m.content ?? '')
    .join(' ')
    .slice(0, 200);
  const memory = selectFactsForInjection(facts, hooks.now(), {
    surface: 'single',
    tier,
    query,
  });
  // Rolling summary from the memory loop — "上次聊到哪" survives the 30-message
  // context window. (Was a settings read that nothing ever wrote, M2–M-D1.)
  const summaryRow = await repo.getConvSummary(convId);
  if (summaryRow?.summary) memory.topK = [`上次你们聊到：${summaryRow.summary}`, ...memory.topK];

  // Relations keyed by contactId are translated to display names — the model
  // must never see internal ids, or it will echo them into dialogue.
  const contacts = await repo.getContacts();
  const nameOf = (id: string) => {
    const c = contacts.find((x) => x.id === id);
    return c ? (c.remark ?? c.name) : undefined;
  };
  // Live relationship register: the evolved edge (not the static card) decides
  // how familiar this conversation should FEEL. Appended inside the existing
  // relations layer — never a new layer (prefix-cache discipline).
  const edge = await getEdge('self', peer.id, hooks.now());
  const aff = effectiveAffinity(edge, persona.affinityInit);
  const relationsRec = relationsForPrompt(persona.relations, nameOf);
  relationsRec['你们现在的熟络程度'] = tierDirective(relationTier(aff));
  const mood = moodOf(peer.id, hooks.now());
  // The day's mood, shifted by what has actually happened between you (M-E3).
  // Falls back to the plain mood line when the pulse is small — a prompt that
  // describes a feeling she does not have is worse than saying nothing.
  const { affect } = await affectFor(peer.id, hooks.now());
  let system = assembleSystemPrompt({
    persona: toPersonaView(persona, peer.remark ?? peer.name),
    relations: relationsRec,
    nsfwTier: tier,
    memory: memory.pinned.length || memory.topK.length ? memory : undefined,
    scene: {
      kind: 'single',
      now: new Date(hooks.now()),
      moodLine: affectLine(mood.line, affect),
    },
  });
  // Appended AFTER scene — the six-layer order is fixed (constitution §2), and
  // new content only ever goes on the end so the prompt prefix stays cacheable.
  const arcs = lifelineAt(persona, hooks.now(), personaEpoch(persona.contactId));
  const arcLine = lifelineDirective(arcs);
  if (arcLine) system += `\n\n${arcLine}`;
  // What this conversation is still in the middle of (M-E6). Channel 1: this
  // refresh runs on EVERY turn, so an unanswered question is actionable during
  // the same conversation rather than minutes after you have left it.
  const convState = await refreshConvState(convId, recent, hooks.now());
  const stateLine = convStateDirective(convState, hooks.now());
  if (stateLine) system += `\n\n${stateLine}`;
  // A loose thread she still remembers (M-G0). Threads shipped in M-E3 wired
  // to `sendProactiveMessage` and nowhere else, so "上次你说要去看牙" could only
  // arrive hours later as an unprompted message — while you were actually
  // talking to her the whole system was off. Gated by `shouldSurfaceThread` so
  // it opens at the moments a person reaches for a topic, not every turn, and
  // phrased as background rather than an instruction to interrogate.
  if (shouldSurfaceThread(recent, hooks.now())) {
    const openThread = pickThread(
      [...detectThreads(recent, convId), ...threadsFromFacts(facts, peer.id)],
      recent,
      hooks.now(),
      { used: await usedThreadIds(peer.id), seed: `reply:${convId}:${recent.at(-1)?.id ?? 0}` },
    );
    // Deliberately NOT marked used: she may or may not take the opening, and
    // burning the once-ever quota on a thread she never actually mentioned is
    // how a thread disappears without ever being asked about.
    if (openThread) system += `\n\n${threadAwareness(openThread, hooks.now())}`;
  }
  if (extraDirective) system += `\n\n# 本次说话的由头\n${extraDirective}`;
  // Only advertised when a pool actually exists — offering a capability she
  // cannot exercise just produces image bubbles that all degrade to text.
  const photoLine = photoDirective(persona);
  if (photoLine) system += `\n\n${photoLine}`;
  // What day it is (M-H1). Pure, and free: no call, no timer, no new kind —
  // it rides whatever turn is already happening. She has had a mood and a life
  // since M-E but no sense of the DATE, and knowing it is the single cheapest
  // "this is a person" signal there is.
  const occasionLine = occasionDirective(
    occasionsFor({
      now: hooks.now(),
      facts,
      firstMsgAt: await firstSpokeAt(convId),
    }),
  );
  if (occasionLine) system += `\n\n${occasionLine}`;

  // Measured AFTER every append (M-G0). Prompt growth is otherwise invisible:
  // it has no symptom except a bigger bill and a persona diluted by context.
  const size = promptStats(system);
  if (size.overBudget) logError('prompt.oversize', new Error(`单聊系统 prompt ${size.chars} 字`));

  const messages = [
    { role: 'system' as const, content: system },
    // Through the projection layer: red packets, transfers, photos and voice
    // notes are now things she can actually see. Single chat keeps the voice
    // transcript — "你刚才说啥" has to be answerable.
    ...renderTurns(recent, 'self', { includeVoiceText: true }),
  ];

  // Pacing before 正在输入 lights up. A direct reply gets only a short "saw it"
  // beat — the long think would read as the app hanging (real-device bug H4);
  // the human thinking time overlaps the LLM latency behind the indicator
  // instead of preceding it. Proactive openers keep the longer wind-up: nobody
  // is staring at the screen waiting for those. Seeded on the newest message so
  // replay is stable; abortable so a follow-up send interrupts cleanly.
  const roll = seededRng(`read:${convId}:${recent.at(-1)?.id ?? 0}`)();
  const readDelay = mode === 'reply' ? 300 + roll * 500 : 1500 + roll * 6500;
  await sleep(readDelay, ctrl.signal);
  if (ctrl.signal.aborted) return;

  hooks.setTyping(convId, true);
  const tGenStart = hooks.now();
  const ctx: GenerateContext = {
    personaRefusal: () => personaRefusalBubbles(persona),
    prefixPrefill: tier !== 'off' ? '嗯' : undefined,
  };

  try {
    const router = await getRouter();
    // What she can actually SEE this turn. Rides the same message list, the
    // same router and the same tier — a photo is conversation content, and
    // constitution rule #6 covers it exactly as it covers text.
    const images = await collectTurnImages(recent);
    const bubbles: Bubble[] = [];
    for await (const b of router.generate(
      { role: 'chat', nsfwTier: tier, ...preferredRoute(persona.modelChat) },
      { messages, signal: ctrl.signal, ...(images.length ? { images } : {}) },
      ctx,
      convId,
    )) {
      bubbles.push(b);
    }
    if (ctrl.signal.aborted) return;

    // Prefetch voice synthesis in parallel while earlier bubbles play — the
    // awaited voiceMeta at append time then hits the content-addressed cache
    // instead of serializing a TTS round-trip into every gap.
    for (const b of bubbles) {
      if (b.type === 'voice') void voiceMeta(b.content, persona, b.emotion, tier).catch(() => {});
    }

    for (let i = 0; i < bubbles.length; i++) {
      const b = bubbles[i];
      // Budgeted pacing: the LLM's real latency (2-8s on free reasoning models)
      // already elapsed behind the typing indicator. The first bubble only pays
      // the REMAINDER of its typing delay, so total wait ≈ max(real, simulated)
      // instead of their sum. Later bubbles pace normally — the model is "done
      // thinking" by then and the gaps are pure typing rhythm. Mood shifts the
      // typing speed itself (tired types slower) — the app acts the mood, not
      // just the prompt.
      const full = Math.min(typingDelay(b, persona.typingCpm * moodParams(mood.key).cpmMul), 6000);
      const delay = i === 0 ? Math.max(250, full - (hooks.now() - tGenStart)) : full;
      await sleep(delay, ctrl.signal);
      if (ctrl.signal.aborted) return;

      if (b.type === 'recall') {
        // Send-then-recall for a human touch: post it, then queue the flip.
        // Queued (not an inline sleep) so the recall is a scheduled_actions row —
        // it survives a refresh or process kill mid-drama, and there is no
        // second timer competing with the one time-evolution path (rule #5).
        const posted = await hooks.appendMessage({
          convId,
          senderId: peer.id,
          type: 'text',
          content: b.content,
          status: 'sent',
          createdAt: hooks.now(),
        });
        playMessageSound(hooks.now());
        await enqueue({
          kind: 'recall',
          fireAt: hooks.now() + 1500,
          payload: { msgId: posted.id, convId },
          now: hooks.now(),
          id: `recall_${convId}_${posted.id}`,
        });
        continue;
      }

      // Hide typing just before the last bubble lands.
      if (i === bubbles.length - 1) hooks.setTyping(convId, false);

      // A photo bubble names what she wants to show, not a file — resolve it
      // against the user's own pool. With no pool it becomes text: a broken
      // image reads as a bug, while saying it in words reads as her not having
      // a picture to hand.
      const photo =
        b.type === 'image'
          ? resolvePhotoBubble(b, persona, convId, `${convId}:${hooks.now()}:${i}`)
          : null;
      if (b.type === 'image' && !photo) {
        await hooks.appendMessage({
          convId,
          senderId: peer.id,
          type: 'text',
          content: b.content,
          status: 'sent',
          createdAt: hooks.now(),
        });
        playMessageSound(hooks.now());
        continue;
      }

      await hooks.appendMessage({
        convId,
        senderId: peer.id,
        type: bubbleToMsgType(b),
        content: photo ? photo.ref : b.content,
        // The description rides along as the caption so a later turn can refer
        // back to "那张饼干的照片" rather than to an opaque handle.
        ...(photo ? { meta: { caption: photo.caption } } : {}),
        ...(b.type === 'voice' ? { meta: await voiceMeta(b.content, persona, b.emotion, tier) } : {}),
        status: 'sent',
        createdAt: hooks.now(),
      });
      playMessageSound(hooks.now());
    }
    // The reply landed with these facts in context — count the reference
    // (pending→confirmed on first use). Fire-and-forget bookkeeping.
    if (bubbles.length > 0 && memory.ids.length > 0) {
      void touchFacts(peer.id, memory.ids, hooks.now()).catch(() => {});
    }
  } catch {
    // Router threw past its own ladder — emit the persona refusal so the thread never breaks.
    if (!ctrl.signal.aborted) {
      for (const b of personaRefusalBubbles(persona)) {
        await hooks.appendMessage({
          convId,
          senderId: peer.id,
          type: 'text',
          content: b.content,
          status: 'sent',
          createdAt: hooks.now(),
        });
      }
    }
  } finally {
    hooks.setTyping(convId, false);
    releaseInFlight(convId, ctrl);
  }
}

/**
 * Regenerate the AI's last turn (M-E6, the steering wheel).
 *
 * An AI going out of character is not an edge case, it is a certainty — and
 * until now the user had NO way to correct it in the moment. The options were
 * to live with it or to delete the conversation, and a bad line left standing
 * poisons every later turn, because it is in the context window from then on.
 *
 * `steer` is an optional nudge ("别这么客套" / "换个说法") appended for this
 * regeneration only: it steers the retry without becoming a permanent
 * instruction the persona has to carry forever.
 */
export async function regenerateLastTurn(
  convId: string,
  peer: ContactVM,
  persona: PersonaVM,
  globalTier: NsfwTierVM,
  hooks: EngineHooks & { deleteMessage: (convId: string, msgId: number) => Promise<void> },
  steer?: string,
): Promise<void> {
  inFlight.get(convId)?.abort();
  const ctrl = new AbortController();
  inFlight.set(convId, ctrl);

  try {
    // Remove the AI's trailing run first. Regenerating on top of the bad turn
    // would leave it in the context — the model would see its own off-character
    // line and, reasonably, continue in that voice.
    const recent = await repo.getMessages(convId, { limit: RECENT_WINDOW });
    for (let i = recent.length - 1; i >= 0; i--) {
      const m = recent[i];
      if (m.senderId === 'self') break;
      if (m.senderId !== peer.id) break;
      await hooks.deleteMessage(convId, m.id);
    }
  } catch (e) {
    releaseInFlight(convId, ctrl);
    logError('chat.regenerate.clear', e);
    throw e;
  }

  await generateAndPlay(
    convId,
    peer,
    persona,
    globalTier,
    hooks,
    ctrl,
    steer
      ? `你刚才那条回复不太对，用户希望你**${steer}**，重新说一次。不要提起这件事本身。`
      : '你刚才那条回复不太对，换个说法重新回一次。不要提起这件事本身。',
  );
}

/**
 * The AI reaches out first — the "她先找我" moment that carries most of this
 * app's emotional weight. Driven by the heartbeat action in the scheduler.
 *
 * Never interrupts an in-flight exchange: if the user is mid-conversation with
 * this persona, the heartbeat is dropped (they're already talking).
 *
 * @param at the intended message time; for offline backfill this is in the past
 */
export async function sendProactiveMessage(
  convId: string,
  peer: ContactVM,
  persona: PersonaVM,
  globalTier: NsfwTierVM,
  hooks: EngineHooks,
  at?: number,
  opts: { nudge?: boolean } = {},
): Promise<void> {
  if (inFlight.has(convId)) return; // don't talk over a live exchange
  const ctrl = new AbortController();
  inFlight.set(convId, ctrl);

  // Backfilled messages carry their planned past timestamp; live ones use now().
  const stamped: EngineHooks = at == null ? hooks : { ...hooks, now: () => at };

  let gap: string;
  let material = '';
  // Every storage read below runs while we hold the slot. A throw here used to
  // escape without releasing it — one transient IDB error and this AI never
  // reached out again.
  try {
    const lastMsg = (await repo.getMessages(convId, { limit: 1 }))[0];
    const silentMs = lastMsg ? (at ?? hooks.now()) - lastMsg.createdAt : 0;
    gap = describeGap(silentMs);

    // What to open WITH: a nudge about the unanswered message, a remembered fact
    // to follow up on, their own fresh moment to share — or a plain greeting.
    // "有事找你" reads human; "打招呼" reads like a bot on a timer.
    if (opts.nudge) {
      material =
        '你上一条消息对方一直没回。轻轻问一下（"在忙？"这类），一句就好——' +
        '不要连环追问，不要表现出不满，问完就等。';
    } else {
      const facts = await repo.getMemory(peer.id);
      const moments = await repo.getMoments({ limit: 10 });
      const own = moments.find(
        (m) =>
          m.authorId === peer.id &&
          m.text &&
          (at ?? hooks.now()) - m.createdAt < 24 * 3_600_000,
      );
      // Picking a loose thread back up outranks any generic opener: "上次你说
      // 要去看牙，去了吗" is the single most human thing a friend does, and
      // this app could not do it at all before M-E3.
      const recent = await repo.getMessages(convId, { limit: 40 });
      const used = await usedThreadIds(peer.id);
      const thread = pickThread(
        [...detectThreads(recent, convId), ...threadsFromFacts(facts, peer.id)],
        recent,
        at ?? hooks.now(),
        { used, seed: `${convId}:${lastMsg?.id ?? 0}` },
      );
      if (thread) {
        material = threadDirective(thread, at ?? hooks.now());
        // Marked BEFORE the generation: a thread asked about once is closed
        // forever, and a failed generation must not make her ask again.
        await markThreadUsed(peer.id, thread.id);
      } else {
        material = pickOpener(facts, own?.text, `${convId}:${lastMsg?.id ?? 0}`).directive;
      }
    }
  } catch (e) {
    releaseInFlight(convId, ctrl);
    logError('chat.proactivePrep', e);
    return;
  }

  await generateAndPlay(
    convId,
    peer,
    persona,
    globalTier,
    stamped,
    ctrl,
    `现在是你主动发消息给对方，不是在回复。${gap}` +
      (material ? `\n${material}\n` : '') +
      '找一个自然的由头开口，**不要**用"有什么可以帮你"这种客服口气，' +
      '就像真人突然想起朋友那样。1-2 条短消息即可。',
    'proactive',
  );
}

/** Human phrasing for how long it's been quiet, so the opener fits the gap. */
function describeGap(ms: number): string {
  if (ms <= 0) return '';
  const hours = ms / 3_600_000;
  if (hours < 3) return '你们刚聊过没多久。';
  if (hours < 24) return '你们今天聊过，已经隔了几个小时。';
  const days = Math.floor(hours / 24);
  if (days === 1) return '距离上次聊天已经过了一天。';
  if (days < 7) return `距离上次聊天已经过了 ${days} 天。`;
  return '你们已经很久没联系了。';
}

/** Parse a persona's `modelChat` ("providerId:model") into route preferences. */
export function preferredRoute(
  modelChat?: string,
): Pick<import('../llm/router').RouteRequest, 'preferProvider' | 'preferModel'> {
  if (!modelChat) return {};
  const i = modelChat.indexOf(':');
  if (i < 0) return { preferModel: modelChat };
  return { preferProvider: modelChat.slice(0, i), preferModel: modelChat.slice(i + 1) };
}

function bubbleToMsgType(b: Bubble): MessageVM['type'] {
  if (b.type === 'sticker') return 'sticker';
  if (b.type === 'voice') return 'voice';
  if (b.type === 'image') return 'image';
  return 'text';
}

/** Rough voice length from text so the voice bar shows a plausible duration. */
function estimateVoiceMs(text: string): number {
  return Math.min(Math.max(text.length * 220, 1000), 60000);
}

/**
 * Build a voice bubble's meta, synthesizing real audio when MiniMax TTS is
 * configured. Without it we still post the bubble (estimated length, no audio) —
 * a missing voice must never break the message flow.
 *
 * NSFW-full turns never reach here with explicit text: the caller gates it,
 * because MiniMax's mainland endpoint audits input.
 */
export async function voiceMeta(
  text: string,
  persona: PersonaVM,
  emotion?: string,
  tier: NsfwTier = 'off',
): Promise<Record<string, unknown>> {
  // HARD RULE: full-tier text is never sent to MiniMax (mainland input auditing).
  // The bubble still posts, just without audio. See specs/nsfw.md.
  if (tier === 'full') {
    return { durationMs: estimateVoiceMs(text), emotion, played: false, ttsSkipped: 'nsfw' };
  }
  const audio = await ensureVoiceAudio(text, persona.ttsVoice ?? DEFAULT_VOICE, emotion);
  return audio
    ? { durationMs: audio.durationMs, audioKey: audio.key, emotion, played: false }
    : { durationMs: estimateVoiceMs(text), emotion, played: false };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
