/**
 * How much this app is actually spending (M-E6).
 *
 * Every agent upgrade in this milestone adds LLM calls that happen WITHOUT the
 * user pressing anything: heartbeats, memory extraction, group casting, AI↔AI
 * DMs, Moments, story beats. The user's own key pays for all of it, and until
 * now there was no way to see any of it — not a count, not a rate, nothing.
 * Shipping a system that spends someone's money invisibly is not acceptable
 * regardless of how small the amounts are.
 *
 * Deliberately a COUNTER, not a bill. Token accounting per provider would be
 * wrong often enough to be worse than useless (every gateway reports usage
 * differently, and some not at all), and a wrong number about money is worse
 * than an honest count of calls. So: calls per day, split by what caused them.
 */
import { repo } from '../db/repo';

/** What made the call. Matches the router's `role` plus the background kinds. */
export type UsageKind =
  | 'chat'
  | 'group'
  | 'director'
  | 'memory'
  | 'moments'
  | 'agent_dm'
  | 'story'
  | 'other';

export interface DayUsage {
  day: number;
  counts: Record<string, number>;
  total: number;
}

const KEY = 'usage:daily';
/** Two weeks is enough to answer "is this normal" without unbounded growth. */
const KEEP_DAYS = 14;

function dayOf(now: number): number {
  return Math.floor(now / 86_400_000);
}

export async function recordUsage(kind: UsageKind, now: number, n = 1): Promise<void> {
  try {
    const rows = (await repo.getSetting<DayUsage[]>(KEY)) ?? [];
    const day = dayOf(now);
    const list = Array.isArray(rows) ? rows.filter((r) => day - r.day < KEEP_DAYS) : [];
    let today = list.find((r) => r.day === day);
    if (!today) {
      today = { day, counts: {}, total: 0 };
      list.push(today);
    }
    today.counts[kind] = (today.counts[kind] ?? 0) + n;
    today.total += n;
    await repo.putSetting(KEY, list);
  } catch {
    /* accounting must never break a turn */
  }
}

export async function getUsage(now: number): Promise<{ today: DayUsage; history: DayUsage[] }> {
  const day = dayOf(now);
  let rows: DayUsage[] = [];
  try {
    rows = (await repo.getSetting<DayUsage[]>(KEY)) ?? [];
    if (!Array.isArray(rows)) rows = [];
  } catch {
    rows = [];
  }
  const history = rows.filter((r) => day - r.day < KEEP_DAYS).sort((a, b) => b.day - a.day);
  return {
    today: history.find((r) => r.day === day) ?? { day, counts: {}, total: 0 },
    history,
  };
}

export async function clearUsage(): Promise<void> {
  try {
    await repo.putSetting(KEY, []);
  } catch {
    /* ignore */
  }
}

export const KIND_LABELS: Record<UsageKind, string> = {
  chat: '单聊回复',
  group: '群聊发言',
  director: '群聊调度',
  memory: '记忆整理',
  moments: '朋友圈',
  agent_dm: 'AI 之间私聊',
  story: '剧情',
  other: '其他',
};
