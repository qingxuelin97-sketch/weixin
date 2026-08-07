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
import { assembleSystemPrompt, type PersonaView } from './prompt';
import { selectFactsForInjection } from './memory';
import { getRouter } from '../llm/service';
import type { GenerateContext, NsfwTier } from '../llm/router';
import { playMessageSound } from '../lib/sound';
import { ensureVoiceAudio } from '../lib/voice';
import { DEFAULT_VOICE } from '../llm/tts';
import { repo } from '../db/repo';

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

function toPersonaView(p: PersonaVM, name: string): PersonaView {
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

  // 2) Build context: system prompt (persona + memory) + recent window.
  const recent = await repo.getMessages(convId, { limit: RECENT_WINDOW });
  const facts = await repo.getMemory(peer.id);
  const memory = selectFactsForInjection(facts, hooks.now());
  const summary = await repo.getSetting<string>(`summary:${convId}`);
  if (summary) memory.topK = [summary, ...memory.topK];
  const tier = effectiveTier(globalTier, persona.nsfwPermit);
  const system = assembleSystemPrompt({
    persona: toPersonaView(persona, peer.remark ?? peer.name),
    nsfwTier: tier,
    memory: memory.pinned.length || memory.topK.length ? memory : undefined,
    scene: { kind: 'single', now: new Date(hooks.now()) },
  });
  const messages = [
    { role: 'system' as const, content: system },
    ...recent.map((m) => ({
      role: m.senderId === 'self' ? ('user' as const) : ('assistant' as const),
      content: m.content ?? `[${m.type}]`,
    })),
  ];

  // 3) Show typing, run the router, play bubbles with delays.
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
        // Send-then-recall for a human touch: post it, then flip to recalled.
        const posted = await hooks.appendMessage({
          convId,
          senderId: peer.id,
          type: 'text',
          content: b.content,
          status: 'sent',
          createdAt: hooks.now(),
        });
        playMessageSound();
        await sleep(1500, ctrl.signal);
        if (ctrl.signal.aborted) return;
        await hooks.updateMessage({ ...posted, isRecalled: true });
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
      playMessageSound();
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
