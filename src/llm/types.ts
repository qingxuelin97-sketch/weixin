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

/** One chat "bubble" — the atomic unit an AI turn is played back as. */
export const BubbleSchema = z.object({
  type: z.enum(['text', 'voice', 'sticker', 'image', 'recall']),
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
  temperature?: number;
  maxTokens?: number;
  /** Force JSON object output where the endpoint supports response_format. */
  json?: boolean;
  /** AbortSignal so a user's new message can hard-interrupt an in-flight turn. */
  signal?: AbortSignal;
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
}

export type LlmErrorKind =
  | 'auth' // bad/missing key
  | 'rate_limit' // 429
  | 'timeout'
  | 'network'
  | 'content_filter' // provider refused on policy grounds
  | 'bad_response' // unparseable / schema mismatch after repair
  | 'server' // 5xx
  | 'unknown';

export class LlmError extends Error {
  constructor(
    public kind: LlmErrorKind,
    message: string,
    public status?: number,
    public providerId?: string,
  ) {
    super(message);
    this.name = 'LlmError';
  }
}
