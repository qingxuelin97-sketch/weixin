/**
 * Image parts for chat messages (M-H1).
 *
 * Until now a photo reached the model as the string `[发了一张图片]` — the
 * projection layer had a branch for descriptive tags, but nothing ever wrote
 * those tags, so every picture you sent was, to her, an announcement that a
 * picture existed. She could not comment on it, could not recognise a place or
 * a person in it, and would happily say "好好看" about a screenshot of an error
 * message.
 *
 * WHAT THIS IS NOT: a second routing path. Image content is conversation
 * content, so it rides the SAME `ChatMessage` list, through the SAME router,
 * under the SAME tier. Constitution rule #6 covers photographs at least as
 * strongly as it covers text — a full-tier photo must not reach a domestic
 * official endpoint, and the only way to guarantee that is to never build a
 * separate channel that could forget to ask.
 */

/** One part of a multi-part message body, in the shape every OpenAI-compatible API uses. */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };

/**
 * Models known to accept image parts.
 *
 * Matched on the MODEL name rather than the provider, because a provider slot
 * is a base URL and a key — the same slot commonly serves both vision and
 * text-only models, and a gateway like Zen serves dozens. An unknown model is
 * treated as text-only: guessing wrong costs a hard 400 on every single turn,
 * while guessing conservatively costs one missed capability that the user can
 * turn on explicitly.
 */
const VISION_MODEL_RE =
  /(vision|vl\b|-v\d|gpt-4o|gpt-4\.1|gpt-5|claude-3|claude-4|claude-opus|claude-sonnet|gemini|qwen-?vl|internvl|minicpm-v|llava|abab.*vision|glm-4v|step-1v)/i;

export function modelSupportsVision(model: string | undefined): boolean {
  return !!model && VISION_MODEL_RE.test(model);
}

/**
 * Approximate cost ceiling. A photo is worth roughly a thousand tokens even at
 * low detail, so sending the whole album on every turn is how a conversation
 * quietly becomes expensive. Only the newest few images ride along.
 */
export const MAX_IMAGES_PER_TURN = 3;

/** Images above this size are downscaled before encoding — see `encodeImage`. */
export const MAX_IMAGE_EDGE = 768;

/**
 * A data URL for a blob, downscaled so the long edge is at most `MAX_IMAGE_EDGE`.
 *
 * Phone photos are several megabytes and 4000px wide; sent raw they would blow
 * the request size, cost a fortune in image tokens, and add seconds of latency
 * for detail no chat reply needs. Downscaling happens on a canvas, so it works
 * in the WebView with no native dependency.
 */
export async function encodeImage(blob: Blob): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, w, h);
    bitmap.close?.();
    // JPEG at 0.8: visually indistinguishable at this size, a third the bytes
    // of PNG for photographs, and universally accepted by vision endpoints.
    return canvas.toDataURL('image/jpeg', 0.8);
  } catch {
    // A decode failure must never break the turn — she simply falls back to
    // knowing that a picture was sent, which is the behaviour we had before.
    return null;
  }
}

/**
 * Fold image parts into the last user message.
 *
 * Returns the messages unchanged when there is nothing to add, so callers can
 * apply it unconditionally and the text-only path stays byte-identical
 * (which matters: an unchanged prefix is a cacheable prefix).
 */
export function attachImages<T extends { role: string; content: string }>(
  messages: T[],
  images: string[],
): Array<T | { role: string; content: ContentPart[] }> {
  if (images.length === 0) return messages;
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUser) return messages;
  return messages.map((m) => {
    if (m !== lastUser) return m;
    const parts: ContentPart[] = [
      ...images.slice(0, MAX_IMAGES_PER_TURN).map(
        (url): ContentPart => ({ type: 'image_url', image_url: { url, detail: 'low' } }),
      ),
    ];
    // Text last: the instruction should be the most recent thing read, and
    // several providers weight the trailing part of a multi-part body higher.
    if (m.content) parts.push({ type: 'text', text: m.content });
    return { role: m.role, content: parts };
  });
}
