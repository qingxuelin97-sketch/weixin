/**
 * Anti-AI-tone, second generation (M-H1).
 *
 * V1 (M-A1) is a block of rules in the system prompt: don't write essays,
 * don't use bullet points, don't close like a support agent. Rules help, and
 * they are also the only tool this app had — which means nothing ever LOOKED
 * at what she actually produced. The failures that survive a prompt rule are
 * exactly the ones you only see across turns:
 *
 *   - she says the same sentence she said four messages ago, slightly reworded;
 *   - a catchphrase that was charming once becomes a tic ("哈哈哈" opening six
 *     replies in a row);
 *   - every message ends with the same particle, or runs the same length;
 *   - one assistant-ism slips through the rules and lands on screen.
 *
 * So this module does two things a prompt cannot. It SCRUBS the bubbles before
 * playback (deterministic, no extra model call), and it feeds back one short
 * note about her own recent habits into the next prompt — the model is good at
 * "vary this", it just has no memory of what it already did.
 *
 * Pure. Text in, text out; no clock, no storage, no network.
 */

/** Her own recent lines, oldest first. Only text bubbles are worth comparing. */
export type OwnLine = string;

/** Below this, repetition is just how people talk ("嗯" / "好" / "哈哈哈"). */
const MIN_DUP_LEN = 6;
/** Jaccard on character bigrams above this counts as "she already said that". */
const DUP_SIM = 0.72;

/** Strip everything that is not signal: punctuation, spaces, emoji-ish runs. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    // \u3000 (the ideographic space) is emitted freely by Chinese IMEs, and
    // is written as an escape because a literal one is a lint error.
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。！？、~…,.!?;:；："'「」『』（）()\-—_*·]/g, '');
}

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  if (s.length === 1) out.add(s);
  return out;
}

/** 0..1 overlap of character bigrams. Cheap, and good enough for "same line". */
export function similarity(a: string, b: string): number {
  const x = bigrams(normalize(a));
  const y = bigrams(normalize(b));
  if (x.size === 0 || y.size === 0) return 0;
  let hit = 0;
  for (const g of x) if (y.has(g)) hit++;
  return hit / (x.size + y.size - hit);
}

/** Has she effectively said this already, in the lines given? */
export function isRepeat(text: string, previous: OwnLine[]): boolean {
  const t = normalize(text);
  if (t.length < MIN_DUP_LEN) return false; // short interjections are not tics
  return previous.some((p) => {
    const n = normalize(p);
    if (n.length < MIN_DUP_LEN) return false;
    return n === t || similarity(text, p) >= DUP_SIM;
  });
}

/**
 * Phrases no person types into WeChat.
 *
 * Deliberately short and unambiguous. A broad list would eat real sentences —
 * dropping a line she meant to send is worse than letting one stiff line
 * through, because the user sees a gap rather than a flaw.
 */
const ASSISTANT_ISMS =
  /(作为一个?(AI|人工智能|语言模型|助手))|(我理解(你|您)的(感受|心情))|(希望(这|以上)(能|对你).{0,6}帮助)|(还有(什么|其他).{0,4}(可以|能).{0,4}帮(你|您))|(总的来说|综上所述|首先.{0,12}其次)|(如果(你|您)还有.{0,8}(问题|疑问))/;

export function isAssistantSpeak(text: string): boolean {
  return ASSISTANT_ISMS.test(text);
}

export interface ScrubBubble {
  type: string;
  content: string;
}

/**
 * Drop what should never reach the screen: her own repeats and assistant-speak.
 *
 * NEVER returns empty when it was given something. Silence is a worse failure
 * than a repeated line: a message that does not arrive reads as the app being
 * broken, while a slightly repetitive one only reads as her being repetitive.
 * When everything is dropped, the last bubble survives — it is the freshest.
 */
