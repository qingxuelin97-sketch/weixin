/**
 * 消息翻译 (M-J7).
 *
 * WeChat's long-press → 翻译 puts the translation under the bubble, in place,
 * and keeps it there. This does the same, under the app's own constraints:
 *
 *  - **铁律 6**: a message's text IS conversation content, so the tier is
 *    derived (`tierOfConversation`) and the call goes through `getRouter()`.
 *    Translating an explicit line through a mainland endpoint would leak it
 *    exactly as a chat turn would.
 *  - **caching lives in `meta.translation` on the message itself**, not in a
 *    settings key. That was the first design and it was worse in three ways:
 *    a content-hash key has no owner, so `deleteContactCascade` could never
 *    find it (her words would outlive her); it grows without bound; and the
 *    bubble already persists the shown translation in meta, so it was a second
 *    copy of the same string. Re-opening 翻译 reads meta and never pays again.
 */
import type { LlmRouter } from '../llm/router';
import type { NsfwTier } from '../llm/router';
import { logError } from '../lib/errlog';

/** Long messages are truncated: a translation is a courtesy, not a document. */
const MAX_CHARS = 600;

const SYSTEM =
  '把用户给的这段话翻译成中文；如果它本来就是中文，就翻译成自然的英文。' +
  '只输出译文本身，不要解释、不要引号、不要加"翻译："这类前缀。';

/**
 * Translate one line. Returns undefined when the text is empty or the call
 * failed — callers show a toast; a failed translation must never replace the
 * original with an error string.
 */
export async function translateText(
  text: string,
  tier: NsfwTier,
  convId: string,
  router?: LlmRouter,
): Promise<string | undefined> {
  const src = text.trim().slice(0, MAX_CHARS);
  if (!src) return undefined;
  try {
    const r = router ?? (await (await import('../llm/service')).getRouter());
    const out = await r.complete(
      // role 'memory' is the cheap lane; a translation needs no persona and no
      // creativity, and paying chat-tier prices for it would be silly.
      { role: 'memory', nsfwTier: tier },
      {
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: src },
        ],
      },
      {},
      `translate:${convId}`,
    );
    return out.text.trim() || undefined;
  } catch (e) {
    logError('translate', e);
    return undefined;
  }
}
