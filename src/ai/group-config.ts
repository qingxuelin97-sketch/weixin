/**
 * Per-group behavior knobs (M-I1).
 *
 * Stored as a settings KV row (`groupCfg:<convId>`, following the
 * `topic:<convId>` precedent) rather than as conversation columns: zero
 * migration risk, and the values are only ever read at generation time — the
 * director's prefilter, the group engine's prompt, and the offline planner.
 *
 * Every knob is bounded and has a neutral default, so an absent row means
 * "behave exactly as before this module existed".
 */
import { repo } from '../db/repo';

export interface GroupCfg {
  /** 0 冷清 · 1 偏静 · 2 正常 · 3 热闹 — scales reply probability & offline pacing. */
  activity: 0 | 1 | 2 | 3;
  /** 0 和气 · 1 有来有回 · 2 敢拌嘴 · 3 火药味 — feeds a prompt line, never a jailbreak. */
  spice: 0 | 1 | 2 | 3;
  /** Preferred topics; empty = whatever the room drifts to. */
  topics: string[];
}

export const GROUP_CFG_DEFAULTS: GroupCfg = { activity: 2, spice: 1, topics: [] };

export const groupCfgKey = (convId: string) => `groupCfg:${convId}`;

const clampLevel = (v: unknown, fallback: 0 | 1 | 2 | 3): 0 | 1 | 2 | 3 => {
  const n = typeof v === 'number' ? Math.round(v) : NaN;
  return n === 0 || n === 1 || n === 2 || n === 3 ? n : fallback;
};

/** Read a group's knobs; absent or corrupt rows fall back to the defaults. */
export async function getGroupCfg(convId: string): Promise<GroupCfg> {
  try {
    const raw = await repo.getSetting<Partial<GroupCfg>>(groupCfgKey(convId));
    if (!raw) return GROUP_CFG_DEFAULTS;
    return {
      activity: clampLevel(raw.activity, GROUP_CFG_DEFAULTS.activity),
      spice: clampLevel(raw.spice, GROUP_CFG_DEFAULTS.spice),
      topics: Array.isArray(raw.topics)
        ? raw.topics.filter((t): t is string => typeof t === 'string' && Boolean(t.trim())).slice(0, 5)
        : [],
    };
  } catch {
    return GROUP_CFG_DEFAULTS;
  }
}

export async function putGroupCfg(convId: string, cfg: GroupCfg): Promise<void> {
  await repo.putSetting(groupCfgKey(convId), {
    activity: clampLevel(cfg.activity, GROUP_CFG_DEFAULTS.activity),
    spice: clampLevel(cfg.spice, GROUP_CFG_DEFAULTS.spice),
    topics: cfg.topics.map((t) => t.trim()).filter(Boolean).slice(0, 5),
  });
}

/**
 * Multiplier applied to "should anyone reply / how much offline chatter".
 * Level 2 is exactly 1.0 so existing groups keep their standing behavior.
 * Level 0 is quiet but NOT dead — a group that never speaks reads as broken.
 */
export function activityMultiplier(cfg: Pick<GroupCfg, 'activity'>): number {
  return [0.3, 0.6, 1, 1.6][cfg.activity] ?? 1;
}

/**
 * What the activity knob means to the director's PREFILTER (M-I1, wired in I18).
 *
 * The knob shipped reading only into the offline planner and the prompt, so a
 * room set to 冷清 was exactly as chatty as 热闹 the moment you were looking at
 * it — the one place the setting is most obviously supposed to show. The
 * prefilter is where "how alive is this room" actually lives: it decides who is
 * still on cooldown, how long one member may hold the floor, and whether a lone
 * candidate bothers to answer.
 *
 * Level 2 reproduces `director.ts`'s own defaults BYTE FOR BYTE (45s / 3 /
 * 0.35), so a group with no `groupCfg` row behaves exactly as it did before
 * this function existed. Everything stays pure and seeded — the roll is still
 * `seededRng`, this only moves the threshold it is compared against.
 */
export interface PrefilterKnobs {
  cooldownMs: number;
  maxStreak: number;
  speakBias: number;
}

const COOLDOWN_MS = [150_000, 75_000, 45_000, 28_000];
const MAX_STREAK = [2, 2, 3, 4];
const SPEAK_BIAS = [0.05, 0.2, 0.35, 0.55];

export function prefilterKnobs(cfg: Pick<GroupCfg, 'activity'>): PrefilterKnobs {
  const i = cfg.activity;
  return {
    cooldownMs: COOLDOWN_MS[i] ?? COOLDOWN_MS[2],
    maxStreak: MAX_STREAK[i] ?? MAX_STREAK[2],
    speakBias: SPEAK_BIAS[i] ?? SPEAK_BIAS[2],
  };
}

/**
 * The prompt line the spice knob turns into. Bounded phrasing on purpose:
 * this shapes banter tone inside the persona's own voice — tier routing and
 * the NSFW boundary layer are entirely untouched by it.
 */
export function spiceLine(cfg: Pick<GroupCfg, 'spice'>): string {
  return [
    '这个群的气氛和和气气，大家说话都很给面子。',
    '', // level 1 = the app's existing default tone; no extra line
    '这个群的人说话不太客气，熟人之间敢开玩笑、敢抬杠。',
    '这个群火药味不轻：拆台、阴阳怪气、翻旧账都是家常便饭，但仍是熟人间的斗嘴，不是仇人。',
  ][cfg.spice] ?? '';
}

/** The topics line for the director/engine prompt; '' when unset. */
export function topicsLine(cfg: Pick<GroupCfg, 'topics'>): string {
  return cfg.topics.length ? `这个群最近爱聊：${cfg.topics.join('、')}。` : '';
}
