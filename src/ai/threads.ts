/**
 * Loose threads, and picking them back up (M-E3).
 *
 * The single most human thing a friend does that this app could not: bring
 * something back up unprompted. "上次你说要去看牙，去了吗" — three days later,
 * without you mentioning it again.
 *
 * The app already had every ingredient and used none of them. Memory facts
 * carry evidence message ids and timestamps; the heartbeat already fires on its
 * own schedule; the opener already accepts material. What was missing is the
 * notion that some things a person says are OPEN — they imply a later state the
 * other person could ask about — and that leaving them unasked is what makes an
 * agent feel like a chatbot rather than someone who was listening.
 *
 * Zero incremental LLM cost: threads are detected by pattern from facts and
 * messages that already exist, and the callback rides the heartbeat that was
 * going to fire anyway. Pure — `now` is injected, ordering is deterministic.
 */
import type { MemoryFactVM, MessageVM } from '../data/types';
import { seededRng } from '../lib/money';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/* ==================================================================== */
/* Detection                                                             */
/* ==================================================================== */

export type ThreadKind = 'plan' | 'trouble' | 'wait' | 'promise';

export interface Thread {
  /** Stable id so a thread is only ever picked up once. */
  id: string;
  kind: ThreadKind;
  /** The thing itself, in the speaker's own words (trimmed). */
  text: string;
  /** Who said it: 'self' (the user) or a contact id. */
  speakerId: string;
  saidAt: number;
  /** Earliest sensible moment to ask. A dentist appointment is not a 2h thread. */
  ripeAt: number;
  /** After this, asking reads as odd rather than caring. */
  staleAt: number;
}

interface Pattern {
  kind: ThreadKind;
  re: RegExp;
  /** How long until asking makes sense, in hours. */
  ripeHours: number;
  /** How long the thread stays worth asking about, in hours. */
  windowHours: number;
}

/**
 * What counts as an open thread.
 *
 * Tuned to be CONSERVATIVE. A false positive is an agent asking "上次那个怎么
 * 样了" about something that was never a thing, which reads as a non-sequitur
 * and is worse than never asking at all. Every pattern here implies a future
 * state that a person would plausibly follow up on.
 */
const PATTERNS: Pattern[] = [
  // 明天要去面试 / 下周搬家 / 打算去看牙
  {
    kind: 'plan',
    re: /(明天|后天|下周|周末|过两天|待会儿?|一会儿|晚点)(?:要|得|打算|准备|去|要去)?(.{2,20})/,
    ripeHours: 20,
    windowHours: 96,
  },
  // 最近有点不舒服 / 感冒了 / 腰疼
  {
    kind: 'trouble',
    re: /(感冒|发烧|不舒服|生病|受伤|失眠|加班|吵架|压力大|难受|疼)/,
    ripeHours: 16,
    windowHours: 72,
  },
  // 在等结果 / 面试完了在等通知
  {
    kind: 'wait',
    re: /(在等|等结果|等通知|等回复|还没出来|还没消息|投了简历|递了申请)/,
    ripeHours: 24,
    windowHours: 168,
  },
  // 说好了下次一起 / 答应了要
  {
    kind: 'promise',
    re: /(说好了|约好了|答应|下次一起|改天一起|回头(?:请|带|给))(.{2,20})/,
    ripeHours: 48,
    windowHours: 336,
  },
];

/**
 * Find open threads in a slice of conversation.
 *
 * Only the USER's and the peer's own text is scanned, and only text messages:
 * a red packet is not a plan, and a system line is not a promise.
 */
export function detectThreads(messages: MessageVM[], convId: string): Thread[] {
  const out: Thread[] = [];
  for (const m of messages) {
    if (m.type !== 'text' || !m.content || m.isRecalled) continue;
    const text = m.content.trim();
    // Questions state no plan of their own — "你明天去看牙吗" is the follow-up,
    // not the thread. Detecting it would make agents ask about their own asks.
    if (/[?？]$/.test(text)) continue;
    for (const p of PATTERNS) {
      if (!p.re.test(text)) continue;
      out.push({
        id: `th_${convId}_${m.id}_${p.kind}`,
        kind: p.kind,
        text: text.slice(0, 40),
        speakerId: m.senderId,
        saidAt: m.createdAt,
        ripeAt: m.createdAt + p.ripeHours * HOUR,
        staleAt: m.createdAt + p.windowHours * HOUR,
      });
      break; // one thread per message: the first matching kind wins
    }
  }
  return out;
}

/**
 * Was this thread already closed by later conversation?
 *
 * The cheap, reliable signal: somebody mentioned the same distinctive words
 * after it was opened. Asking about something you already discussed yesterday
 * is the most annoying possible failure mode, so the check errs toward "closed".
 */
export function isClosed(thread: Thread, messages: MessageVM[]): boolean {
  const keys = keyTerms(thread.text);
  if (keys.length === 0) return true; // nothing distinctive → not worth asking
  return messages.some(
    (m) =>
      m.createdAt > thread.saidAt &&
      m.type === 'text' &&
      !m.isRecalled &&
      typeof m.content === 'string' &&
      keys.some((k) => m.content!.includes(k)),
  );
}

