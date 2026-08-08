/**
 * Recall (撤回) rules — the pure half, kept out of the UI so the 2-minute
 * window and eligibility logic are unit-testable against a fixed clock.
 *
 * The invariant lives in specs/data-schema.md: a recall is an UPDATE of the
 * original row (isRecalled = true), never a placeholder insert. The original
 * content stays in the row — that is what makes 重新编辑 possible, and why
 * search must explicitly skip recalled messages (src/lib/search.ts does).
 */
import type { MessageVM, PersonaVM } from '../data/types';
import { seededRng } from './money';

/** WeChat's rule: you get two minutes to change your mind. */
export const RECALL_WINDOW_MS = 2 * 60_000;

/**
 * Message types the user may recall. Money and calls are excluded — WeChat
 * doesn't allow recalling a red packet either, and a "recalled" transfer whose
 * ledger entry still exists would contradict the wallet.
 */
const RECALLABLE_TYPES: ReadonlySet<MessageVM['type']> = new Set([
  'text',
  'image',
  'voice',
  'sticker',
]);

/** May the user recall this message right now? */
export function canRecall(msg: MessageVM, now: number): boolean {
  if (msg.senderId !== 'self') return false;
  if (msg.isRecalled) return false;
  if (!RECALLABLE_TYPES.has(msg.type)) return false;
  return now - msg.createdAt <= RECALL_WINDOW_MS;
}

/**
 * Only a recalled TEXT message offers 重新编辑 — there is nothing to re-edit
 * about a sticker, and voice content is empty.
 */
export function canReEdit(msg: MessageVM): boolean {
  return Boolean(msg.isRecalled && msg.senderId === 'self' && msg.type === 'text' && msg.content);
}

/**
 * After an AI recalls its own line, should it follow up with a cover line?
 * Seeded on the message id so replay (offline backfill included) is stable.
 */
export function shouldFollowUpAfterRecall(msgId: number | string): boolean {
  return seededRng(`recallfx:${msgId}`)() < 0.4;
}

/**
 * The cover line itself — the "戏" in 撤回戏. Persona catchphrase first when
 * available, so the line sounds like them rather than like a template.
 */
export function recallFollowUpLine(persona: PersonaVM, msgId: number | string): string {
  const pool = [
    '当我没说',
    '打错了打错了',
    '算了，没什么',
    '假装你没看见哈',
  ];
  const rng = seededRng(`recallline:${msgId}`);
  const base = pool[Math.floor(rng() * pool.length)];
  const catchphrase = persona.catchphrases[0];
  // Half the time, prefix their verbal tic — "离谱，当我没说" reads as them.
  return catchphrase && rng() < 0.5 ? `${catchphrase}，${base}` : base;
}
