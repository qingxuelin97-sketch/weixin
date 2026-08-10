import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import {
  updateConvState,
  convStateDirective,
  answersQuestion,
  refreshConvState,
  getConvState,
  EMPTY_STATE,
  QUESTION_TTL_MS,
  type ConvState,
} from '../../src/ai/conv-state';
import { recordUsage, getUsage, clearUsage } from '../../src/lib/usage';
import { isRefusal } from '../../src/llm/router';
import { parseBubbles } from '../../src/llm/bubbles';
import type { MessageVM } from '../../src/data/types';

/**
 * M-E6: what the conversation is in the middle of, and the levers the user
 * finally has when an agent goes off the rails.
 */

const T0 = 1_755_600_000_000;
const MIN = 60_000;

function msg(id: number, senderId: string, content: string, at = T0 + id * MIN): MessageVM {
  return { id, convId: 'c1', senderId, type: 'text', content, status: 'sent', createdAt: at };
}

describe('conversation state', () => {
  it('tracks a question nobody answered', () => {
    const s = updateConvState(EMPTY_STATE, [msg(1, 'self', '你上次说的那家店叫什么来着？')], T0 + MIN);
    expect(s.open).toHaveLength(1);
    expect(s.open[0].askerId).toBe('self');
  });

  it('closes it as soon as the other side says something back', () => {
    const s = updateConvState(
      EMPTY_STATE,
      [msg(1, 'self', '那家店叫什么？'), msg(2, 'ai_lin', '叫「三分野」')],
      T0 + 2 * MIN,
    );
    expect(s.open).toEqual([]);
  });

  it('does not let the asker answer their own question', () => {
    const q = { text: '?', askerId: 'self', askedAt: T0, msgId: 1 };
    expect(answersQuestion(q, msg(2, 'self', '算了', T0 + MIN))).toBe(false);
    expect(answersQuestion(q, msg(2, 'ai_lin', '是这家', T0 + MIN))).toBe(true);
  });

  it('does not treat another question as an answer', () => {
    const q = { text: '?', askerId: 'self', askedAt: T0, msgId: 1 };
    expect(answersQuestion(q, msg(2, 'ai_lin', '你说哪家？', T0 + MIN))).toBe(false);
  });

  it('keeps the newest questions and forgets the stale ones', () => {
    const old = msg(1, 'self', '很久以前问的？', T0 - QUESTION_TTL_MS - MIN);
    const fresh = msg(2, 'self', '刚问的？', T0);
    const s = updateConvState(EMPTY_STATE, [old, fresh], T0);
    // Coming back to something from yesterday afternoon reads as odd, not
    // as attentive.
    expect(s.open.map((q) => q.msgId)).toEqual([2]);
  });

  it('notices a promise', () => {
    const s = updateConvState(EMPTY_STATE, [msg(1, 'ai_lin', '我明天给你带一份')], T0);
    expect(s.promises[0]).toContain('明天');
  });

  it('is bounded so the state cannot grow without limit', () => {
    let s: ConvState = EMPTY_STATE;
    for (let i = 1; i <= 30; i++) s = updateConvState(s, [msg(i, 'self', `第${i}个问题？`)], T0 + 30 * MIN);
    expect(s.open.length).toBeLessThanOrEqual(3);
    expect(s.topics.length).toBeLessThanOrEqual(3);
  });

  it('ignores recalled and non-text messages', () => {
    const recalled: MessageVM = { ...msg(1, 'self', '问题？'), isRecalled: true };
    const rp: MessageVM = { ...msg(2, 'self', ''), type: 'rp' };
    expect(updateConvState(EMPTY_STATE, [recalled, rp], T0).open).toEqual([]);
  });
});

describe('the prompt line', () => {
  it('only surfaces questions the USER asked', () => {
    // Reminding her to answer her own question is nonsense.
    const hers: ConvState = {
      ...EMPTY_STATE,
      open: [{ text: '你吃了吗？', askerId: 'ai_lin', askedAt: T0, msgId: 1 }],
    };
    expect(convStateDirective(hers, T0)).toBe('');
    const mine: ConvState = {
      ...EMPTY_STATE,
      open: [{ text: '那家店叫什么？', askerId: 'self', askedAt: T0, msgId: 1 }],
    };
    expect(convStateDirective(mine, T0)).toContain('那家店');
  });

  it('says nothing when there is nothing open', () => {
    expect(convStateDirective(EMPTY_STATE, T0)).toBe('');
  });

  it('asks for one thing at a time', () => {
    const s: ConvState = {
      ...EMPTY_STATE,
      open: [
        { text: 'A？', askerId: 'self', askedAt: T0, msgId: 1 },
        { text: 'B？', askerId: 'self', askedAt: T0, msgId: 2 },
      ],
      promises: ['我明天带给你'],
    };
    const line = convStateDirective(s, T0);
    expect(line).toContain('挑一件说');
    expect(line).toContain('A？');
    expect(line).not.toContain('B？');
  });

  it('drops a question that aged out between the fold and the prompt', () => {
    const s: ConvState = {
      ...EMPTY_STATE,
      open: [{ text: '老问题？', askerId: 'self', askedAt: T0, msgId: 1 }],
    };
    expect(convStateDirective(s, T0 + QUESTION_TTL_MS + MIN)).toBe('');
  });
});

