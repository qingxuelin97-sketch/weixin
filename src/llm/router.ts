/**
 * Model routing + degradation chain. The rest of the app asks for a *role*
 * ('chat' | 'director' | 'memory' | 'reasoning'), plus an NSFW tier; the router
 * picks the provider/model and runs the fallback ladder so a refusal or outage
 * never surfaces raw to the user.
 *
 * Degradation ladder (see specs/llm-provider.md):
 *   1. same model, rewrite the last user turn + DeepSeek prefix-prefill
 *   2. switch to the permissive fallback chain, sticky for the next N turns
 *   3. persona-styled refusal / half-sent-then-recalled — original refusal never shown
 */
import {
  type ChatProvider,
  type GenerateOptions,
  type CompletionResult,
  type Bubble,
  LlmError,
} from './types';
import { parseBubbles } from './bubbles';

export type Role = 'chat' | 'director' | 'memory' | 'reasoning';
export type NsfwTier = 'off' | 'ambiguous' | 'full';

export interface RouteRequest {
  role: Role;
  nsfwTier: NsfwTier;
  /** Persona-preferred model override, if any. */
  preferModel?: string;
}

export interface RoutePlan {
  provider: ChatProvider;
  model: string;
  /** Ordered permissive fallbacks tried on refusal (tier 2). */
  fallbacks: Array<{ provider: ChatProvider; model: string }>;
}

/** Pluggable policy: given a request, produce the primary + fallbacks. */
export interface RoutingPolicy {
  plan(req: RouteRequest): RoutePlan;
}

const REFUSAL_RE =
  /(抱歉|对不起|我(?:无法|不能|不便)|作为(?:一个)?(?:AI|人工智能|语言模型)|as an ai|i can(?:'|no)t (?:help|assist|comply|continue)|content (?:policy|filter)|违反|不适当的?内容)/i;

/** A refusal can arrive as an error, a stop reason, refusal prose, or a schema-parse miss. */
export function isRefusal(result: CompletionResult): boolean {
  if (result.finishReason === 'content_filter') return true;
  const body = result.text.trim();
  if (!body) return true;
  if (REFUSAL_RE.test(body) && body.length < 200) return true;
  return false;
}

export interface GenerateContext {
  /** Rewrite a user turn more obliquely for a same-model retry (tier 1). */
  softenLastUserTurn?: (messages: GenerateOptions['messages']) => GenerateOptions['messages'];
  /** A short assistant-prefill to break a refusal opener (DeepSeek prefix beta). */
  prefixPrefill?: string;
  /** Persona-styled fallback line if the whole ladder fails (never a raw error). */
  personaRefusal?: () => Bubble[];
}

export class LlmRouter {
  /** Conversations pinned to a fallback provider after a refusal, sticky for a while. */
  private sticky = new Map<string, { provider: ChatProvider; model: string; remaining: number }>();

  constructor(private policy: RoutingPolicy) {}

  /** Single-shot completion with the degradation ladder. `convKey` scopes stickiness. */
  async complete(
    req: RouteRequest,
    opts: Omit<GenerateOptions, 'model'>,
    ctx: GenerateContext = {},
    convKey = 'default',
  ): Promise<CompletionResult> {
    const plan = this.policy.plan(req);
    const pinned = this.sticky.get(convKey);
    const primary = pinned ?? { provider: plan.provider, model: plan.model };

    // Attempt 0: primary (or sticky) model.
    try {
      const r = await primary.provider.complete({ ...opts, model: primary.model });
      if (!isRefusal(r)) {
        if (pinned) pinned.remaining--;
        if (pinned && pinned.remaining <= 0) this.sticky.delete(convKey);
        return r;
      }
    } catch (e) {
      if (e instanceof LlmError && e.kind === 'auth') throw e; // no point laddering on bad key
      // fall through to ladder on network/server/rate/content
    }

    // Tier 1: same model, softened turn + prefix prefill.
    if (ctx.softenLastUserTurn || ctx.prefixPrefill) {
      const messages = ctx.softenLastUserTurn ? ctx.softenLastUserTurn(opts.messages) : opts.messages;
      const withPrefill = ctx.prefixPrefill
        ? [...messages, { role: 'assistant' as const, content: ctx.prefixPrefill, prefix: true }]
        : messages;
      try {
        const r = await primary.provider.complete({ ...opts, messages: withPrefill, model: primary.model });
        if (!isRefusal(r)) return r;
      } catch {
        /* continue to tier 2 */
      }
    }

    // Tier 2: permissive fallback chain, sticky.
    for (const fb of plan.fallbacks) {
      try {
        const r = await fb.provider.complete({ ...opts, model: fb.model });
        if (!isRefusal(r)) {
          this.sticky.set(convKey, { provider: fb.provider, model: fb.model, remaining: 10 });
          return r;
        }
      } catch {
        /* try next fallback */
      }
    }

    // Tier 3: give up cleanly. Caller decides how to present (persona refusal).
    throw new LlmError('content_filter', 'all routes refused or failed', undefined, primary.provider.id);
  }

  /** Bubble generation with the same ladder; tier-3 yields the persona refusal. */
  async *generate(
    req: RouteRequest,
    opts: Omit<GenerateOptions, 'model'>,
    ctx: GenerateContext = {},
    convKey = 'default',
  ): AsyncIterable<Bubble> {
    try {
      const r = await this.complete(req, opts, ctx, convKey);
      for (const b of parseBubbles(r.text)) yield b;
    } catch (e) {
      if (ctx.personaRefusal) {
        for (const b of ctx.personaRefusal()) yield b;
        return;
      }
      throw e;
    }
  }

  clearSticky(convKey: string) {
    this.sticky.delete(convKey);
  }
}
