import { describe, it, expect } from 'vitest';
import {
  readTopic,
  advanceTopic,
  coolingTopics,
  topicStale,
  silenceMinutes,
  pacingDirective,
  socialDirective,
  TOPIC_MAX_TURNS,
  TOPIC_COOLDOWN_MS,
} from '../../src/ai/group-topic';

/**
 * Group pacing (M-H1).
 *
 * The director has had a topic line since M-D, but it was ONE overwritten
 * string: the room could say what it was discussing and nothing else. The two
 * behaviours that string could not represent are the two that make a group
 * chat read as real — getting bored of a subject, and not circling back to one
 * it just finished.
 */

const T0 = new Date(2026, 4, 10, 20, 0).getTime();
const MIN = 60_000;

describe('reading whatever is in storage', () => {
  it('accepts the bare string rows written before this was a record', () => {
    // Migrating them would be pointless: the only thing a bare string lacks is
    // an age nobody was tracking anyway, so it becomes a fresh topic.
    const s = readTopic('在聊周末去哪吃', T0);
    expect(s?.text).toBe('在聊周末去哪吃');
    expect(s?.turns).toBe(1);
  });

  it('ignores junk instead of inventing a topic', () => {
    expect(readTopic(undefined, T0)).toBeUndefined();
    expect(readTopic('   ', T0)).toBeUndefined();
    expect(readTopic({ text: '' }, T0)).toBeUndefined();
    expect(readTopic({ text: '吃饭', past: 'nope' }, T0)?.past).toEqual([]);
  });
});

describe('staying on a subject vs moving off it', () => {
  it('counts rounds when the topic holds', () => {
    let s = advanceTopic(undefined, '周末去哪吃', T0);
    s = advanceTopic(s, '周末去哪吃', T0 + 2 * MIN);
    s = advanceTopic(s, '周末去哪吃饭', T0 + 4 * MIN); // reworded, same subject
    expect(s.turns).toBe(3);
    expect(s.past).toHaveLength(0);
  });

  it('files the old subject away when it actually changes', () => {
    const s = advanceTopic(advanceTopic(undefined, '周末去哪吃', T0), '阿哲换工作了', T0 + 5 * MIN);
    expect(s.turns).toBe(1);
    expect(s.past[0].text).toBe('周末去哪吃');
  });

  it('goes stale by rounds or by minutes, whichever comes first', () => {
    let s = advanceTopic(undefined, '周末去哪吃', T0);
    expect(topicStale(s, T0)).toBe(false);
    for (let i = 1; i < TOPIC_MAX_TURNS; i++) s = advanceTopic(s, '周末去哪吃', T0 + i * MIN);
    expect(topicStale(s, T0 + TOPIC_MAX_TURNS * MIN)).toBe(true);

    const slow = advanceTopic(undefined, '周末去哪吃', T0);
    expect(topicStale(slow, T0 + 46 * MIN)).toBe(true);
  });

  it('keeps a finished subject off the table for a while, then lets it back', () => {
    const s = advanceTopic(advanceTopic(undefined, '周末去哪吃', T0), '阿哲换工作了', T0 + MIN);
    expect(coolingTopics(s, T0 + 10 * MIN)).toContain('周末去哪吃');
    // A room that keeps rediscovering the same subject every twenty minutes is
    // the loudest tell a simulation has — but forever is wrong too.
    expect(coolingTopics(s, T0 + TOPIC_COOLDOWN_MS + 10 * MIN)).toHaveLength(0);
  });

  it('remembers only the last few, so the block cannot grow without bound', () => {
    let s = advanceTopic(undefined, 't0', T0);
    for (let i = 1; i <= 8; i++) s = advanceTopic(s, `t${i}`, T0 + i * MIN);
    expect(s.past.length).toBeLessThanOrEqual(4);
    expect(s.past[0].text).toBe('t7'); // newest first
  });
});

describe('the pacing block the director actually reads', () => {
  it('says nothing when there is nothing to say', () => {
    // Silence is the default: a paragraph that says "carry on as you were"
    // costs tokens and dilutes everything around it.
    expect(pacingDirective(undefined, T0, T0 - MIN)).toBe('');
  });

  it('reports the subject with its age', () => {
    const s = advanceTopic(advanceTopic(undefined, '周末去哪吃', T0 - 10 * MIN), '周末去哪吃', T0);
    const out = pacingDirective(s, T0, T0 - MIN);
    expect(out).toContain('周末去哪吃');
    expect(out).toContain('2 轮');
    expect(out).toContain('10 分钟');
  });

  it('gives permission to move on, rather than ordering it', () => {
    let s = advanceTopic(undefined, '周末去哪吃', T0);
    for (let i = 1; i < TOPIC_MAX_TURNS; i++) s = advanceTopic(s, '周末去哪吃', T0 + i * MIN);
    const out = pacingDirective(s, T0 + TOPIC_MAX_TURNS * MIN, T0);
    // A room that changes the subject on a fixed schedule is as mechanical as
    // one that never does.
    expect(out).toContain('可以');
    expect(out).not.toContain('必须');
  });

  it('notices a dead room and says to start something, not to continue', () => {
    const out = pacingDirective(undefined, T0, T0 - 40 * MIN);
    expect(out).toContain('40 分钟');
    expect(out).toContain('新话头');
  });

  it('reads a long silence in hours', () => {
    expect(pacingDirective(undefined, T0, T0 - 5 * 3_600_000)).toContain('5 小时');
  });

  it('says nothing about a room that was just talking', () => {
    expect(pacingDirective(undefined, T0, T0 - 3 * MIN)).toBe('');
    expect(silenceMinutes(undefined, T0)).toBe(0);
  });
});

describe('who gets on with whom', () => {
  it('reports friction as well as closeness', () => {
    // Until M-H1 only closeness was reported, so every 拉踩 the director cast
    // was arbitrary — nothing told it who actually has history with whom.
    const line = socialDirective([['小雨', '阿哲']], [['阿哲', '老王']]);
    expect(line).toContain('小雨和阿哲走得近');
    expect(line).toContain('阿哲对老王有点意见');
  });

  it('stays empty when the room is unremarkable', () => {
    expect(socialDirective([], [])).toBe('');
  });

  it('caps itself — this rides in every director call', () => {
    const many: Array<[string, string]> = Array.from({ length: 9 }, (_, i) => [`a${i}`, `b${i}`]);
    expect(socialDirective(many, many).split('；')).toHaveLength(4);
  });
});
