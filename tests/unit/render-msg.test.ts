import { describe, it, expect } from 'vitest';
import {
  renderMessageBody,
  renderTranscript,
  renderTurns,
  humanDuration,
} from '../../src/ai/render-msg';
import type { MessageVM } from '../../src/data/types';

/**
 * What the model actually sees (M-E1).
 *
 * Every context builder used to project non-text messages as the literal string
 * `[rp]` / `[transfer]` / `[image]`. The consequence was not subtle: you could
 * send someone ¥52 with the note 「请你喝奶茶」 and she had no way to know either
 * fact. These tests are the definition of "she can see it".
 */

const T0 = 1_754_900_000_000;

function msg(over: Partial<MessageVM> & Pick<MessageVM, 'type'>): MessageVM {
  return {
    id: 1,
    convId: 'c',
    senderId: 'self',
    status: 'sent',
    createdAt: T0,
    ...over,
  } as MessageVM;
}

describe('money is visible', () => {
  it('projects a transfer with its exact amount and note', () => {
    const body = renderMessageBody(
      msg({ type: 'transfer', content: '', meta: { amountFen: 5200, note: '请你喝奶茶' } }),
    );
    expect(body).toContain('52.00');
    expect(body).toContain('请你喝奶茶');
    // The old projection — the entire bug in one string.
    expect(body).not.toBe('[transfer]');
  });

  it('formats fen exactly, never as a rounded float', () => {
    expect(renderMessageBody(msg({ type: 'transfer', meta: { amountFen: 1 } }))).toContain('0.01');
    expect(renderMessageBody(msg({ type: 'transfer', meta: { amountFen: 100 } }))).toContain('1.00');
    expect(renderMessageBody(msg({ type: 'transfer', meta: { amountFen: 123456 } }))).toContain(
      '1234.56',
    );
  });

  it('marks an accepted transfer as taken', () => {
    const body = renderMessageBody(
      msg({ type: 'transfer', meta: { amountFen: 800, status: 'accepted' } }),
    );
    expect(body).toContain('已收下');
  });

  it('shows a red packet greeting but NOT its amount', () => {
    const body = renderMessageBody(
      msg({ type: 'rp', meta: { rpId: 'rp1', greeting: '恭喜发财', opened: false } }),
    );
    expect(body).toContain('恭喜发财');
    expect(body).toContain('红包');
    // In WeChat the recipient cannot see the amount before opening; leaking it
    // would let her thank you for a sum she has no way of knowing.
    expect(body).not.toMatch(/\d+\.\d\d/);
  });

  it('survives a transfer row with no meta at all', () => {
    expect(() => renderMessageBody(msg({ type: 'transfer' }))).not.toThrow();
    expect(renderMessageBody(msg({ type: 'transfer' }))).toContain('¥?');
  });
});

describe('media and voice', () => {
  it('never leaks the internal media handle into the prompt', () => {
    const body = renderMessageBody(msg({ type: 'image', content: 'idb:media_abc123' }));
    expect(body).not.toContain('idb:');
    expect(body).not.toContain('media_abc123');
    expect(body).toContain('图片');
  });

  it('uses image tags when the row has them', () => {
    const body = renderMessageBody(
      msg({ type: 'image', content: 'idb:m1', meta: { tags: ['猫', '窗台'] } }),
    );
    expect(body).toContain('猫');
    expect(body).toContain('窗台');
  });

  it('states a voice note’s length, and its text only when asked', () => {
    const v = msg({ type: 'voice', content: '我到楼下了', meta: { durationMs: 4200 } });
    expect(renderMessageBody(v, { includeVoiceText: true })).toContain('我到楼下了');
    // Groups quote 20 messages — the transcripts would swamp the window.
    expect(renderMessageBody(v)).not.toContain('我到楼下了');
    expect(renderMessageBody(v)).toContain('4秒');
  });

  it('renders call records with duration, and unanswered ones as unanswered', () => {
    expect(
      renderMessageBody(msg({ type: 'call', meta: { direction: 'out', durationMs: 192_000 } })),
    ).toContain('3分12秒');
    expect(renderMessageBody(msg({ type: 'call', meta: { direction: 'in' } }))).toContain('未接通');
  });

  it('humanDuration reads like speech', () => {
    expect(humanDuration(1000)).toBe('1秒');
    expect(humanDuration(59_400)).toBe('59秒');
    expect(humanDuration(60_000)).toBe('1分0秒');
    expect(humanDuration(0)).toBe('1秒'); // never "0秒"
  });
});

describe('recalled messages', () => {
  it('read as recalled, never as their original text', () => {
    // The single most obvious tell: an AI referring to something taken back.
    const body = renderMessageBody(
      msg({ type: 'text', content: '我其实一直喜欢你', isRecalled: true }),
    );
    expect(body).not.toContain('喜欢');
    expect(body).toBe('[撤回了一条消息]');
  });

  it('applies to non-text types too', () => {
    expect(
      renderMessageBody(msg({ type: 'transfer', meta: { amountFen: 99900 }, isRecalled: true })),
    ).not.toContain('999');
  });
});

describe('transcripts', () => {
  const convo: MessageVM[] = [
    msg({ id: 1, type: 'text', senderId: 'self', content: '在吗' }),
    msg({ id: 2, type: 'text', senderId: 'ai_lin', content: '在的' }),
    msg({ id: 3, type: 'transfer', senderId: 'self', meta: { amountFen: 5200, note: '奶茶' } }),
  ];

  it('labels a single chat by role and can cite ids', () => {
    const out = renderTranscript(convo, { withIds: true });
    expect(out).toContain('[1] 用户: 在吗');
    expect(out).toContain('[2] TA: 在的');
    expect(out).toContain('52.00');
  });

  it('labels a group by display name', () => {
    const out = renderTranscript(convo, { nameOf: (id) => (id === 'self' ? '我' : '小雨') });
    expect(out).toContain('我: 在吗');
    expect(out).toContain('小雨: 在的');
  });

  it('truncates per message when a budget is set', () => {
    const long = msg({ id: 9, type: 'text', content: '啊'.repeat(300) });
    const out = renderTranscript([long], { maxChars: 20 });
    expect(out.length).toBeLessThan(60);
    expect(out).toContain('…');
  });

  it('drops messages that project to nothing', () => {
    const out = renderTranscript([msg({ id: 1, type: 'system', content: '' }), convo[0]]);
    expect(out.split('\n')).toHaveLength(1);
  });
});

describe('renderTurns (the single-chat engine shape)', () => {
  it('maps sender to role and keeps every non-empty body', () => {
    const turns = renderTurns([
      msg({ id: 1, senderId: 'self', type: 'text', content: '给你转个账' }),
      msg({ id: 2, senderId: 'self', type: 'transfer', meta: { amountFen: 5200, note: '奶茶' } }),
      msg({ id: 3, senderId: 'ai_lin', type: 'text', content: '谢谢！' }),
    ]);
    expect(turns.map((t) => t.role)).toEqual(['user', 'user', 'assistant']);
    // "刚才给你转了多少" is now answerable from the context alone.
    expect(turns[1].content).toContain('52.00');
  });

  it('skips empty projections rather than emitting blank turns', () => {
    expect(renderTurns([msg({ id: 1, type: 'system', content: '' })])).toEqual([]);
  });
});
