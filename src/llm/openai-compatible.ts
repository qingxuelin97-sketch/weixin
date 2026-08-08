/**
 * Base adapter for any OpenAI-compatible /chat/completions endpoint. DeepSeek,
 * MiniMax, and OpenCode Zen all speak this; per-provider quirks are handled by
 * thin subclasses in presets.ts. V1 is non-streaming: one request → parse bubbles.
 */
import {
  type ChatProvider,
  type GenerateOptions,
  type CompletionResult,
  type Bubble,
  LlmError,
} from './types';
import { httpJson } from './http';
import { parseBubbles } from './bubbles';

export interface ProviderConfig {
  id: string;
  kind: string;
  baseUrl: string;
  fallbackBaseUrl?: string;
  /** Resolver so real keys stay in secure storage and never in the object graph longer than a call. */
  getKey: () => Promise<string | null>;
  /** Extra headers (e.g. MiniMax group id). */
  extraHeaders?: Record<string, string>;
  defaultModels?: string[];
}

interface OpenAiChoice {
  message?: { content?: string | null; reasoning_content?: string | null };
  finish_reason?: string | null;
}
interface OpenAiResponse {
  choices?: OpenAiChoice[];
  error?: { message?: string; code?: string | number };
  base_resp?: { status_code?: number; status_msg?: string }; // MiniMax envelope
}

export class OpenAiCompatibleProvider implements ChatProvider {
  constructor(protected cfg: ProviderConfig) {}

  get id() {
    return this.cfg.id;
  }
  get kind() {
    return this.cfg.kind;
  }

  protected endpoint(base: string, opts?: GenerateOptions): string {
    void opts; // subclasses may pick a different path per-request (e.g. DeepSeek /beta)
    return `${base.replace(/\/$/, '')}/chat/completions`;
  }

