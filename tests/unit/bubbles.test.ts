import { describe, it, expect } from 'vitest';
import { parseBubbles, typingDelay } from '../../src/llm/bubbles';

describe('parseBubbles', () => {
  it('parses NDJSON bubbles', () => {
    const out = parseBubbles('{"type":"text","content":"在吗"}\n{"type":"text","content":"吃了没"}');
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ type: 'text', content: '在吗' });
  });

  it('parses a JSON array', () => {
    const out = parseBubbles('[{"type":"text","content":"a"},{"type":"sticker","content":"笑"}]');
    expect(out).toHaveLength(2);
    expect(out[1].type).toBe('sticker');
  });

  it('strips code fences', () => {
    const out = parseBubbles('```json\n{"type":"text","content":"hi"}\n```');
    expect(out).toEqual([{ type: 'text', content: 'hi' }]);
  });

  it('repairs {message}/{text} shapes into text bubbles', () => {
    const out = parseBubbles('{"message":"救场"}');
    expect(out).toEqual([{ type: 'text', content: '救场' }]);
  });

  it('falls back to plain text when not JSON', () => {
    const out = parseBubbles('就是一句普通的话');
    expect(out).toEqual([{ type: 'text', content: '就是一句普通的话' }]);
  });

  it('splits plain text on blank lines', () => {
    const out = parseBubbles('第一句\n\n第二句');
    expect(out).toHaveLength(2);
  });

  it('caps at 8 bubbles', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `{"type":"text","content":"${i}"}`).join('\n');
    expect(parseBubbles(lines).length).toBeLessThanOrEqual(8);
  });

  it('clamps an out-of-range delay', () => {
    const out = parseBubbles('{"type":"text","content":"x","delay":999999}');
    expect(out[0].delay).toBe(8000);
  });

  it('returns empty for empty input', () => {
    expect(parseBubbles('')).toEqual([]);
    expect(parseBubbles('   ')).toEqual([]);
  });
});

describe('typingDelay', () => {
  it('honors an explicit delay', () => {
    expect(typingDelay({ type: 'text', content: 'x', delay: 1234 })).toBe(1234);
  });
  it('scales with length and is deterministic', () => {
    const short = typingDelay({ type: 'text', content: '嗨' }, 300);
    const long = typingDelay({ type: 'text', content: '这是一段比较长的话需要更久的打字时间' }, 300);
    expect(long).toBeGreaterThan(short);
    expect(typingDelay({ type: 'text', content: '嗨' }, 300)).toBe(short);
  });
});
