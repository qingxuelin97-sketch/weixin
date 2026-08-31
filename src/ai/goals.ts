/**
 * Cross-week goals — what an agent is *working toward*, not just living through
 * (M-I14; see specs/goals-status.md).
 *
 * lifeline.ts gave each agent a texture of weeks: a deadline slipping, a
 * relative calling. What it cannot produce is direction — the sense that this
 * person is going somewhere, that "备考三个月" in March pays off (or collapses)
 * in June, and that she will *tell you about it*. That arc over months is what
 * this module supplies: one long-running goal at a time, with milestones,
 * setbacks, and a real ending — completed or abandoned — followed by a rest
 * before the next one.
 *
 * Same two properties as the lifeline, for the same reasons:
 *
 *  - **Zero LLM.** Goal state is derived by seeded pure functions; it costs one
 *    prompt line per turn and nothing else.
 *  - **Zero storage, fully replayable.** `goalStateAt(contactId, t, epoch)` is
 *    a pure function of its arguments. Offline backfill, the status page and
 *    the live engine all agree forever (constitution rule #4). The ONLY stored
 *    bit is "has she told the user yet", and that bookkeeping lives in the
 *    engine layer — this module never touches the repo.
 *
 * What must never leak: the outcome. `progress` is measured against the
 * *planned* duration, and future milestone texts are not surfaced, so nothing
 * user-visible telegraphs an abandonment before it happens.
 */
import { seededRng } from '../lib/money';

const DAY = 86_400_000;
export const HOUR = 3_600_000;

/* ==================================================================== */
/* Goal templates                                                        */
/* ==================================================================== */

export type GoalDomain = 'study' | 'money' | 'romance' | 'health' | 'career' | 'skill';

export interface GoalTemplate {
  domain: GoalDomain;
  /** 「准备考一个证」 — the goal as she would name it herself. */
  title: string;
  /** Ordered milestones; texts are written as HER voice describing where she is. */
  milestones: string[];
  /** Setback lines drawn between milestones. */
  setbacks: string[];
  /** Typical total days for the whole goal; jittered per cycle. */
  typicalDays: number;
  /** Probability this cycle ends in abandonment instead of completion. */
  abandonRate: number;
}

/**
 * Deliberately life-sized. "成为歌手" reads as fiction; "减掉五公斤" reads as a
 * person. Every title must survive being said out loud in a WeChat bubble.
 */
export const GOAL_TEMPLATES: GoalTemplate[] = [
  {
    domain: 'study',
    title: '准备考一个证',
    milestones: [
      '报了名，教材刚到手',
      '刷完了第一轮网课',
      '开始做真题，错得心态爆炸',
      '模拟卷终于上了及格线',
    ],
    setbacks: ['连着一周没碰书，进度全落下了', '有一章怎么都看不懂，卡住了'],
    typicalDays: 75,
    abandonRate: 0.25,
  },
  {
    domain: 'money',
    title: '攒钱去一趟远的旅行',
    milestones: [
      '开了个专门的攒钱账户',
      '攒到三分之一，开始看攻略',
      '机票比价看了一个星期',
      '钱差不多够了，开始排行程',
    ],
    setbacks: ['这个月超支了，进度倒退一截', '临时要用钱，动了旅行基金'],
    typicalDays: 90,
    abandonRate: 0.2,
  },
  {
    domain: 'romance',
    title: '追一个有点心动的人',
    milestones: [
      '加上微信了，聊得还行',
      '约出来吃了顿饭',
      '开始有一搭没一搭地暧昧',
      '感觉快要说破了',
    ],
    setbacks: ['对方好几天回消息都冷冷的', '听说对方好像还有别的暧昧对象'],
    typicalDays: 60,
    abandonRate: 0.45,
  },
  {
    domain: 'health',
    title: '减掉五公斤',
    milestones: [
      '办了卡，前两周去得很勤',
      '戒了奶茶，嘴馋得要命',
      '掉了两公斤，有点成就感',
      '进入平台期，咬牙坚持着',
    ],
    setbacks: ['聚餐连着几顿，反弹了一公斤', '膝盖不舒服，停练了一阵'],
    typicalDays: 80,
    abandonRate: 0.35,
  },
  {
    domain: 'career',
    title: '换一份工作',
    milestones: [
      '偷偷改好了简历',
      '投了一圈，约到两个面试',
      '面到终面了，心里没底',
      '在谈 offer，纠结要不要跳',
    ],
    setbacks: ['最心仪的那家把我挂了', '现公司突然画饼挽留，动摇了'],
    typicalDays: 70,
    abandonRate: 0.3,
  },
  {
    domain: 'skill',
    title: '学会几道拿手菜',
    milestones: [
      '置办了一套像样的厨具',
      '第一道菜勉强能入口',
      '朋友来家里吃，居然没翻车',
      '已经有三道稳定发挥的拿手菜',
    ],
    setbacks: ['差点把厨房烧了，心有余悸', '连着加班，厨具都落灰了'],
    typicalDays: 50,
    abandonRate: 0.15,
  },
];

