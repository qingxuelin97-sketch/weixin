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
import { recordLlmExchange } from '../lib/llm-recorder';

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
  /**
   * Called when the bad_model self-heal fetched a fresh catalog, so the caller
   * can persist it (service wires this to putProvider + invalidateRouter).
   */
  onCatalogRefresh?: (models: string[], picked: string) => void;
}

/** Per-provider cooldown so a broken catalog can't cause a refresh storm. */
const HEAL_LAST_ATTEMPT = new Map<string, number>();
const HEAL_COOLDOWN_MS = 10 * 60_000;

/** Test hook: clear the heal cooldown between cases. */
export function resetHealCooldown(): void {
  HEAL_LAST_ATTEMPT.clear();
}

/** Replacement heuristic: longest shared prefix with the stale id, else first. */
export function closestModel(stale: string, ids: string[]): string {
  let best = ids[0];
  let bestLen = -1;
  for (const id of ids) {
    let n = 0;
    while (n < stale.length && n < id.length && stale[n] === id[n]) n++;
    if (n > bestLen) {
      bestLen = n;
      best = id;
    }
  }
  return best;
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

  /**
   * Catalog self-heal: Zen rotates ids weekly (live-measured), and a stale id
   * fails EVERY call until the user manually re-pulls the list. On bad_model,
   * fetch the live catalog once (cooldown-guarded), swap to the closest current
   * id, retry, and hand the fresh list upward for persistence — the hardcoded
   * STALE_DEFAULT_MODELS migration table stops growing from here.
   */
  async complete(opts: GenerateOptions): Promise<CompletionResult> {
    try {
      return await this.completeOnce(opts);
    } catch (e) {
      if (!(e instanceof LlmError) || e.kind !== 'bad_model') throw e;
      const healed = await this.healModel(opts.model);
      if (!healed) throw e;
      return this.completeOnce({ ...opts, model: healed });
    }
  }

  private async healModel(stale: string): Promise<string | null> {
    const now = Date.now();
    if (now - (HEAL_LAST_ATTEMPT.get(this.id) ?? 0) < HEAL_COOLDOWN_MS) return null;
    HEAL_LAST_ATTEMPT.set(this.id, now);
    const ids = await this.listModels();
    // listModels falls back to the configured defaults on failure — those still
    // contain the stale id, which correctly reads as "nothing fresher known".
    if (ids.length === 0 || ids.includes(stale)) return null;
    const picked = closestModel(stale, ids);
    this.cfg.onCatalogRefresh?.(ids, picked);
    return picked;
  }

  protected async completeOnce(opts: GenerateOptions): Promise<CompletionResult> {
    const key = await this.cfg.getKey();
    if (!key) throw new LlmError('auth', `no API key for provider ${this.id}`, 401, this.id);
    const headers = { Authorization: `Bearer ${key}`, ...this.cfg.extraHeaders };
    const body = this.buildBody(opts);
    // Corpus tap (opt-in, rule #2 containment): record ONLY bodies — the
    // messages we send and the text that came back. Never `headers`.
    const tapReq = opts.messages.map((m) => ({ role: m.role, content: m.content }));
    const t0 = Date.now();
    const tap = (r: Partial<{ text: string; finishReason: string | null; error: string }>) =>
      recordLlmExchange({
        providerId: this.id,
        providerKind: this.kind,
        model: opts.model,
        latencyMs: Date.now() - t0,
        request: tapReq,
        ...r,
      });

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
        const out = this.stripReasoning(this.extract(res.data));
        tap({ text: out.text, finishReason: out.finishReason ?? null });
        return out;
      } catch (e) {
        lastErr = e;
        // Only try the fallback base on network/server errors, not auth/content.
        if (e instanceof LlmError && ['auth', 'content_filter', 'rate_limit'].includes(e.kind)) {
          tap({ error: `${e.kind}: ${e.message}` });
          throw e;
        }
      }
    }
    const err =
      lastErr instanceof LlmError ? lastErr : new LlmError('network', String(lastErr), undefined, this.id);
    tap({ error: `${err.kind}: ${err.message}` });
    throw err;
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
    const live = await this.listModelsLive();
    return live ?? this.cfg.defaultModels ?? [];
  }

  /**
   * The live catalog only: null means "could not fetch" — callers that need to
   * distinguish success-that-matches-current-config from failure (the config
   * page's 拉取模型列表) use this instead of inferring from list contents.
   */
  async listModelsLive(): Promise<string[] | null> {
    try {
      const key = await this.cfg.getKey();
      if (!key) return null;
      const res = await httpJson({
        url: `${this.cfg.baseUrl.replace(/\/$/, '')}/models`,
        method: 'GET',
        headers: { Authorization: `Bearer ${key}`, ...this.cfg.extraHeaders },
        timeoutMs: 15_000,
      });
      if (res.status >= 400) return null;
      const data = (res.data as { data?: Array<{ id?: string }> })?.data;
      const ids = (data ?? []).map((m) => m.id).filter((x): x is string => typeof x === 'string' && !!x);
      return ids.length ? ids : null;
    } catch {
      return null;
    }
  }

  protected httpStatusToError(status: number, msg: string): LlmError {
    // A retired model id must NOT read as an auth failure: Zen answers 401 with
    // "Model X is not supported" (live-verified), and kind:'auth' would both
    // mislead the user ("bad key") and abort the fallback ladder. bad_model
    // additionally triggers the catalog self-heal below.
    if (/model\b.*\b(not supported|not found|does not exist)|ModelError/i.test(msg))
      return new LlmError('bad_model', msg, status, this.id);
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