/**
 * Characters common enough that matching on them means nothing. Without this
 * list every follow-up would look "closed" the moment any message contained 了.
 */
const COMMON_CHARS = new Set(
  '的了是我你他她它们在有和就不人一个上也很到说要去会着没这那都可以吗呢啊吧被把给对能好还只更'.split(''),
);

/**
 * What to look for when deciding whether a thread was already picked up.
 *
 * Overlapping bigrams AND distinctive single characters — deliberately loose,
 * because the two errors are not symmetric. A missed follow-up costs one warm
 * moment; asking about something already discussed yesterday is the single most
 * annoying failure this feature can produce. So 「明天要去看牙」 is considered
 * closed by 「牙看完了」, which shares no bigram at all but obviously answers it.
 */
function keyTerms(text: string): string[] {
  const stripped = text.replace(
    /(明天|后天|下周|周末|过两天|待会儿?|一会儿|晚点|要去|打算|准备|说好了|约好了)/g,
    '',
  );
  const clean = stripped.replace(/[\s，。！？、,.!?~…]/g, '');
  const terms: string[] = [];
  for (let i = 0; i + 2 <= clean.length; i++) terms.push(clean.slice(i, i + 2));
  for (const ch of clean) {
    if (!COMMON_CHARS.has(ch) && /[\u4e00-\u9fff]/.test(ch)) terms.push(ch);
  }
  return [...new Set(terms)].slice(0, 8);
}

/* ==================================================================== */
/* Selection                                                             */
/* ==================================================================== */

export interface PickOptions {
  /** Thread ids already picked up. A thread is followed up ONCE, ever. */
  used?: ReadonlySet<string>;
  /** Seed for the tie-break roll; keeps replay deterministic. */
  seed?: string;
}

/**
 * The thread worth bringing up now, if any.
 *
 * Ripe, not stale, not already closed by later talk, not already used. Among
 * candidates: the user's own words outrank the agent's (asking about YOUR
 * dentist appointment lands; reporting on her own is just narration), then
 * oldest-ripe first so nothing rots in the queue.
 */
export function pickThread(
  threads: Thread[],
  messages: MessageVM[],
  now: number,
  opts: PickOptions = {},
): Thread | null {
  const used = opts.used ?? new Set<string>();
  const ripe = threads.filter(
    (t) =>
      !used.has(t.id) && now >= t.ripeAt && now <= t.staleAt && !isClosed(t, messages),
  );
  if (ripe.length === 0) return null;

  const ranked = [...ripe].sort((a, b) => {
    const aUser = a.speakerId === 'self' ? 0 : 1;
    const bUser = b.speakerId === 'self' ? 0 : 1;
    return aUser - bUser || a.ripeAt - b.ripeAt || a.id.localeCompare(b.id);
  });

  // A small chance of skipping this round: a friend who follows up on
  // absolutely everything, every time, reads as a checklist rather than a
  // person. Seeded, so replay is exact.
  const roll = seededRng(`thread:${opts.seed ?? ''}:${ranked[0].id}`)();
  return roll < 0.75 ? ranked[0] : null;
}

/** The opener directive for a picked-up thread. Never the line itself. */
export function threadDirective(thread: Thread, now: number): string {
  const days = Math.max(1, Math.round((now - thread.saidAt) / DAY));
  const ago = days === 1 ? '昨天' : `${days}天前`;
  const mine = thread.speakerId === 'self';
  const subject = mine ? '对方' : '你自己';
  const asks: Record<ThreadKind, string> = {
    plan: `${ago}${subject}提过「${thread.text}」。自然地问一句后来怎么样了`,
    trouble: `${ago}${subject}说到「${thread.text}」。关心一句好点没有，别说教`,
    wait: `${ago}${subject}说在等「${thread.text}」的结果。问问有消息了吗`,
    promise: `${ago}说好了「${thread.text}」。轻轻提一下这事，别催`,
  };
  return `${asks[thread.kind]}——一句就够，问完就正常聊，不要连环追问。`;
}

/* ==================================================================== */
/* Facts as threads                                                      */
/* ==================================================================== */

/**
 * Threads recoverable from long-term memory rather than the recent window.
 *
 * Memory outlives the 30-message context, so this is what lets her ask about
 * something from two weeks ago that has scrolled entirely out of the transcript.
 */
export function threadsFromFacts(facts: MemoryFactVM[], subjectId: string): Thread[] {
  const out: Thread[] = [];
  for (const f of facts) {
    if (f.status === 'archived') continue;
    // Gossip is not a thread: asking about something you only overheard from a
    // third party is a tell, not warmth.
    if (f.source === 'hearsay') continue;
    for (const p of PATTERNS) {
      if (!p.re.test(f.fact)) continue;
      out.push({
        id: `th_fact_${f.id}_${p.kind}`,
        kind: p.kind,
        text: f.fact.slice(0, 40),
        speakerId: subjectId === f.subjectId ? 'self' : f.subjectId,
        saidAt: f.createdAt,
        ripeAt: f.createdAt + p.ripeHours * HOUR,
        staleAt: f.createdAt + p.windowHours * HOUR,
      });
      break;
    }
  }
  return out;
}
