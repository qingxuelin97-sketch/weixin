/**
 * When she sends a voice note instead of typing (M-H1).
 *
 * `voice` has been a legal bubble type since M2 and the TTS pipeline works —
 * but the only thing that ever told the model about it was one clause buried
 * in the base rules ("可用 type：text｜voice｜sticker"). Predictably, voice
 * notes essentially never happen: the model has no idea WHEN a person would
 * send one, and the base rules cannot tell it, because that depends on the
 * hour, the mood, and what was just said.
 *
 * Which is the whole content of this module: the conditions under which a
 * real person reaches for the mic instead of the keyboard. Everyone has met
 * both kinds of friend, and the difference is entirely situational —
 *
 *   - walking / eating / lying in bed, i.e. hands busy or eyes closed;
 *   - something too long or too emotional to type;
 *   - being tired, which is when typing feels like work;
 *   - being told something that deserves more than text can carry.
 *
 * Pure, and gated: never advertised when the persona has no voice configured,
 * because an unusable capability just produces voice bubbles that arrive as
 * silent grey bars.
 */
import { seededRng } from '../lib/money';
import type { PersonaVM } from '../data/types';

/** Local hour, so "late at night" means late where the user is. */
function hourOf(now: number): number {
  return new Date(now).getHours();
}

export interface VoiceContext {
  now: number;
  /** The day's mood key (`mood.ts`). Tired people talk instead of typing. */
  mood?: string;
  /** The last thing the user said, for the "this deserves a voice note" case. */
  lastUserText?: string;
  /** Stable per-turn seed — same turn, same decision on replay. */
  seed: string;
}

/** Things that are hard to answer in text without sounding flat. */
const HEAVY = /(分手|吵架|难受|哭|生病|住院|失业|被裁|考砸|挂科|想你|喜欢你|爱你|抱抱|对不起|我错了)/;
/** Things that suggest her hands are busy, so she would talk. */
const HANDS_BUSY = /(在路上|走着|开车|做饭|吃饭|健身|跑步|排队|地铁|公交)/;

/**
 * How likely a voice note is this turn, 0..1.
 *
 * The base rate is deliberately low. A friend who answers everything by voice
 * is a specific and fairly rare kind of person; the default should be the
 * common one, with the situation pushing it up.
 */
export function voiceUrge(ctx: VoiceContext): number {
  let p = 0.06;
  const h = hourOf(ctx.now);
  // Late at night people type less and talk more — nobody is watching.
  if (h >= 23 || h < 2) p += 0.1;
  if (ctx.mood === 'tired') p += 0.12;
  if (ctx.mood === 'excited' || ctx.mood === 'happy') p += 0.06;
  const text = ctx.lastUserText ?? '';
  if (HEAVY.test(text)) p += 0.18;
  if (HANDS_BUSY.test(text)) p += 0.12;
  // Something long enough that typing an answer would be work.
  if (text.length >= 60) p += 0.08;
  return Math.min(p, 0.45);
}

/**
 * Should this turn suggest a voice note? Seeded, so a replayed turn decides
 * the same way and a screenshot test never flickers.
 */
export function wantsVoice(ctx: VoiceContext): boolean {
  return seededRng(`voice:${ctx.seed}`)() < voiceUrge(ctx);
}

/**
 * The prompt line. Empty unless the persona actually has a voice AND this turn
 * qualifies — every line here competes with the persona for attention, and one
 * that says "you may optionally consider possibly using voice" is worse than
 * none.
 */
export function voiceDirective(
  persona: Pick<PersonaVM, 'ttsVoice'>,
  ctx: VoiceContext,
  ttsReady: boolean,
): string {
  if (!ttsReady || !persona.ttsVoice) return '';
  if (!wantsVoice(ctx)) return '';
  return [
    '这一条你想直接说，不想打字——用 {"type":"voice","content":"你要说的话"} 发一条语音。',
    '语音是说出来的：短一点，别写成书面语，一条就够，剩下的还是打字。',
  ].join('');
}
