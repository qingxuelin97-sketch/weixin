/**
 * 「刚刚活跃」在线感投影（M-I16）。
 *
 * 朋友圈头像旁的低频绿点：她此刻醒着（activeHours）且这半小时的 seeded 骰子
 * 掷中才亮。纯投影——由 persona.activeHours + seededRng 决定，无计时器、无状态、
 * 不落库（铁律 4/5：确定性可重放，也没有第二套时间推进代码）。
 */
import { seededRng } from '../lib/money';
import { isActiveAt } from './heartbeat';
import type { PersonaVM } from '../data/types';

/** 半小时一个桶：绿点最短驻留/间隔粒度，避免每次渲染都换脸。 */
const BUCKET_MS = 30 * 60_000;

/** 命中概率——低频才像真的；常亮就成了状态栏。 */
const ODDS = 0.3;

export function recentlyActive(
  persona: Pick<PersonaVM, 'activeHours'> | undefined,
  contactId: string,
  now: number,
): boolean {
  if (!persona || !Array.isArray(persona.activeHours) || persona.activeHours.length === 0) {
    return false;
  }
  if (!isActiveAt(persona as PersonaVM, now)) return false;
  const bucket = Math.floor(now / BUCKET_MS);
  return seededRng(`presence:${contactId}:${bucket}`)() < ODDS;
}
