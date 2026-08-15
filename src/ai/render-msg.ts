/**
 * How a stored message is shown TO THE MODEL (M-E1).
 *
 * Every context builder used to write its own `m.content ?? \`[${m.type}]\``.
 * For a text message that is fine. For everything else it is a hole:
 *
 *   - a red packet arrived as the literal string `[rp]`
 *   - a transfer of ¥52.00 with the note 「请你喝奶茶」 arrived as `[transfer]`
 *   - a photo the user just sent arrived as `[image]`
 *   - a 12-second voice note arrived as `[voice]`
 *
 * So "刚才给你转了多少" was unanswerable, and thanking someone for a red packet
 * was something the AI could only do by accident. The money is IN the row — it
 * was simply never projected. Four call sites, four subtly different holes; this
 * module is the one projection all of them share.
 *
 * Pure and dependency-free: no storage, no clock, no LLM. That makes the whole
 * "what does the model actually see" question unit-testable, which it was not.
 */
import type { MessageVM } from '../data/types';

/** Integer fen → 人民币 string. Money is never rounded on the way to the model. */
function yuan(fen: number): string {
  const neg = fen < 0;
  const abs = Math.abs(Math.trunc(fen));
  return `${neg ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

/** Quoted text is context, not content: enough to identify the line, no more. */
function clipQuote(q: string): string {
  const t = q.trim();
  return t.length > 24 ? `${t.slice(0, 24)}…` : t;
}

/** "3分12秒" / "45秒" — how a person would say a duration out loud. */
export function humanDuration(ms: number): string {
  const total = Math.max(1, Math.round(ms / 1000));
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return min > 0 ? `${min}分${sec}秒` : `${sec}秒`;
}

export interface RenderOptions {
  /**
   * Voice messages carry their own spoken text in `content`. Groups quoting 20
   * messages don't need it; a single chat answering "你刚说啥" does.
   */
  includeVoiceText?: boolean;
  /** Truncate each rendered body to this many chars (redaction / token budget). */
  maxChars?: number;
}

/**
 * One message as a single line of model-visible text, WITHOUT the speaker
 * prefix (callers own that — single chats and groups frame speakers differently).
 */
export function renderMessageBody(m: MessageVM, opts: RenderOptions = {}): string {
  const body = renderRaw(m, opts);
  const max = opts.maxChars;
  return max != null && body.length > max ? `${body.slice(0, max)}…` : body;
}

function renderRaw(m: MessageVM, opts: RenderOptions): string {
  // A recalled message must read as recalled, not as its original text: the AI
  // referring to something that was taken back is the single most obvious tell.
  if (m.isRecalled) return '[撤回了一条消息]';

  const meta = m.meta ?? {};
  switch (m.type) {
    case 'text': {
      const body = m.content ?? '';
      // A quoted reply only means something if the model can see WHAT was
      // quoted. The quote has been stored in `meta.quote` since M-D, and this
      // projection never read it — so "回复上面那条" arrived as a bare sentence
      // and she answered the wrong thing. The chat UI showed the quote block
      // the whole time, which is why it read as a model failure rather than a
      // missing field.
      const quoted = str(meta.quote);
      return quoted ? `[回复「${clipQuote(quoted)}」] ${body}` : body;
    }

    case 'image': {
      // `content` is an `idb:` media handle — an internal id the model must
      // never see (it would echo it back into dialogue).
      //
      // `meta.caption` is what SHE said the photo was when she sent it, so a
      // later turn can refer back to "那张饼干的照片". The old `meta.tags`
      // branch here was dead code: nothing ever wrote tags, so every picture
      // in every transcript read as a bare "[发了一张图片]".
      // `meta.caption` is what SHE said the photo was when she sent it.
      // `meta.tags` are the library tags of a photo the USER sent. Either way
      // the model gets something better than "a picture exists" — which is all
      // it used to get, since nothing wrote tags and captions did not exist.
      const caption = str(meta.caption);
      if (caption) return `[发了一张图片：${caption}]`;
      const tags = Array.isArray(meta.tags) ? meta.tags.filter((t) => typeof t === 'string') : [];
      return tags.length ? `[发了一张图片：${tags.join('、')}]` : '[发了一张图片]';
    }

    case 'voice': {
      const ms = num(meta.durationMs);
      const head = ms ? `[语音 ${humanDuration(ms)}]` : '[语音]';
      const text = opts.includeVoiceText ? str(m.content) : undefined;
      return text ? `${head}${text}` : head;
    }

    case 'sticker':
      // Custom stickers (M-I15) carry an opaque `idb:` ref — the model must
      // never see internal ids, so those project as a bare tag.
      return str(m.content) && !m.content?.startsWith('idb:') ? `[表情：${m.content}]` : '[表情]';

    case 'rp': {
      const greeting = str(meta.greeting);
      const opened = meta.opened === true;
      // The amount deliberately stays out: in WeChat the recipient cannot see it
      // before opening, and leaking it here would let the AI thank you for an
      // exact sum it has no way of knowing.
      return `[发了一个红包${greeting ? `，留言「${greeting}」` : ''}${opened ? '，已被领取' : ''}]`;
    }

    case 'transfer': {
      const fen = num(meta.amountFen);
      const note = str(meta.note);
      const status = str(meta.status);
      const state = status === 'accepted' ? '，已收下' : status === 'refunded' ? '，已退回' : '';
      // Unlike a red packet, a transfer's amount IS visible to both sides in
      // WeChat — and it is exactly what "刚给你转了多少" asks about.
      return `[转账 ¥${fen != null ? yuan(fen) : '?'}${note ? `，附言「${note}」` : ''}${state}]`;
    }

    case 'call': {
      const ms = num(meta.durationMs);
      const incoming = meta.direction === 'in';
      if (ms == null) return incoming ? '[对方打来语音通话，未接通]' : '[发起了语音通话，未接通]';
      return `[语音通话 ${humanDuration(ms)}]`;
    }

    case 'system':
      // System lines are stage directions, not speech.
      return str(m.content) ? `（${m.content}）` : '';

    case 'merged': {
      // The model sees the card's identity and its first lines — enough to
      // react to ("你转给我的那段聊天记录"), never the raw object.
      const items = Array.isArray(meta.items) ? (meta.items as Array<Record<string, unknown>>) : [];
      const title = str(meta.title) || '聊天记录';
      const preview = items
        .slice(0, 2)
        .map((raw) => {
          const it = (raw ?? {}) as Record<string, unknown>;
          return `${str(it.name) ?? ''}: ${(str(it.body) ?? '').slice(0, 20)}`;
        })
        .filter((s) => s !== ': ')
        .join('；');
      return `[转发了「${title}」共 ${items.length} 条${preview ? `，开头是：${preview}` : ''}]`;
    }

    default:
      return m.content ?? '';
  }
}

export interface TranscriptOptions extends RenderOptions {
  /** Display name for a sender. Omit for single chats (see `selfLabel`/`peerLabel`). */
  nameOf?: (senderId: string) => string;
  /** How the user is referred to in a single chat. */
  selfLabel?: string;
  /** How the AI's own past lines are labelled in a single chat. */
  peerLabel?: string;
  /** Prefix each line with its message id (memory extraction cites evidence ids). */
  withIds?: boolean;
  /** Drop messages that project to an empty string (system noise). */
  dropEmpty?: boolean;
}

/**
 * A conversation slice as the model sees it. The ONE place transcripts are
 * built, so a fix to "the AI can't see X" lands everywhere at once.
 */
export function renderTranscript(messages: MessageVM[], opts: TranscriptOptions = {}): string {
  const lines: string[] = [];
  for (const m of messages) {
    const body = renderMessageBody(m, opts);
    if (!body && (opts.dropEmpty ?? true)) continue;
    const who = opts.nameOf
      ? opts.nameOf(m.senderId)
      : m.senderId === 'self'
        ? (opts.selfLabel ?? '用户')
        : (opts.peerLabel ?? 'TA');
    lines.push(`${opts.withIds ? `[${m.id}] ` : ''}${who}: ${body}`);
  }
  return lines.join('\n');
}

/**
 * The chat engine's shape: OpenAI-style turns rather than a transcript blob,
 * because a single chat's history maps 1:1 onto user/assistant roles.
 */
export function renderTurns(
  messages: MessageVM[],
  selfId = 'self',
  opts: RenderOptions = {},
): Array<{ role: 'user' | 'assistant'; content: string }> {
  const turns: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  for (const m of messages) {
    const content = renderMessageBody(m, opts);
    if (!content) continue;
    turns.push({ role: m.senderId === selfId ? 'user' : 'assistant', content });
  }
  return turns;
}