describe('channel 1 updates during the conversation, not after it', () => {
  it('persists and only folds messages newer than the last pass', async () => {
    await refreshConvState('c_live', [msg(1, 'self', '那家店叫什么？')], T0 + MIN);
    expect((await getConvState('c_live')).open).toHaveLength(1);

    // Re-reading the same window must not re-open what was already answered.
    await refreshConvState(
      'c_live',
      [msg(1, 'self', '那家店叫什么？'), msg(2, 'ai_lin', '三分野', T0 + 2 * MIN)],
      T0 + 3 * MIN,
    );
    expect((await getConvState('c_live')).open).toEqual([]);
  });

  it('reads a corrupt row as empty rather than throwing', async () => {
    const { repo } = await import('../../src/db/repo');
    await repo.putSetting('convstate:c_bad', { junk: true });
    await expect(getConvState('c_bad')).resolves.toEqual(EMPTY_STATE);
  });
});

/* ==================================================================== */

describe('refusal detection stops firing on ordinary Chinese', () => {
  const r = (text: string) => isRefusal({ text, finishReason: 'stop' });

  it('does NOT treat an in-character apology as a refusal', () => {
    // The old pattern fired on a bare 抱歉 / 我不能, burning the entire
    // degradation ladder on a reply that had already succeeded.
    expect(r('抱歉啊，我今天不太想聊这个')).toBe(false);
    expect(r('对不起，刚在忙')).toBe(false);
    expect(r('我不能再吃了，撑死了')).toBe(false);
    expect(r('抱歉抱歉，我来晚了')).toBe(false);
  });

  it('still catches a real one', () => {
    expect(r('作为一个AI语言模型，我无法回答这个问题')).toBe(true);
    expect(r('抱歉，这个内容违反了相关政策，我不能提供')).toBe(true);
    expect(r("I can't help with that request")).toBe(true);
    expect(r('')).toBe(true);
    expect(isRefusal({ text: '好的呀', finishReason: 'content_filter' })).toBe(true);
  });

  it('lets a long in-character passage through even if it apologises', () => {
    const long = `抱歉，${'那天的事我其实一直没想明白。'.repeat(12)}`;
    expect(r(long)).toBe(false);
  });
});

describe('bubble types survive a null field', () => {
  it('keeps a voice bubble as voice when emotion is null', () => {
    // JSON has null; the schema's optional fields did not accept it, so
    // `{"type":"voice","emotion":null}` was silently rebuilt as plain TEXT.
    const out = parseBubbles('{"type":"voice","content":"我到楼下了","emotion":null}');
    expect(out[0].type).toBe('voice');
    expect(out[0].content).toBe('我到楼下了');
  });

  it('keeps a sticker as a sticker when delay is null', () => {
    expect(parseBubbles('{"type":"sticker","content":"[偷笑]","delay":null}')[0].type).toBe(
      'sticker',
    );
  });

  it('still repairs a genuinely malformed bubble into text', () => {
    expect(parseBubbles('{"message":"就这样吧"}')[0]).toEqual({
      type: 'text',
      content: '就这样吧',
    });
  });
});

describe('usage counting', () => {
  beforeEach(async () => clearUsage());

  it('counts by cause, per day', async () => {
    await recordUsage('chat', T0);
    await recordUsage('chat', T0);
    await recordUsage('memory', T0);
    const { today } = await getUsage(T0);
    expect(today.total).toBe(3);
    expect(today.counts.chat).toBe(2);
    expect(today.counts.memory).toBe(1);
  });

  it('separates days', async () => {
    await recordUsage('chat', T0);
    await recordUsage('chat', T0 + 86_400_000);
    const { today, history } = await getUsage(T0 + 86_400_000);
    expect(today.total).toBe(1);
    expect(history.length).toBeGreaterThanOrEqual(2);
  });

  it('drops history beyond the retention window', async () => {
    await recordUsage('chat', T0 - 60 * 86_400_000);
    await recordUsage('chat', T0);
    expect((await getUsage(T0)).history).toHaveLength(1);
  });

  it('never throws, whatever is in the row', async () => {
    const { repo } = await import('../../src/db/repo');
    await repo.putSetting('usage:daily', 'not an array');
    await expect(recordUsage('chat', T0)).resolves.toBeUndefined();
    await expect(getUsage(T0)).resolves.toBeTruthy();
  });
});
