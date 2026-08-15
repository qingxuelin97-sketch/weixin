/**
 * Joint plans (M-I3): two AIs agree on something in their hidden DM, and a
 * day or two later it VISIBLY HAPPENS — paired moments about the same outing,
 * written in two different voices.
 *
 * This is the cheapest possible "the world moves without you" signal: the
 * user sees 小雨 post 「和老王看了那部片，他睡着了」 and 老王 post 「不是我
 * 的错，片是真的闷」, and the two posts agreeing with each other is what makes
 * the friend group feel inhabited rather than simulated.
 *
 * Planning is pure and seeded (constitution rule #4): whether a DM hatches a
 * plan, which activity, and when it materializes are all functions of the DM's
 * identity — offline backfill replays them deterministically.
 *
 * COST GATE: materialization is exactly ONE LLM call producing BOTH texts
 * (`JOINT_PLAN_LLM_CALLS`). Never one call per participant — that shape is
 * how a social feature turns into a bill.
 */
import { seededRng } from '../lib/money';

export const JOINT_ACTIVITIES = {
  meal: '一起吃了顿饭',
  movie: '一起看了场电影',
  outing: '一起出去逛了大半天',
  shopping: '一起逛街买了点东西',
} as const;

export type JointKind = keyof typeof JOINT_ACTIVITIES;

/** Per completed DM session. Low on purpose: plans should feel occasional. */
export const JOINT_PLAN_CHANCE = 0.18;
/** The cost gate: one call writes both sides. Unit-locked. */
export const JOINT_PLAN_LLM_CALLS = 1;

/** Materialization window after the DM that hatched the plan. */
const MIN_DELAY_H = 20;
const MAX_DELAY_H = 44;

/**
 * Did this DM session hatch a plan, and if so what and when?
 * Pure function of (dmId, endedAt) — no clock, no dice.
 */
export function maybeJointPlan(
  dmId: string,
  endedAt: number,
): { kind: JointKind; fireAt: number } | null {
  const rng = seededRng(`joint:${dmId}:${endedAt}`);
  if (rng() >= JOINT_PLAN_CHANCE) return null;
  const kinds = Object.keys(JOINT_ACTIVITIES) as JointKind[];
  const kind = kinds[Math.floor(rng() * kinds.length)];
  const delayH = MIN_DELAY_H + rng() * (MAX_DELAY_H - MIN_DELAY_H);
  return { kind, fireAt: Math.round(endedAt + delayH * 3_600_000) };
}

/** B's post trails A's by a believable gap, seeded off the same identity. */
export function jointStaggerMs(dmId: string, fireAt: number): number {
  const rng = seededRng(`jointstagger:${dmId}:${fireAt}`);
  return Math.round((3 + rng() * 25) * 60_000);
}

/**
 * The one materialization call: both moments, two voices, one JSON.
 * Persona texture rides in from the caller (speech style + catchphrases),
 * because two posts in the same register would defeat the whole point.
 */
export function jointMomentsSystem(
  kind: JointKind,
  a: { name: string; style?: string },
  b: { name: string; style?: string },
): string {
  return `${a.name} 和 ${b.name} 刚刚${JOINT_ACTIVITIES[kind]}。给两个人各写一条发朋友圈的文案。
只输出 JSON：{"a": "${a.name} 发的", "b": "${b.name} 发的"}

要求：
- 两条要互相咬合（说的是同一件事、同一个细节），但角度和语气完全不同。
- ${a.name} 的语气：${a.style || '按 TA 自己的性子来'}；${b.name} 的语气：${b.style || '按 TA 自己的性子来'}。
- 每条 ≤50 字，口语，可以带一点互相吐槽。不要 hashtag、不要表情堆砌。`;
}

/** Validate the one call's output. Null = drop silently (a quiet day beats an error). */
export function parseJointMoments(raw: unknown): { a: string; b: string } | null {
  if (raw === null || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const a = typeof o.a === 'string' ? o.a.trim().slice(0, 80) : '';
  const b = typeof o.b === 'string' ? o.b.trim().slice(0, 80) : '';
  return a && b ? { a, b } : null;
}
