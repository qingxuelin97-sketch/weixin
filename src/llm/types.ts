/**
 * LLM adapter layer contracts. The whole app talks to ONE interface; the three
 * first-class presets (DeepSeek / MiniMax / OpenCode Zen) and any user-added
 * OpenAI-compatible slot are just configurations behind it.
 *
 * Streaming shape is fixed NOW even though V1 emits a single batch: `generate`
 * returns an AsyncIterable<Bubble>. V1 yields the whole parsed set at once;
 * upgrading to NDJSON/SSE later changes only the adapter, never a caller.
 */
import { z } from 'zod';

/**
 * Every bubble type a model may emit. ONE list — the schema below and the
 * repair path in bubbles.ts both derive from it, so they cannot drift (they
 * did once: a repaired bubble could only keep types from a hand-copied array).
 *
 * M-I13 additions map to rich message types at materialization time
 * (src/ai/bubble-materialize.ts):
 *   location → 'location' card    contact → 'contact_card' (name resolved)
 *   file     → 'file' prop card   link    → 'link' share card
 *   dice/rps → 'game' (seeded result — the model never picks its own number)
 */
export const BUBBLE_TYPES = [
  'text',
  'voice',
  'sticker',
  'image',
  'recall',
  'location',
  'contact',
  'file',
  'link',
  'dice',
  'rps',
] as const;

/** One chat "bubble" — the atomic unit an AI turn is played back as. */
export const BubbleSchema = z.object({
  type: z.enum(BUBBLE_TYPES),
  content: z.string(),
  /** Emotion hint for TTS (voice bubbles). */
  emotion: z
    .enum(['happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm', 'neutral'])
    .optional(),
  /** Playback delay before this bubble appears, in ms. Client may override from typing model. */
  delay: z.number().int().nonnegative().optional(),
});
export type Bubble = z.infer<typeof BubbleSchema>;

/** OpenAI-style chat message. `prefix` supports DeepSeek's assistant-prefill (beta). */
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
  /** DeepSeek beta: continue this assistant message instead of starting fresh. */
  prefix?: boolean;
}

export interface GenerateOptions {
  model: string;
  messages: ChatMessage[];
  /**
   * Data-URL images to attach to the newest user message (M-H1).
   *
   * Carried as an option rather than baked into `ChatMessage.content` so the
   * text-only request body stays byte-identical — an unchanged prefix is a
   * cacheable prefix, and every provider that does prompt caching keys on it.
   * The adapter drops these when the chosen model cannot see.
   */
  images?: string[];
  temperature?: number;
  maxTokens?: number;
  /** Force JSON object output where the endpoint supports response_format. */
  json?: boolean;
  /** AbortSignal so a user's new message can hard-interrupt an in-flight turn. */
  signal?: AbortSignal;
  /** Per-call deadline override (ms). Transport default applies when omitted. */
  timeoutMs?: number;
}

/** Raw single-shot completion (used by director/memory extraction, not bubble playback). */
export interface CompletionResult {
  text: string;
  finishReason: string | null;
  /** Reasoning-model thinking chain, stripped from `text`. */
  reasoning?: string;
  raw?: unknown;
}

/**
 * A configured, callable model endpoint. One instance per provider slot.
 * Adapters own transport, auth, error normalization, and reasoning-chain stripping.
 */
export interface ChatProvider {
  readonly id: string;
  readonly kind: string;
  /** Single-shot text completion. Throws a normalized LlmError on failure. */
  complete(opts: GenerateOptions): Promise<CompletionResult>;
  /** Multi-bubble generation for chat playback. See streaming note above. */
  generate(opts: GenerateOptions): AsyncIterable<Bubble>;
  /** List available model ids (may hit a cache). */
  listModels(): Promise<string[]>;
  /**
   * Web-only true SSE (M-I5), optional. `canStream()` gates it per platform —
   * native buffers whole responses, so on a device the one-shot path is the
   * correct transport, not a degraded one. Contract: yields whole bubbles;
   * a failure BEFORE the first yield throws its own normalized kind (the router
   * then falls back to the one-shot ladder); a break AFTER output throws
   * `LlmError('truncated')` — the yielded bubbles stand (they are on screen and
   * cannot be un-shown), and the router turns that marker into the persona's
   * cut-off line instead of letting the turn end in mid-air.
   */
  canStream?(): boolean;
  generateStream?(opts: GenerateOptions): AsyncIterable<Bubble>;
}

export type LlmErrorKind =
  | 'auth' // bad/missing key
  | 'rate_limit' // 429
  | 'timeout'
  | 'network'
  | 'content_filter' // provider refused on policy grounds
  | 'bad_response' // unparseable / schema mismatch after repair
  | 'bad_model' // model id no longer in the provider's catalog (Zen rotates weekly)
  // A STREAM that broke after it had already put bubbles on screen (M-I5). Not
  // a failure to answer — a failure to finish answering, which is why it never
  // reaches the degradation ladder: what was said cannot be unsaid, so the
  // router appends the persona's cut-off line and ends the turn.
  | 'truncated'
  // The GLOBAL cost gate said no before anything left the process (M-J1):
  // the hourly/daily LLM-call budget is spent. Not a provider failure — the
  // degradation ladder must NOT run on it (every rung would be another call),
  // and the persona-refusal fallback must not swallow it either: the engine
  // turns it into a "tired" line, the scheduler defers the action.
  | 'budget'
  | 'server' // 5xx
  | 'unknown';

export class LlmError extends Error {
  constructor(
    public kind: LlmErrorKind,
    message: string,
    public status?: number,
    public providerId?: string,
    /**
     * What actually went wrong underneath. The degradation ladder tries several
     * providers and used to discard every one of their errors, so a total
     * failure surfaced as the generic "all routes refused" with no way to tell
     * a bad key from an outage from a rotated model id.
     */
    cause?: unknown,
  ) {
    super(message);
    this.name = 'LlmError';
    if (cause !== undefined) this.cause = cause;
  }
}
