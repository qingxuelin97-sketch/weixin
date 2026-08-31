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
 *
 * Tokens (M-J3) are a strictly BEST-EFFORT annex to that stance, not a reversal
 * of it: when a response happens to carry a `usage.total_tokens`, the number is
 * added to the day's token tally; when it doesn't, nothing is estimated and
 * nothing is shown. Calls remain the primary metric — the token line exists so
 * a spike's SIZE is visible, never to be mistaken for a bill.
 */
import { repo } from '../db/repo';

/**
 * What made the call. Matches the router's `role` plus the background kinds,
 * plus the three non-chat modalities (M-J3) — TTS/ASR/image are paid calls
 * exactly like a chat turn, and until they were counted here the usage page
 * was silently lying about什么在花钱.
 */
export type UsageKind =
  | 'chat'
  | 'group'
  | 'director'
  | 'memory'
  | 'moments'
  | 'agent_dm'
  | 'story'
  | 'tts'
  | 'asr'
  | 'image'
  | 'other';

export interface DayUsage {
  day: number;
  counts: Record<string, number>;
  total: number;
  /**
   * Best-effort token tallies per kind (M-J3). Absent on rows written before
   * the field existed and on days where no provider reported usage — readers
   * must treat missing as "unknown", never as zero spend.
   */
  tokens?: Record<string, number>;
}

const KEY = 'usage:daily';
/** Two weeks is enough to answer "is this normal" without unbounded growth. */
const KEEP_DAYS = 14;

function dayOf(now: number): number {
  return Math.floor(now / 86_400_000);
}

/**
 * Count a call (and, best-effort, its tokens).
 *
 * `n = 0` is a legal and meaningful shape (M-J3): the router counts the CALL
 * up front — so failures are billed honestly — and reports tokens in a second,
 * zero-count record once the response has actually arrived with a usage field.
 */
export async function recordUsage(kind: UsageKind, now: number, n = 1, tokens = 0): Promise<void> {
  try {
    if (n === 0 && tokens <= 0) return; // nothing to record
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
    if (tokens > 0 && Number.isFinite(tokens)) {
      today.tokens ??= {};
      today.tokens[kind] = (today.tokens[kind] ?? 0) + Math.round(tokens);
    }
    await repo.putSetting(KEY, list);
  } catch {
    /* accounting must never break a turn */
  }
}

/** Total reported tokens of one day, or 0 when nothing was reported. */
export function dayTokens(u: DayUsage): number {
  return Object.values(u.tokens ?? {}).reduce((a, b) => a + b, 0);
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
  tts: '语音合成',
  asr: '语音识别',
  image: '图片生成',
  other: '其他',
};
