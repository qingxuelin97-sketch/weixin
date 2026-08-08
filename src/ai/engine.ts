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
import { assembleSystemPrompt, relationsForPrompt, type PersonaView } from './prompt';
import { selectFactsForInjection } from './memory';
import { getRouter } from '../llm/service';
import type { GenerateContext, NsfwTier } from '../llm/router';
import { playMessageSound } from '../lib/sound';
import { ensureVoiceAudio } from '../lib/voice';
import { DEFAULT_VOICE } from '../llm/tts';
import { repo } from '../db/repo';
import { enqueue } from './scheduler';
import { moodOf } from '../lib/mood';
import { pickOpener } from './heartbeat';
import { seededRng } from '../lib/money';

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
): Promise<void> {
  // Hard-interrupt any in-flight reply for this conversation.
  inFlight.get(convId)?.abort();
  const ctrl = new AbortController();
  inFlight.set(convId, ctrl);

  // 1) Persist the user's message immediately.
  await hooks.appendMessage({
    convId,
    senderId: 'self',
    type: 'text',
    content: text,
    status: 'sent',
    createdAt: hooks.now(),
  });

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
  const recent = await repo.getMessages(convId, { limit: RECENT_WINDOW });
  const facts = await repo.getMemory(peer.id);
  const memory = selectFactsForInjection(facts, hooks.now());
  const summary = await repo.getSetting<string>(`summary:${convId}`);
  if (summary) memory.topK = [summary, ...memory.topK];
  const tier = effectiveTier(globalTier, persona.nsfwPermit);

  // Relations keyed by contactId are translated to display names — the model
  // must never see internal ids, or it will echo them into dialogue.
  const contacts = await repo.getContacts();
  const nameOf = (id: string) => {
    const c = contacts.find((x) => x.id === id);
    return c ? (c.remark ?? c.name) : undefined;
  };
  let system = assembleSystemPrompt({
    persona: toPersonaView(persona, peer.remark ?? peer.name),
    relations: relationsForPrompt(persona.relations, nameOf),
    nsfwTier: tier,
    memory: memory.pinned.length || memory.topK.length ? memory : undefined,
    scene: {
      kind: 'single',
      now: new Date(hooks.now()),
      moodLine: moodOf(peer.id, hooks.now()).line,
    },
  });
  if (extraDirective) system += `\n\n# 本次说话的由头\n${extraDirective}`;

  const messages = [
    { role: 'system' as const, content: system },
    ...recent.map((m) => ({
      role: m.senderId === 'self' ? ('user' as const) : ('assistant' as const),
      content: m.content ?? `[${m.type}]`,
    })),
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
  const ctx: GenerateContext = {
    personaRefusal: () => personaRefusalBubbles(persona),
    prefixPrefill: tier !== 'off' ? '嗯' : undefined,
  };

  try {
    const router = await getRouter();
    const bubbles: Bubble[] = [];
    for await (const b of router.generate({ role: 'chat', nsfwTier: tier }, { messages, signal: ctrl.signal }, ctx, convId)) {
      bubbles.push(b);
    }
    if (ctrl.signal.aborted) return;

    for (let i = 0; i < bubbles.length; i++) {
      const b = bubbles[i];
      const delay = Math.min(typingDelay(b, persona.typingCpm), 6000);
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
    if (inFlight.get(convId) === ctrl) inFlight.delete(convId);
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

  const lastMsg = (await repo.getMessages(convId, { limit: 1 }))[0];
  const silentMs = lastMsg ? (at ?? hooks.now()) - lastMsg.createdAt : 0;
  const gap = describeGap(silentMs);

  // What to open WITH: a nudge about the unanswered message, a remembered fact
  // to follow up on, their own fresh moment to share — or a plain greeting.
  // "有事找你" reads human; "打招呼" reads like a bot on a timer.
  let material = '';
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
