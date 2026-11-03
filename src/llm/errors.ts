/**
 * LLM 错误类型 (M-L1，从 types.ts 抽出)。
 *
 * 单独成文件只为一件事：types.ts 为 BubbleSchema 引入了 zod，而 http.ts / tts.ts /
 * 成本闸只要这一个错误类——从 types.ts 拿它，整个 zod 就跟着进了冷启动主包。
 * 这个文件**不许**引入 zod 或任何 LLM 运行时模块（守卫：l1-lean-main.test.ts）。
 */

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