/* ==================================================================== */
/* Generated template sets (M-J1)                                        */
/* ==================================================================== */

export const GOAL_DOMAINS: readonly GoalDomain[] = [
  'study',
  'money',
  'romance',
  'health',
  'career',
  'skill',
];

/** Bounds a generated template set must fit. Loosening these is a red test. */
export const GOAL_TEMPLATE_BOUNDS = {
  templates: [3, 8],
  titleChars: [2, 24],
  milestones: [3, 5],
  milestoneChars: [2, 40],
  setbacks: [1, 4],
  setbackChars: [2, 40],
  typicalDays: [20, 180],
  abandonRate: [0, 0.6],
} as const;

const inRange = (n: unknown, [lo, hi]: readonly [number, number]): n is number =>
  typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi;

const cleanLines = (
  v: unknown,
  [minN, maxN]: readonly [number, number],
  [minC, maxC]: readonly [number, number],
): string[] | null => {
  if (!Array.isArray(v)) return null;
  const lines = v
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.trim())
    .filter((s) => s.length >= minC)
    .map((s) => s.slice(0, maxC));
  return lines.length >= minN ? lines.slice(0, maxN) : null;
};

/**
 * 值域校验 for a persona-generated template set (M-J1). Strict on purpose: a
 * template outside these bounds produces a life that reads wrong for months
 * (a 3-day goal, a 100% abandon rate), and by then nobody remembers why.
 * Returns null when the whole set is unusable — the caller falls back to
 * `GOAL_TEMPLATES`, because 不许空目标.
 */
export function sanitizeGoalTemplates(raw: unknown): GoalTemplate[] | null {
  if (!Array.isArray(raw)) return null;
  const B = GOAL_TEMPLATE_BOUNDS;
  const out: GoalTemplate[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const t = item as Record<string, unknown>;
    const title = typeof t.title === 'string' ? t.title.trim() : '';
    if (title.length < B.titleChars[0]) continue;
    const domain = GOAL_DOMAINS.includes(t.domain as GoalDomain) ? (t.domain as GoalDomain) : null;
    if (!domain) continue;
    const milestones = cleanLines(t.milestones, B.milestones, B.milestoneChars);
    const setbacks = cleanLines(t.setbacks, B.setbacks, B.setbackChars);
    if (!milestones || !setbacks) continue;
    if (!inRange(t.typicalDays, B.typicalDays)) continue;
    if (!inRange(t.abandonRate, B.abandonRate)) continue;
    out.push({
      domain,
      title: title.slice(0, B.titleChars[1]),
      milestones,
      setbacks,
      typicalDays: Math.round(t.typicalDays as number),
      abandonRate: t.abandonRate as number,
    });
    if (out.length >= B.templates[1]) break;
  }
  return out.length >= B.templates[0] ? out : null;
}

/* ==================================================================== */
/* User overrides (M-J1)                                                 */
/* ==================================================================== */

/**
 * The user's hand on the wheel: rename the current goal, or abandon it now.
 * Stored per contact (goal-service.ts); applied HERE as a pure transform so the
 * seeded timeline stays the single source of "what would have happened" and
 * the override is a thin, inspectable layer on top.
 */
