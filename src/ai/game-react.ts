/**
 * 表情游戏接梗 (M-I13): the directive that turns a thrown die into banter.
 *
 * The projection layer already lets the model SEE "[掷出了骰子，点数是 3 点]".
 * What it cannot know from a transcript line is the etiquette: when to throw
 * back, and — crucially for rock-paper-scissors — that her own hand is decided
 * by the system AFTER she emits the bubble, so commenting on a result she has
 * not seen yet is the tell of all tells. This module states both, and closes
 * the loop one turn later: once both hands are on the table it computes who
 * won and hands her the gloating rights ("你赢了，可以得意").
 *
 * Pure: reads a message window, returns a string. Seeds live elsewhere.
 */
import type { MessageVM } from '../data/types';
import { RPS_LABELS, diceResult, rpsResult, rpsCompare } from '../lib/game';

interface Throw {
  msg: MessageVM;
  game: 'dice' | 'rps';
  result: number;
}

function asThrow(m: MessageVM): Throw | null {
  if (m.type !== 'game' || m.isRecalled) return null;
  const meta = m.meta ?? {};
  return meta.game === 'rps'
    ? { msg: m, game: 'rps', result: rpsResult(meta.result) }
    : { msg: m, game: 'dice', result: diceResult(meta.result) };
}

/** How near the tail a finished round must be to still be worth a comment. */
const ROUND_WINDOW = 4;

/**
 * The game line for this turn's system prompt, or '' when no game is live.
 *
 * @param recent the conversation window, chronological
 * @param actorId the AI whose turn is being generated (peer id in a single
 *   chat, the member's contactId in a group)
 */
export function gameDirective(recent: MessageVM[], actorId: string): string {
  const live = recent.filter((m) => !m.isRecalled && m.type !== 'system');
  const last = live.at(-1);
  if (!last) return '';

  // Case 1 — the newest message is someone ELSE's throw: respond to it now.
  const lastThrow = asThrow(last);
  if (lastThrow && last.senderId !== actorId) {
    if (lastThrow.game === 'dice') {
      return (
        '# 表情游戏\n' +
        `对方刚掷了骰子，掷出了 ${lastThrow.result} 点。接个梗，别无视：` +
        '可以评价点数，也可以比大小——想比就回一个 {"type":"dice","content":""} 气泡，' +
        '你的点数由系统决定，这一轮别自己报数。'
      );
    }
    return (
      '# 表情游戏\n' +
      `对方刚猜拳出了「${RPS_LABELS[lastThrow.result]}」。想应战就回一个 ` +
      '{"type":"rps","content":""} 气泡——你的手势由系统随机决定，你现在并不知道，' +
      '所以这一轮绝不要评价谁输谁赢，等下一轮看到结果再说。'
    );
  }

  // Case 2 — a finished round sits at the tail: both hands visible, and the
  // newest message is NOT a throw (she is past the "don't spoil it" turn).
  // One directive, only while the round is fresh, so she gloats once rather
  // than bringing up the same win for the rest of the conversation.
  const throws = live.flatMap((m) => asThrow(m) ?? []);
  if (throws.length < 2) return '';
  const [a, b] = throws.slice(-2);
  const tailIdx = live.indexOf(b.msg);
  if (live.length - 1 - tailIdx >= ROUND_WINDOW) return '';
  // A round is one throw from each side, same game, in either order.
  const mine = a.msg.senderId === actorId ? a : b.msg.senderId === actorId ? b : null;
  const theirs = a.msg.senderId !== actorId ? a : b.msg.senderId !== actorId ? b : null;
  if (!mine || !theirs || mine.game !== theirs.game) return '';

  if (mine.game === 'dice') {
    const diff = mine.result - theirs.result;
    const verdict =
      diff > 0 ? '你的点大，你赢了，可以小小得意' : diff < 0 ? '对方点大，你输了，可以不服' : '平了';
    return (
      '# 表情游戏\n' +
      `刚才比骰子：你掷出 ${mine.result} 点，对方掷出 ${theirs.result} 点——${verdict}。` +
      '就着这个结果说一两句，之后别再反复提。'
    );
  }
  const cmp = rpsCompare(mine.result, theirs.result);
  const verdict =
    cmp > 0 ? '你赢了，可以得意' : cmp < 0 ? '你输了，可以耍赖或认输' : '平了，可以再来一局';
  return (
    '# 表情游戏\n' +
    `刚才猜拳：你出了「${RPS_LABELS[mine.result]}」，对方出了「${RPS_LABELS[theirs.result]}」` +
    `——${verdict}。就着这个结果说一两句，之后别再反复提。`
  );
}
