/**
 * Sticker vocabulary (M-H0).
 *
 * `Bubble.type === 'sticker'` carries a SEMANTIC LABEL in `content`, not an
 * image — that has been the contract since M1. What was missing at both ends:
 *
 *   - the prompt never told the model which labels exist, so it invented them;
 *   - the renderer printed `content` directly at 64px, so an invented label
 *     arrived as enormous Chinese text sitting where a sticker should be.
 *
 * One table closes both: `STICKER_VOCAB` is what the prompt advertises AND what
 * the renderer can draw, so the two cannot drift.
 *
 * Emoji are content, not styling, which is why this lives in `data/`.
 */

/** Label → glyph. Keep the labels short and unambiguous for a model to pick. */
export const STICKER_VOCAB: Record<string, string> = {
  开心: '😄',
  笑哭: '😂',
  害羞: '☺️',
  得意: '😏',
  无语: '😑',
  白眼: '🙄',
  委屈: '🥺',
  难过: '😢',
  生气: '😠',
  惊讶: '😮',
  困: '😴',
  思考: '🤔',
  偷笑: '🤭',
  捂脸: '🤦',
  比心: '🫶',
  点赞: '👍',
  抱抱: '🤗',
  亲亲: '😘',
  玫瑰: '🌹',
  蛋糕: '🎂',
  加油: '💪',
  喝茶: '🍵',
  吃瓜: '🍉',
  拜托: '🙏',
  哈欠: '🥱',
  酷: '😎',
  哭笑不得: '😅',
  666: '🙌',
};

/** The labels the model is allowed to use, as one prompt-ready line. */
export const STICKER_LABELS = Object.keys(STICKER_VOCAB).join('、');

/** Does this string already consist of emoji? Then it needs no translation. */
function isGlyph(s: string): boolean {
  // Extended_Pictographic covers emoji across planes; a label like "开心" does
  // not match, which is exactly the distinction we need.
  // ZWJ and VS16 are listed as alternatives rather than class members: inside a
  // class they read as one combined character and eslint rejects them.
  return /^(?:[\p{Extended_Pictographic}\s]|‍|️)+$/u.test(s);
}

/**
 * The glyph to draw for a sticker message.
 *
 * Accepts a raw glyph too: older rows (and the seed data) store emoji
 * directly, and rewriting history to fit a new vocabulary would be worse than
 * accepting both.
 */
export function stickerGlyph(content: string | undefined): string {
  const raw = (content ?? '').trim();
  if (!raw) return '🙂';
  if (STICKER_VOCAB[raw]) return STICKER_VOCAB[raw];
  if (isGlyph(raw)) return raw;
  // An off-vocabulary label. A neutral face beats rendering the word itself at
  // 64px, which is what this function exists to stop.
  return '🙂';
}