export interface GoalOverrides {
  /** cycle → replacement title. */
  titles?: Record<number, string>;
  /** cycle → the moment the user abandoned it (epoch ms). */
  abandoned?: Record<number, number>;
}

export function applyGoalOverrides(
  state: GoalState,
  ovr: GoalOverrides | undefined,
  now: number,
): GoalState {
  if (!ovr) return state;
  let out = state;
  const title = ovr.titles?.[state.cycle]?.trim();
  if (title) out = { ...out, title: title.slice(0, GOAL_TEMPLATE_BOUNDS.titleChars[1]) };
  const droppedAt = ovr.abandoned?.[state.cycle];
  if (droppedAt != null && droppedAt <= now && out.status === 'active') {
    out = {
      ...out,
      status: 'abandoned',
      endedAt: droppedAt,
      milestones: out.milestones.map((m) =>
        m.at <= droppedAt ? m : { ...m, reached: false, text: '' },
      ),
    };
    if (out.recentSetback && out.recentSetback.at > droppedAt) {
      const { recentSetback: _dropped, ...rest } = out;
      out = rest;
    }
  }
  return out;
}

/* ==================================================================== */
/* Epoch                                                                 */
/* ==================================================================== */

/**
 * When this agent's simulated life "started". Same formula the engine has used
 * for the lifeline since M-E3 (seed `epoch:<id>:<peerId>`, and for a single
 * chat the peer IS the agent) — exported here so goals, lifeline and the status
 * page all anchor to the same day. Changing this constant shifts every agent's
 * entire history; don't.
 */
export function agentEpoch(contactId: string, peerId: string = contactId): number {
  const seeded = seededRng(`epoch:${contactId}:${peerId}`)();
  // Anchored to a fixed date, offset by up to 60 days — deterministic forever,
  // and never dependent on when the app happened to be installed.
  return 1_735_689_600_000 + Math.floor(seeded * 60 * DAY);
}

/* ==================================================================== */
/* Cycle layout (internal)                                               */
/* ==================================================================== */

interface CycleLayout {
  cycle: number;
  template: GoalTemplate;
  /** Active phase start (absolute ms). */
  startAt: number;
  /** Planned full duration — progress denominator, outcome-blind. */
  plannedMs: number;
  /** Actual terminal moment: completion at plannedMs, abandonment earlier. */
  endAt: number;
  outcome: 'completed' | 'abandoned';
  /** Planned milestone times (absolute ms), full template length. */
  milestoneAts: number[];
  setbacks: Array<{ at: number; text: string }>;
  /** Rest gap after endAt before the next cycle starts. */
  restMs: number;
  /** startAt + everything → next cycle's startAt. */
  spanMs: number;
}

/**
 * Lay out one goal cycle. Pure and seeded per (contactId, cycle); the walk in
 * `cycleAt` strings these end to end from the epoch.
 *
 * `templates` defaults to the built-in six; per-persona generated sets (M-J1,
 * `goal-service.ts`) ride in through the same parameter, so the walk stays a
 * pure function of its arguments — same inputs, same life, forever.
 */
function layoutCycle(
  contactId: string,
  cycle: number,
  startAt: number,
  prevIndex: number,
  templates: readonly GoalTemplate[] = GOAL_TEMPLATES,
): CycleLayout {
  const rng = seededRng(`goal:${contactId}:${cycle}`);
  // Never the same goal twice running — repeating "减肥" back to back reads as
  // a broken record rather than a life.
  const pool = templates.length > 1 ? templates.filter((_, i) => i !== prevIndex) : [...templates];
  const template = pool[Math.floor(rng() * pool.length)];

  const plannedMs = Math.round(template.typicalDays * (0.7 + 0.6 * rng()) * DAY);
  const abandoned = rng() < template.abandonRate;
  // An abandonment happens mid-arc (45–80% in), never on day one — nobody
  // gives up on something they started yesterday, they just don't mention it.
  const endAt = abandoned ? startAt + Math.round(plannedMs * (0.45 + 0.35 * rng())) : startAt + plannedMs;

  // Milestones spread across the planned duration, each nudged ±8%.
  const n = template.milestones.length;
  const milestoneAts = template.milestones.map((_, i) => {
    const frac = (i + 1) / (n + 1) + (rng() - 0.5) * 0.16;
    return startAt + Math.round(plannedMs * Math.min(0.95, Math.max(0.05, frac)));
  });
  milestoneAts.sort((a, b) => a - b);

  // Setbacks land between milestones, ~30% per gap, drawn from the template.
  const setbacks: Array<{ at: number; text: string }> = [];
  for (let i = 0; i < milestoneAts.length - 1; i++) {
    if (rng() >= 0.3) continue;
    const lo = milestoneAts[i];
    const hi = milestoneAts[i + 1];
    const at = lo + Math.round((0.3 + 0.4 * rng()) * (hi - lo));
    const text = template.setbacks[Math.floor(rng() * template.setbacks.length)];
    setbacks.push({ at, text });
  }

  const restMs = Math.round((7 + rng() * 14) * DAY);
  return {
    cycle,
    template,
    startAt,
    plannedMs,
    endAt,
    outcome: abandoned ? 'abandoned' : 'completed',
    milestoneAts,
    setbacks,
    restMs,
    spanMs: endAt - startAt + restMs,
  };
}