  /**
   * Hook for subclasses to shape the request body (e.g. MiniMax field names).
   * The `prefix` flag is DeepSeek-only and gateways transparently forward it to
   * upstreams that then 400 (live-verified on Zen) — the base class strips it
   * and sends a plain trailing assistant message, which every provider accepts.
   */
  protected buildBody(opts: GenerateOptions): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: opts.temperature ?? 0.8,
    };
    if (opts.maxTokens) body.max_tokens = opts.maxTokens;
    if (opts.json) body.response_format = { type: 'json_object' };
    return body;
  }

  /** Hook for subclasses to read the content out of a provider-specific envelope. */
  protected extract(data: unknown): CompletionResult {
    const r = data as OpenAiResponse;
    if (r?.base_resp && r.base_resp.status_code && r.base_resp.status_code !== 0) {
      throw this.mapStatus(r.base_resp.status_code, r.base_resp.status_msg ?? 'minimax error');
    }
    const choice = r?.choices?.[0];
    const content = choice?.message?.content ?? '';
    const reasoning = choice?.message?.reasoning_content ?? undefined;
    return {
      text: (content ?? '').trim(),
      reasoning: reasoning ?? undefined,
      finishReason: choice?.finish_reason ?? null,
      raw: data,
    };
  }

  /** Map provider-specific error codes to normalized LlmError kinds. */
  protected mapStatus(code: number | string, msg: string): LlmError {
    const n = typeof code === 'number' ? code : Number(code);
    // MiniMax content-audit codes 1026 (input) / 1027 (output).
    if (n === 1026 || n === 1027) return new LlmError('content_filter', msg, n, this.id);
    if (n === 401 || n === 403) return new LlmError('auth', msg, n, this.id);
    if (n === 429 || n === 1002) return new LlmError('rate_limit', msg, n, this.id);
    if (typeof n === 'number' && n >= 500) return new LlmError('server', msg, n, this.id);
    return new LlmError('unknown', msg, n, this.id);
  }

  async complete(opts: GenerateOptions): Promise<CompletionResult> {
    const key = await this.cfg.getKey();
    if (!key) throw new LlmError('auth', `no API key for provider ${this.id}`, 401, this.id);
    const headers = { Authorization: `Bearer ${key}`, ...this.cfg.extraHeaders };
    const body = this.buildBody(opts);

    const bases = [this.cfg.baseUrl, this.cfg.fallbackBaseUrl].filter(Boolean) as string[];
    let lastErr: unknown;
    for (const base of bases) {
      try {
        const res = await httpJson({
          url: this.endpoint(base, opts),
          method: 'POST',
          headers,
          body,
          signal: opts.signal,
          timeoutMs: opts.timeoutMs,
        });
        if (res.status >= 400) {
          const errData = res.data as OpenAiResponse;
          const em = errData?.error?.message ?? `HTTP ${res.status}`;
          throw this.httpStatusToError(res.status, em);
        }
        const out = this.extract(res.data);
        return this.stripReasoning(out);
      } catch (e) {
        lastErr = e;
        // Only try the fallback base on network/server errors, not auth/content.
        if (e instanceof LlmError && ['auth', 'content_filter', 'rate_limit'].includes(e.kind)) throw e;
      }
    }
    throw lastErr instanceof LlmError ? lastErr : new LlmError('network', String(lastErr), undefined, this.id);
  }

  async *generate(opts: GenerateOptions): AsyncIterable<Bubble> {
    // V1: single request, parse all bubbles, yield them. Streaming upgrade lands
    // here without touching callers (the async-iterable contract is already set).
    const result = await this.complete({ ...opts, json: opts.json ?? false });
    const bubbles = parseBubbles(result.text);
    for (const b of bubbles) yield b;
  }

  /**
   * Live catalog via the OpenAI-compatible GET /models. Gateways rotate their
   * catalogs (Zen especially), so stale hardcoded ids are the #1 cause of
   * "protocol looks broken" 400s — always prefer what the server says.
   * Falls back to the configured defaults when the route is missing or errors.
   */
  async listModels(): Promise<string[]> {
    try {
      const key = await this.cfg.getKey();
      if (!key) return this.cfg.defaultModels ?? [];
      const res = await httpJson({
        url: `${this.cfg.baseUrl.replace(/\/$/, '')}/models`,
        method: 'GET',
        headers: { Authorization: `Bearer ${key}`, ...this.cfg.extraHeaders },
        timeoutMs: 15_000,
      });
      if (res.status >= 400) return this.cfg.defaultModels ?? [];
      const data = (res.data as { data?: Array<{ id?: string }> })?.data;
      const ids = (data ?? []).map((m) => m.id).filter((x): x is string => typeof x === 'string' && !!x);
      return ids.length ? ids : (this.cfg.defaultModels ?? []);
    } catch {
      return this.cfg.defaultModels ?? [];
    }
  }

  protected httpStatusToError(status: number, msg: string): LlmError {
    // A retired model id must NOT read as an auth failure: Zen answers 401 with
    // "Model X is not supported" (live-verified), and kind:'auth' would both
    // mislead the user ("bad key") and abort the fallback ladder.
    if (/model\b.*\b(not supported|not found|does not exist)|ModelError/i.test(msg))
      return new LlmError('unknown', msg, status, this.id);
    if (status === 401 || status === 403) return new LlmError('auth', msg, status, this.id);
    if (status === 429) return new LlmError('rate_limit', msg, status, this.id);
    if (status >= 500) return new LlmError('server', msg, status, this.id);
    if (status === 400 && /content|policy|safety|risk/i.test(msg))
      return new LlmError('content_filter', msg, status, this.id);
    return new LlmError('unknown', msg, status, this.id);
  }

  /** Reasoning models embed a <think>…</think> chain; keep it out of `text`. */
  protected stripReasoning(r: CompletionResult): CompletionResult {
    const m = r.text.match(/^<think>([\s\S]*?)<\/think>\s*([\s\S]*)$/);
    if (m) return { ...r, reasoning: r.reasoning ?? m[1], text: m[2].trim() };
    return r;
  }
}
