/**
 * 在线感 (M-I16)：seeded 抖动与「刚刚活跃」绿点的确定性可重放（铁律 4）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { typingRhythm } from '../../src/lib/typing-rhythm';
import { recentlyActive } from '../../src/ai/presence';
import { makePersona } from '../../src/data/persona-defaults';

describe('typingRhythm — 输入抖动节奏', () => {
  it('同一种子 → 同一节奏（确定性可重放）', () => {
    expect(typingRhythm('c1:42')).toEqual(typingRhythm('c1:42'));
  });

  it('不同种子 → 不同节奏', () => {
    const a = typingRhythm('c1:42');
    const b = typingRhythm('c1:43');
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('恒以「输入中」开头，之后 on/off 交替', () => {
    const beats = typingRhythm('seed');
    expect(beats[0].on).toBe(true);
    for (let i = 0; i < beats.length; i++) expect(beats[i].on).toBe(i % 2 === 0);
  });

  it('时长有界：输入段 1.2–3.5s，停顿段 0.5–1.6s', () => {
    for (const b of typingRhythm('bounds', 20)) {
      if (b.on) {
        expect(b.ms).toBeGreaterThanOrEqual(1200);
        expect(b.ms).toBeLessThanOrEqual(3500);
      } else {
        expect(b.ms).toBeGreaterThanOrEqual(500);
        expect(b.ms).toBeLessThanOrEqual(1600);
      }
    }
  });
});

describe('recentlyActive — 朋友圈「刚刚活跃」绿点', () => {
  // 2026-08-10T12:00 UTC 附近的一个正午时刻（本地小时落在 9–23 窗口内即可）。
  const noon = new Date(2026, 7, 10, 12, 0, 0).getTime();
  const night = new Date(2026, 7, 10, 3, 30, 0).getTime();
  const persona = makePersona({ contactId: 'ai_p', core: 'c' }); // activeHours 默认 [[9,23]]

  it('确定性：同一 (persona, contact, 时刻) 永远同一答案', () => {
    const a = recentlyActive(persona, 'ai_p', noon);
    for (let i = 0; i < 5; i++) expect(recentlyActive(persona, 'ai_p', noon)).toBe(a);
  });

  it('同一半小时桶内不换脸', () => {
    const a = recentlyActive(persona, 'ai_p', noon);
    expect(recentlyActive(persona, 'ai_p', noon + 60_000)).toBe(a);
    expect(recentlyActive(persona, 'ai_p', noon + 10 * 60_000)).toBe(a);
  });

  it('activeHours 之外绝不亮（凌晨 3 点半没有"刚刚活跃"）', () => {
    expect(recentlyActive(persona, 'ai_p', night)).toBe(false);
  });

  it('无 persona / 空窗口 → false，不炸', () => {
    expect(recentlyActive(undefined, 'x', noon)).toBe(false);
    expect(recentlyActive({ activeHours: [] }, 'x', noon)).toBe(false);
  });

  it('低频：活跃时段内跨多个桶的命中率明显低于常亮', () => {
    let hits = 0;
    const buckets = 40;
    for (let i = 0; i < buckets; i++) {
      // 桶间隔 30 分钟，全部固定取 10:00–20:00 内的时刻（活跃窗口内）。
      const day = 10 + Math.floor(i / 20);
      const hour = 10 + Math.floor((i % 20) / 2);
      const minute = (i % 2) * 30;
      const t = new Date(2026, 7, day, hour, minute, 0).getTime();
      if (recentlyActive(persona, 'ai_p', t)) hits++;
    }
    expect(hits).toBeGreaterThan(0); // 会亮
    expect(hits).toBeLessThan(buckets); // 但绝不常亮
  });

  it('纯投影：presence 模块不建计时器、不读挂钟', () => {
    const src = readFileSync(resolve(__dirname, '../../src/ai/presence.ts'), 'utf8');
    expect(src).not.toMatch(/setTimeout|setInterval|requestAnimationFrame/);
    expect(src).not.toMatch(/Date\.now\s*\(/);
    expect(src).not.toMatch(/Math\.random\s*\(/);
  });
});