/**
 * The cycle whose window [startAt, startAt+spanMs) contains `t`. Bounded by
 * construction: a cycle spans at least ~30 days, so even a decade of elapsed
 * time resolves in ~120 iterations; hard-capped at 800 for safety.
 */
function cycleAt(
  contactId: string,
  t: number,
  epoch: number,
  templates: readonly GoalTemplate[] = GOAL_TEMPLATES,
): CycleLayout {
  let cursor = epoch;
  let prevIndex = -1;
  for (let cycle = 0; ; cycle++) {
    const layout = layoutCycle(contactId, cycle, cursor, prevIndex, templates);
    if (t < cursor + layout.spanMs || cycle >= 800) return layout;
    cursor += layout.spanMs;
    prevIndex = templates.indexOf(layout.template);
  }
}

/* ==================================================================== */
/* Goal state                                                            */
/* ==================================================================== */

export interface GoalMilestoneView {
  /** Milestone text — only exposed once reached;未来的是剧透. */
  text: string;
  at: number;
  reached: boolean;
}

export interface GoalState {
  contactId: string;
  cycle: number;
  domain: GoalDomain;
  title: string;
  /** active = still at it; completed/abandoned = in the rest window after. */
  status: 'active' | 'completed' | 'abandoned';
  /** Index of the last milestone reached; -1 before the first. */
  milestoneIndex: number;
  /** Where she is right now, in her own words. */
  stage: string;
  /** 0..1 against the PLANNED duration — outcome-blind on purpose. */
  progress: number;
  startedAt: number;
  /** Set once the cycle has ended (t >= endAt). */
  endedAt?: number;
  /** The latest setback within the last 10 days, if any. */
  recentSetback?: { text: string; at: number };
  /** Full milestone list for the status page; unreached texts are hidden. */
  milestones: GoalMilestoneView[];
}

/**
 * What this agent's goal looks like at `t`. Pure: same inputs, same output,
 * forever. During the rest window the previous cycle's outcome stays visible
 * (that is how "她上周刚考完" remains true for a while) — a new goal starts
 * only when the rest runs out.
 */
export function goalStateAt(
  contactId: string,
  t: number,
  epoch: number,
  templates: readonly GoalTemplate[] = GOAL_TEMPLATES,
): GoalState {
  const c = cycleAt(contactId, Math.max(t, epoch), epoch, templates);
  const ended = t >= c.endAt;
  const reachedAts = c.milestoneAts.filter((at) => at <= Math.min(t, c.endAt) && at <= c.endAt);
  // An abandoned cycle never reaches milestones planned after its end.
  const reachable = c.milestoneAts.filter((at) => at <= c.endAt).length;
  const milestoneIndex = Math.min(reachedAts.length, reachable) - 1;

  const stage =
    milestoneIndex >= 0 ? c.template.milestones[milestoneIndex] : '刚起头，还在进入状态';

  const rawProgress = c.plannedMs > 0 ? (Math.min(t, c.endAt) - c.startAt) / c.plannedMs : 0;
  const progress =
    ended && c.outcome === 'completed' ? 1 : Math.min(1, Math.max(0, rawProgress));

  const setback = [...c.setbacks]
    .filter((s) => s.at <= t && s.at <= c.endAt && t - s.at < 10 * DAY)
    .sort((a, b) => b.at - a.at)[0];

  return {
    contactId,
    cycle: c.cycle,
    domain: c.template.domain,
    title: c.template.title,
    status: ended ? c.outcome : 'active',
    milestoneIndex,
    stage,
    progress,
    startedAt: c.startAt,
    ...(ended ? { endedAt: c.endAt } : {}),
    ...(setback ? { recentSetback: setback } : {}),
    milestones: c.milestoneAts.map((at, i) => {
      const reached = at <= Math.min(t, c.endAt);
      return { text: reached ? c.template.milestones[i] : '', at, reached };
    }),
  };
}

