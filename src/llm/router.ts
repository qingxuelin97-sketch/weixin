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
  type LlmErrorKind,
  LlmError,
} from './types';
import { parseBubbles } from './bubbles';
import { logError } from '../lib/errlog';
import { recordUsage, type UsageKind } from '../lib/usage';

/** Attribute a call to what caused it, using the conv key the caller passed. */
function usageKindFor(role: Role, convKey: string): UsageKind {
  if (role === 'director') return 'director';
  if (role === 'memory') return 'memory';
  if (convKey.startsWith('dm:')) return 'agent_dm';
  if (convKey.startsWith('story:')) return 'story';
  if (convKey.startsWith('moments:') || convKey.startsWith('moment:')) return 'moments';
  if (role === 'reasoning') return 'other';
  return 'chat';
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export type Role = 'chat' | 'director' | 'memory' | 'reasoning';
export type NsfwTier = 'off' | 'ambiguous' | 'full';

export interface RouteRequest {
  role: Role;
  nsfwTier: NsfwTier;
  /** Persona-preferred model override, if any. */
  preferModel?: string;
  /**
   * Persona-preferred provider id. Ignored on the full NSFW tier — the
   * permissive-channel routing rule outranks any per-persona preference.
   */
  preferProvider?: string;
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

/**
 * Unambiguous refusals: the model breaking character to talk about itself or
 * about policy. These fire on their own.
 */
const HARD_REFUSAL_RE =
  /(作为(?:一个)?(?:AI|人工智能|语言模型|助手)|as an ai|i can(?:'|no)t (?:help|assist|comply|continue)|content (?:policy|filter)|违反(?:了)?(?:相关)?(?:政策|规定|准则)|不适当的?内容|无法提供(?:相关)?(?:内容|帮助)|不能协助)/i;

/**
 * Apologies and "I can't" are ORDINARY SPEECH in Chinese, not refusals.
 *
 * The old pattern fired on a bare 抱歉 / 我不能, so a persona writing the
 * perfectly in-character 「抱歉啊，我今天不太想聊这个」 was classified as a
 * refusal — burning the entire degradation ladder (a softened retry, then every
 * permissive fallback in turn) on a reply that had already succeeded, and
 * eventually showing the user a persona-styled apology instead of the line the
 * model actually wrote. So a soft marker only counts alongside a policy one.
 */
const SOFT_REFUSAL_RE = /(抱歉|对不起|我(?:无法|不能|不便))/;
const POLICY_RE = /(政策|规定|准则|内容|限制|要求|讨论(?:这|该)|回答(?:这|该)|协助|提供)/;

/** A refusal can arrive as an error, a stop reason, refusal prose, or a schema-parse miss. */
export function isRefusal(result: CompletionResult): boolean {
  if (result.finishReason === 'content_filter') return true;
  const body = result.text.trim();
  if (!body) return true;
  if (HARD_REFUSAL_RE.test(body)) return true;
  // A short apology THAT ALSO talks about policy or about what it can provide.
  if (body.length < 120 && SOFT_REFUSAL_RE.test(body) && POLICY_RE.test(body)) return true;
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
    // Every rung's failure is recorded. Pre-M-E all three catches were bare
    // `{}` blocks: a user whose key had expired saw a persona-styled "我现在不太
    // 想聊这个" and there was no trace anywhere of the 401 that caused it.
    const failures: Array<{ rung: string; providerId: string; err: unknown }> = [];
    const note = (rung: string, providerId: string, err: unknown) => {
      failures.push({ rung, providerId, err });
      logError(`llm.${rung}[${providerId}]`, err);
    };

    const plan = this.policy.plan(req);
    // Stickiness is scoped per (conversation, tier): a provider pinned on a lower
    // tier must never carry a later full-tier turn (constitution rule #6 — the
    // pin could be a domestic endpoint), and a full-tier pin is by construction
    // permissive so it must not leak "backwards" either.
    const stickyKey = `${convKey}::${req.nsfwTier}`;
    const pinned = this.sticky.get(stickyKey);
    const primary = pinned ?? { provider: plan.provider, model: plan.model };

    // Every call the app makes passes through here — the one honest place to
    // count them. The user's own key pays for the heartbeats, memory passes and
    // group casting that happen with nobody pressing anything (M-E6).
    void recordUsage(usageKindFor(req.role, convKey), Date.now()).catch(() => {});

    // Attempt 0: primary (or sticky) model.
    try {
      const r = await primary.provider.complete({ ...opts, model: primary.model });
      if (!isRefusal(r)) {
        if (pinned) pinned.remaining--;
        if (pinned && pinned.remaining <= 0) this.sticky.delete(stickyKey);
        return r;
      }
    } catch (e) {
      note('primary', primary.provider.id, e);
      if (e instanceof LlmError && e.kind === 'auth') throw e; // no point laddering on bad key
      // A sticky pin that just failed must not be retried by the next turn —
      // otherwise one dead fallback keeps hijacking the conversation.
      if (pinned) this.sticky.delete(stickyKey);
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
      } catch (e) {
        note('soften', primary.provider.id, e);
      }
    }

    // Tier 2: permissive fallback chain, sticky.
    for (const fb of plan.fallbacks) {
      try {
        const r = await fb.provider.complete({ ...opts, model: fb.model });
        if (!isRefusal(r)) {
          this.sticky.set(stickyKey, { provider: fb.provider, model: fb.model, remaining: 10 });
          return r;
        }
      } catch (e) {
        note('fallback', fb.provider.id, e);
      }
    }

    // Tier 3: give up cleanly. Caller decides how to present (persona refusal).
    // The kind now reflects what actually happened: calling an outage or an
    // expired key a "content_filter" sent every diagnosis down the wrong path.
    const first = failures[0]?.err;
    const kind: LlmErrorKind =
      failures.length === 0
        ? 'content_filter'
        : first instanceof LlmError
          ? first.kind
          : 'unknown';
    const detail = failures.length
      ? failures.map((f) => `${f.rung}/${f.providerId}: ${errText(f.err)}`).join(' | ')
      : 'all routes refused';
    throw new LlmError(kind, detail.slice(0, 400), undefined, primary.provider.id, first);
  }

  /** Bubble generation with the same ladder; tier-3 yields the persona refusal. */
  async *generate(
    req: RouteRequest,
    opts: Omit<GenerateOptions, 'model'>,
    ctx: GenerateContext = {},
    convKey = 'default',
  ): AsyncIterable<Bubble> {
    // Web-only progressive path (M-I5): stream from the PRIMARY rung. The
    // degradation ladder is strictly a pre-first-bubble affair — refusal
    // handling and provider fallback need the freedom to throw the text away,
    // and a bubble already shown cannot be un-shown. So: the first bubble is
    // inspected before release (a refusal opener aborts the stream and drops
    // to the ladder); any later break ends the turn with what was shown.
    // JSON-mode calls never stream — structured output is parsed whole.
    const plan = this.policy.plan(req);
    const stickyKey = `${convKey}::${req.nsfwTier}`;
    const pinned = this.sticky.get(stickyKey);
    const primary = pinned ?? { provider: plan.provider, model: plan.model };
    if (!opts.json && primary.provider.canStream?.() && primary.provider.generateStream) {
      let released = 0;
      try {
        void recordUsage(usageKindFor(req.role, convKey), Date.now()).catch(() => {});
        for await (const b of primary.provider.generateStream({ ...opts, model: primary.model })) {
          if (released === 0 && isRefusal({ text: b.content, finishReason: null, raw: null })) {
            // First bubble reads as a refusal — abandon the stream unshown
            // and let the one-shot ladder (soften/fallback/persona) handle it.
            break;
          }
          released++;
          yield b;
        }
        if (released > 0) {
          if (pinned && --pinned.remaining <= 0) this.sticky.delete(stickyKey);
          return; // the stream carried the turn
        }
      } catch (e) {
        if (released > 0) return; // shown bubbles stand; end quietly
        logError(`llm.stream[${primary.provider.id}]`, e);
        // fall through to the one-shot ladder
      }
    }

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
    // Pins are keyed `${convKey}::${tier}` — clear every tier's pin for the conv.
    for (const k of [...this.sticky.keys()]) {
      if (k === convKey || k.startsWith(`${convKey}::`)) this.sticky.delete(k);
    }
  }
}
