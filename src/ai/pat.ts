/**
 * 拍一拍 (M-J7).
 *
 * WeChat's smallest interaction and one of its most characteristic: double-tap
 * someone's avatar and a grey system line appears in the thread — 「你拍了拍
 * "小雨"」, plus whatever suffix each side has set on themselves. No bubble, no
 * unread count, no notification. It is a poke, and its charm is that it costs
 * nothing and means whatever the two of you decide it means.
 *
 * Everything here is pure: the line is a template, and whether/when she pats
 * back is `seededRng` over the message id (铁律 4), so a replay of the same
 * thread produces the same pokes. The delay lands in `scheduled_actions` like
 * every other timed thing (铁律 5) — a `setTimeout` here would lose the pat-back
 * the moment the user leaves the chat, which is exactly when it is charming.
 */
import { seededRng } from '../lib/money';
import type { PersonaVM } from '../data/types';

/** WeChat caps the suffix; longer ones are silently truncated by the client. */
export const PAT_SUFFIX_MAX = 12;

/** settings KV: the user's own suffix, e.g. 「的脑袋」. */
export const PAT_SUFFIX_KEY = 'patSuffix';

/**
 * The grey line. Quotes around the name are WeChat's own styling, and the
 * suffix belongs to the person being patted — 「你拍了拍"小雨"的头发」 reads as
 * her having set 的头发 on herself, which is precisely the joke.
 */
export function patLine(actorName: string, targetName: string, suffix?: string): string {
  const tail = (suffix ?? '').trim().slice(0, PAT_SUFFIX_MAX);
  return `${actorName}拍了拍"${targetName}"${tail}`;
}

/**
 * Does she pat back? Sociable personas do it often, reserved ones rarely.
 * Never a certainty: a pat that always bounces back is a machine, not a person.
 */
export function shouldPatBack(persona: Pick<PersonaVM, 'proactivity'>, seed: string): boolean {
  const p = Math.max(0, Math.min(1, persona.proactivity));
  // 0.2 floor / 0.75 ceiling: even the most withdrawn persona pokes back
  // sometimes, and even the bubbliest sometimes just… doesn't.
  return seededRng(`patback:${seed}`)() < 0.2 + p * 0.55;
}

/**
 * How long she takes. Fast enough to feel like a reflex, slow enough that it
 * is clearly a reaction and not an echo.
 */
export function patBackDelayMs(persona: Pick<PersonaVM, 'typingCpm'>, seed: string): number {
  const r = seededRng(`patdelay:${seed}`)();
  // A quick typist is a quick poker; the range stays inside a few seconds so
  // the user is still looking at the thread when it lands.
  const base = persona.typingCpm >= 300 ? 1200 : 2200;
  return Math.round(base + r * 2600);
}