export function scrubBubbles<T extends ScrubBubble>(bubbles: T[], previous: OwnLine[]): T[] {
  if (bubbles.length === 0) return bubbles;
  const kept: T[] = [];
  const seenThisTurn: string[] = [];
  for (const b of bubbles) {
    const text = b.content ?? '';
    if (b.type !== 'text' && b.type !== 'voice') {
      kept.push(b);
      continue;
    }
    if (isAssistantSpeak(text)) continue;
    // Compare against her history AND against what she already said in this
    // same turn — two bubbles saying one thing twice is the commonest form.
    if (isRepeat(text, [...previous, ...seenThisTurn])) continue;
    seenThisTurn.push(text);
    kept.push(b);
  }
  return kept.length > 0 ? kept : [bubbles[bubbles.length - 1]];
}

/* ------------------------- the feedback note ------------------------- */

/** How many of her recent lines the habit checks look at. */
const WINDOW = 8;

function tally(items: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const i of items) m.set(i, (m.get(i) ?? 0) + 1);
  return m;
}

/** The most common leading two characters, if one dominates. */
function dominantOpening(lines: OwnLine[]): string | null {
  const heads = lines.map((l) => normalize(l).slice(0, 2)).filter((h) => h.length === 2);
  if (heads.length < 4) return null;
  for (const [head, n] of tally(heads)) {
    if (n >= 3) return head;
  }
  return null;
}

/** Sentence-final particles, which is where Chinese tics live. */
const TAILS = ['呢', '呀', '啦', '嘛', '吧', '哦', '啊', '滴', '哒'];

function dominantTail(lines: OwnLine[]): string | null {
  const tails = lines.map((l) => normalize(l).slice(-1)).filter((t) => TAILS.includes(t));
  if (tails.length < 4) return null;
  for (const [tail, n] of tally(tails)) {
    if (n >= 4) return tail;
  }
  return null;
}

/** A catchphrase used past the point of being a catchphrase. */
function overusedPhrase(lines: OwnLine[], catchphrases: string[]): string | null {
  for (const phrase of catchphrases) {
    const p = normalize(phrase);
    if (p.length < 2) continue;
    const n = lines.filter((l) => normalize(l).includes(p)).length;
    if (n >= 3) return phrase;
  }
  return null;
}

/**
 * One short note about her own recent habits, for the next prompt.
 *
 * Capped at two lines and empty most of the time. This is appended to a prompt
 * that already carries a persona, a memory selection, a mood and a relationship
 * register — a paragraph of style critique here would win the attention
 * competition against the character it is supposed to be protecting.
 */
export function styleNote(ownRecent: OwnLine[], catchphrases: string[] = []): string {
  const lines = ownRecent.filter((l) => l && l.trim()).slice(-WINDOW);
  if (lines.length < 4) return ''; // not enough to have a habit yet

  const notes: string[] = [];
  const phrase = overusedPhrase(lines, catchphrases);
  if (phrase) notes.push(`「${phrase}」你最近说得太密了，这几轮先别用。`);

  const head = dominantOpening(lines);
  if (head && notes.length < 2) notes.push(`你连着好几条都用「${head}」开头，换个开法。`);

  const tail = dominantTail(lines);
  if (tail && notes.length < 2) notes.push(`你最近几乎每句都用「${tail}」收尾，少用。`);

  if (notes.length < 2) {
    const avg = lines.reduce((n, l) => n + l.length, 0) / lines.length;
    // Length monotony is the least obvious tell and the most persistent: a
    // person's messages vary between a word and a paragraph.
    if (avg > 45) notes.push('你最近几条都偏长了，这轮短一点。');
    else if (avg < 4 && lines.length >= 6) notes.push('你最近几条都太短，像在敷衍，这轮多说一句。');
  }

  return notes.length ? `【说话习惯】\n${notes.map((n) => `- ${n}`).join('\n')}` : '';
}

/**
 * Her own recent lines out of a transcript, newest last.
 *
 * Text and voice only: a sticker or a red packet is not a sentence, and
 * counting them would dilute every ratio above.
 */
export function ownLines(
  messages: Array<{ senderId: string; type: string; content?: string; isRecalled?: boolean }>,
  selfId: string,
  limit = WINDOW,
): OwnLine[] {
  return messages
    .filter(
      (m) =>
        m.senderId === selfId &&
        !m.isRecalled &&
        (m.type === 'text' || m.type === 'voice') &&
        (m.content ?? '').trim(),
    )
    .slice(-limit)
    .map((m) => m.content as string);
}