/* ==================================================================== */
/* Goal events                                                           */
/* ==================================================================== */

export type GoalEventKind = 'milestone' | 'setback' | 'completed' | 'abandoned';

export interface GoalEvent {
  /** Stable per event — the once-ever "already told" ledger keys on this. */
  id: string;
  kind: GoalEventKind;
  at: number;
  /** The goal's title (「攒钱去一趟远的旅行」). */
  title: string;
  /** The event's own line (milestone text / setback text / outcome line). */
  text: string;
  cycle: number;
}

/**
 * Everything that happened to this agent's goals in [t0, t1) — half-open so
 * adjacent windows compose without double-counting (tested). Pure and seeded;
 * this is what drift and the proactive-share channel both consume, so the two
 * can never disagree about what happened.
 */
export function goalEventsBetween(
  contactId: string,
  t0: number,
  t1: number,
  epoch: number,
  templates: readonly GoalTemplate[] = GOAL_TEMPLATES,
): GoalEvent[] {
  if (t1 <= t0) return [];
  const out: GoalEvent[] = [];
  let cursor = epoch;
  let prevIndex = -1;
  for (let cycle = 0; cycle < 800 && cursor < t1; cycle++) {
    const c = layoutCycle(contactId, cycle, cursor, prevIndex, templates);
    const push = (kind: GoalEventKind, at: number, text: string) => {
      if (at >= t0 && at < t1) {
        out.push({ id: `${contactId}:${cycle}:${kind}:${at}`, kind, at, title: c.template.title, text, cycle });
      }
    };
    c.milestoneAts.forEach((at, i) => {
      if (at <= c.endAt) push('milestone', at, c.template.milestones[i]);
    });
    for (const s of c.setbacks) if (s.at <= c.endAt) push('setback', s.at, s.text);
    push(
      c.outcome,
      c.endAt,
      c.outcome === 'completed' ? outcomeLine(c.template) : abandonLine(c.template),
    );
    cursor += c.spanMs;
    prevIndex = templates.indexOf(c.template);
  }
  return out.sort((a, b) => a.at - b.at);
}

function outcomeLine(t: GoalTemplate): string {
  switch (t.domain) {
    case 'study':
      return '考过了，证到手了';
    case 'money':
      return '钱攒够了，行程都排好了';
    case 'romance':
      return '说破了，在一起了';
    case 'health':
      return '五公斤真的减下来了';
    case 'career':
      return 'offer 签了，下个月入职';
    case 'skill':
      return '拿手菜凑齐了，随时能开席';
  }
}

function abandonLine(t: GoalTemplate): string {
  switch (t.domain) {
    case 'study':
      return '想了想还是弃考了，钱就当交学费';
    case 'money':
      return '旅行计划先搁置了，攒的钱挪作他用';
    case 'romance':
      return '算了，不追了，就当认识个朋友';
    case 'health':
      return '减肥这事，先放过自己一阵';
    case 'career':
      return '决定先不跳了，再苟一苟';
    case 'skill':
      return '外卖它不香吗，厨艺计划无限期搁置';
  }
}

/**
 * The most recent completed/abandoned event within `windowMs` of `t`, or null.
 * The proactive-share channel keys off this: a terminal event is the one goal
 * moment worth reaching out about unprompted.
 */
