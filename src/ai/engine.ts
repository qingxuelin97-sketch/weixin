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
import { assembleSystemPrompt, relationsForPrompt, type PersonaView } from './prompt';
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
export async function sendUserMessage(
  convId: string,
  text: string,
  peer: ContactVM,
  persona: PersonaVM,
  globalTier: NsfwTierVM,
  hooks: EngineHooks,
  meta?: Record<string, unknown>,
): Promise<void> {
  // Hard-interrupt any in-flight reply for this conversation.
  inFlight.get(convId)?.abort();
  const ctrl = new AbortController();
  inFlight.set(convId, ctrl);

  // 1) Persist the user's message immediately (meta carries e.g. a quote).
  try {
    await hooks.appendMessage({
      convId,
      senderId: 'self',
      type: 'text',
      content: text,
      ...(meta ? { meta } : {}),
      status: 'sent',
      createdAt: hooks.now(),
    });
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
    await hooks
      .appendMessage({
        convId,
        senderId: peer.id,
        type: 'system',
        content: `消息没能送达：${e instanceof Error ? e.message : String(e)}`,
        status: 'sent',
        createdAt: hooks.now(),
      })
      .catch(() => {});
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
  let system = assembleSystemPrompt({
    persona: toPersonaView(persona, peer.remark ?? peer.name),
    relations: relationsRec,
    nsfwTier: tier,
    memory: memory.pinned.length || memory.topK.length ? memory : undefined,
    scene: {
      kind: 'single',
      now: new Date(hooks.now()),
      moodLine: mood.line,
    },
  });
  if (extraDirective) system += `\n\n# 本次说话的由头\n${extraDirective}`;

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
    const bubbles: Bubble[] = [];
    for await (const b of router.generate(
      { role: 'chat', nsfwTier: tier, ...preferredRoute(persona.modelChat) },
      { messages, signal: ctrl.signal },
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

      await hooks.appendMessage({
        convId,
        senderId: peer.id,
        type: bubbleToMsgType(b),
        content: b.content,
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
      material = pickOpener(facts, own?.text, `${convId}:${lastMsg?.id ?? 0}`).directive;
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
