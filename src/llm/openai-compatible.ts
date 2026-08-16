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
import { attachImages, modelSupportsVision } from './vision';
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
    const plain = opts.messages.map((m) => ({ role: m.role, content: m.content }));
    // Images ride the SAME message list under the SAME route (constitution
    // rule #6 covers photographs too), and are dropped silently when the model
    // cannot see — a text-only model handed image parts returns a hard 400 on
    // every turn, which would read as "she stopped replying".
    const withImages =
      opts.images?.length && modelSupportsVision(opts.model)
        ? attachImages(plain, opts.images)
        : plain;
    const body: Record<string, unknown> = {
      model: opts.model,
      messages: withImages,
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
   * Web-only true SSE (M-I5): can this provider stream RIGHT NOW?
   *
   * Native says no: CapacitorHttp buffers whole responses and cannot be read
   * incrementally (and, per CLAUDE.md, cannot even be aborted from JS) — on a
   * device the one-shot path IS the correct transport. Browsers stream.
   */
  canStream(): boolean {
    const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
    if (cap?.isNativePlatform?.()) return false;
    return typeof fetch === 'function' && typeof ReadableStream === 'function';
  }

  /**
   * Progressive bubble generation over SSE.
   *
   * Yields per COMPLETE bubble (an NDJSON line), never per token: every
   * downstream consumer — the anti-AI scrub, typing pacing, voice prefetch —
   * reasons about whole bubbles, and half a sentence on screen is worse than
   * a short wait. Reasoning models' <think> spans are dropped in-stream.
   *
   * A failure BEFORE the first yield throws its own kind, and the router falls
   * back to the one-shot ladder. A break AFTER output is reported as
   * `LlmError('truncated')`: the bubbles already yielded stand (what is on
   * screen cannot be recalled) but the turn did NOT finish, and the caller has
   * to know the difference — swallowing it is exactly how a reply ends in
   * mid-air with no explanation, which is what M-I5 shipped and users saw.
   * Abnormal `finish_reason`s (length / content_filter) count as the same thing.
   */
  async *generateStream(opts: GenerateOptions): AsyncIterable<Bubble> {
    const key = await this.cfg.getKey();
    if (!key) throw new LlmError('auth', `no API key for provider ${this.id}`, 401, this.id);
    const body = { ...this.buildBody(opts), stream: true };
    const res = await fetch(this.endpoint(this.cfg.baseUrl, opts), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...this.cfg.extraHeaders,
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok || !res.body) {
      throw this.httpStatusToError(res.status, `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let sseBuf = '';
    let acc = '';
    let inThink = false;
    let emitted = 0;
    const t0 = Date.now();
    let fullText = '';
    /** Last `finish_reason` the stream declared; anything but 'stop' cut it short. */
    let finishReason: string | null = null;
    /** Set when the stream broke after output — thrown once the reader is closed. */
    let truncation: unknown = null;

    /** Consume completed lines in `acc`, yielding whole bubbles. */
    const drainLines = function* (self: OpenAiCompatibleProvider): Generator<Bubble> {
      let nl: number;
      while ((nl = acc.indexOf('\n')) >= 0) {
        const line = acc.slice(0, nl).trim();
        acc = acc.slice(nl + 1);
        if (!line) continue;
        for (const b of parseBubbles(line)) yield b;
      }
      void self;
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = sseBuf.indexOf('\n')) >= 0) {
          const frame = sseBuf.slice(0, idx).trim();
          sseBuf = sseBuf.slice(idx + 1);
          if (!frame.startsWith('data:')) continue;
          const payload = frame.slice(5).trim();
          if (payload === '[DONE]') continue;
          let delta = '';
          try {
            const j = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string | null }; finish_reason?: string | null }>;
            };
            delta = j.choices?.[0]?.delta?.content ?? '';
            // Read BEFORE the empty-delta skip: the frame that carries the
            // finish reason usually carries no content at all, so skipping
            // first is how "被截断" became indistinguishable from "说完了".
            finishReason = j.choices?.[0]?.finish_reason ?? finishReason;
          } catch {
            continue; // partial frame or keepalive — never fatal
          }
          if (!delta) continue;
          // Reasoning spans stream inline on some models; drop them whole.
          let rest = delta;
          while (rest) {
            if (inThink) {
              const end = rest.indexOf('</think>');
              if (end < 0) {
                rest = '';
              } else {
                rest = rest.slice(end + 8);
                inThink = false;
              }
            } else {
              const start = rest.indexOf('<think>');
              if (start < 0) {
                acc += rest;
                fullText += rest;
                rest = '';
              } else {
                acc += rest.slice(0, start);
                fullText += rest.slice(0, start);
                rest = rest.slice(start + 7);
                inThink = true;
              }
            }
          }
          for (const b of drainLines(this)) {
            emitted++;
            yield b;
          }
        }
      }
      // Flush whatever the final line held.
      if (acc.trim()) {
        for (const b of parseBubbles(acc.trim())) {
          emitted++;
          yield b;
        }
      }
      recordLlmExchange({
        providerId: this.id,
        providerKind: this.kind,
        model: opts.model,
        latencyMs: Date.now() - t0,
        request: opts.messages.map((m) => ({ role: m.role, content: m.content })),
        text: fullText,
        finishReason: finishReason ?? 'stream',
      });
      // Cut short by the model's own accounting (max_tokens hit, output audit):
      // the bubbles that landed are real, the turn is not finished.
      if (emitted > 0 && finishReason && finishReason !== 'stop') {
        truncation = new LlmError(
          'truncated',
          `stream finish_reason=${finishReason}`,
          undefined,
          this.id,
        );
      }
    } catch (e) {
      if (emitted === 0) throw e; // router falls back to the one-shot ladder
      // The USER interrupting is not the model being cut off: a new send aborts
      // this turn on purpose, and reporting that as truncation would make her
      // tack "先不说了" onto a reply the user already walked away from.
      if (opts.signal?.aborted) return;
      // Mid-stream break AFTER output: the shown bubbles stand, but the caller
      // is told the turn was cut off so it can close it in character.
      truncation = new LlmError('truncated', `stream broke: ${String(e)}`, undefined, this.id, e);
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* already closed */
      }
    }
    if (truncation) throw truncation;
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
    const r = await this.probeCatalog();
    return r.ok ? r.models : null;
  }

  /**
   * The same GET /models as listModelsLive, but it says WHY it failed instead of
   * collapsing every outcome into null. The diagnosis page needs the reason:
   * "无目录" alone cannot distinguish a CORS block from a 401 from a timeout
   * from a genuinely empty catalog, which makes the whole report unactionable.
   */
  async probeCatalog(): Promise<{
    ok: boolean;
    models: string[];
    status?: number;
    /** Human-readable failure reason; absent on success. */
    error?: string;
  }> {
    try {
      const key = await this.cfg.getKey();
      if (!key) return { ok: false, models: [], error: '未保存密钥' };
      const res = await httpJson({
        url: `${this.cfg.baseUrl.replace(/\/$/, '')}/models`,
        method: 'GET',
        headers: { Authorization: `Bearer ${key}`, ...this.cfg.extraHeaders },
        timeoutMs: 15_000,
      });
      if (res.status >= 400) {
        return { ok: false, models: [], status: res.status, error: `HTTP ${res.status}` };
      }
      const data = (res.data as { data?: Array<{ id?: string }> })?.data;
      const ids = (data ?? []).map((m) => m.id).filter((x): x is string => typeof x === 'string' && !!x);
      if (!ids.length) return { ok: false, models: [], status: res.status, error: '目录为空' };
      return { ok: true, models: ids, status: res.status };
    } catch (e) {
      return { ok: false, models: [], error: e instanceof Error ? e.message : String(e) };
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