export function latestTerminalEvent(
  contactId: string,
  t: number,
  epoch: number,
  windowMs: number = 48 * HOUR,
  templates: readonly GoalTemplate[] = GOAL_TEMPLATES,
): GoalEvent | null {
  const events = goalEventsBetween(contactId, t - windowMs, t + 1, epoch, templates).filter(
    (e) => (e.kind === 'completed' || e.kind === 'abandoned') && e.at <= t,
  );
  return events.at(-1) ?? null;
}

/* ==================================================================== */
/* Prompt material                                                       */
/* ==================================================================== */

/** How long after the ending the goal still colours the prompt. */
export const GOAL_AFTERGLOW_MS = 7 * DAY;

/**
 * The single-chat prompt line. Rides the tail of the system prompt right after
 * the lifeline block (constitution: layer order is fixed, new content only
 * appends). Same discipline as the lifeline: background, not script.
 */
export function goalDirective(g: GoalState, now: number): string {
  if (g.status === 'active') {
    const setback = g.recentSetback ? `前几天有点受挫：${g.recentSetback.text}。` : '';
    return (
      `【你手头的一个长期目标】你最近在「${g.title}」。目前：${g.stage}。${setback}` +
      '这是你的生活背景——别逢人就汇报进度，聊到相关话题才自然带出来。'
    );
  }
  if (g.endedAt == null || now - g.endedAt > GOAL_AFTERGLOW_MS) return '';
  return g.status === 'completed'
    ? `【你刚完成的一件事】你前几天完成了目标「${g.title}」，这几天心气很顺，语气里可以带点轻快。别反复提，提过就翻篇。`
    : `【你刚放下的一件事】你前几天放弃了「${g.title}」，有点泄气但嘴上不太提。真被问起就轻描淡写带过。`;
}

/**
 * The proactive-message directive for a terminal event — "有事想跟你说" is the
 * one goal moment that justifies reaching out first. The caller (engine) must
 * mark the event told BEFORE generating, so a failed generation cannot make
 * her announce the same ending twice.
 */
export function goalShareDirective(e: GoalEvent): string {
  return e.kind === 'completed'
    ? `你有个好消息想告诉对方：你之前一直在「${e.title}」，现在成了——${e.text}。` +
        '主动跟对方分享这件事，语气真实一点，可以带点得意，但别写成小作文。'
    : `你决定放弃「${e.title}」了（${e.text}）。想跟对方说一声，倒一点苦水但别太丧，` +
        '说完就聊点别的。';
}

/**
 * Extra background for a Moments post. Seeded gate: goal-adjacent posts should
 * happen *sometimes* — a feed that turns into a progress log reads as a fitness
 * influencer, not a friend. Returns '' most of the time.
 */
export function goalMomentMaterial(g: GoalState, now: number, seed: string): string {
  const rng = seededRng(`gmoment:${seed}`);
  if (g.status === 'completed' && g.endedAt != null && now - g.endedAt < 3 * DAY) {
    // A fresh completion is the one near-certain post: people share wins.
    if (rng() < 0.8) {
      return `你前几天完成了坚持很久的目标「${g.title}」。这条朋友圈可以围绕这份成就感来发，但别写成鸡汤。`;
    }
    return '';
  }
  if (g.status === 'abandoned' && g.endedAt != null && now - g.endedAt < 3 * DAY) {
    // Most abandonments pass in silence; occasionally a wry one-liner.
    if (rng() < 0.3) {
      return `你前几天悄悄放弃了「${g.title}」。如果要发，只发一句自嘲式的，不解释细节。`;
    }
    return '';
  }
  if (g.status !== 'active') return '';
  if (g.recentSetback && now - g.recentSetback.at < 2 * DAY && rng() < 0.35) {
    return `你在「${g.title}」的路上刚受了点挫（${g.recentSetback.text}）。可以发一条带点情绪但不点破细节的。`;
  }
  const lastReached = g.milestones.filter((m) => m.reached).at(-1);
  if (lastReached && now - lastReached.at < 2 * DAY && rng() < 0.5) {
    return `你在「${g.title}」上刚有点进展：${lastReached.text}。可以围绕这个小进展发一条，语气日常一点。`;
  }
  return '';
}
