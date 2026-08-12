/**
 * What the group is talking about, and for how long (M-H1).
 *
 * The director has had a topic line since M-D — but it was one overwritten
 * string (`topic:<convId>`), which means the room could tell you what it was
 * discussing and nothing else. No sense of how long, no memory of what it had
 * just finished discussing, no reason to ever move on. Real group chats do two
 * things this could not represent:
 *
 *   - they get BORED. Eight rounds about the same restaurant and someone
 *     changes the subject.
 *   - they don't LOOP. A topic that just wrapped up does not come straight
 *     back, and a room that keeps rediscovering the same subject every twenty
 *     minutes is the most obvious tell a simulation has.
 *
 * Pure: a state record in, prompt lines out. The clock is injected, nothing is
 * stored here, and the LLM is never consulted about its own pacing.
 */

const MIN = 60_000;

/** Settings row holding one group's topic state. */
export const topicKey = (convId: string) => `topic:${convId}`;

export interface TopicState {
  /** What the director said the room is on, one short line. */
  text: string;
  /** When this topic started. */
  since: number;
  /** How many director rounds it has survived. */
  turns: number;
  /** Recently finished topics, newest first. Bounded — see PAST_KEEP. */
  past: Array<{ text: string; at: number }>;
}

/** How many finished topics stay "too recent to revisit". */
const PAST_KEEP = 4;
/** …and for how long. Beyond this a topic is fair game again. */
export const TOPIC_COOLDOWN_MS = 90 * MIN;

/** Rounds on one topic before the room should want to move. */
export const TOPIC_MAX_TURNS = 6;
/** …or this long, whichever comes first. */
export const TOPIC_MAX_MS = 45 * MIN;

const clip = (s: string, n = 60) => s.trim().slice(0, n);

/**
 * Read whatever is in storage as a TopicState.
 *
 * Rows written before this module was a record are a bare string; treating one
 * as a fresh topic is exactly right — the only thing lost is an age nobody was
 * tracking anyway.
 */
export function readTopic(raw: unknown, now: number): TopicState | undefined {
  if (typeof raw === 'string' && raw.trim()) {
    return { text: clip(raw), since: now, turns: 1, past: [] };
  }
  if (raw && typeof raw === 'object') {
    const r = raw as Partial<TopicState>;
    if (typeof r.text === 'string' && r.text.trim()) {
      return {
        text: clip(r.text),
        since: typeof r.since === 'number' ? r.since : now,
        turns: typeof r.turns === 'number' ? r.turns : 1,
        past: Array.isArray(r.past)
          ? r.past
              .filter((p) => p && typeof p.text === 'string' && typeof p.at === 'number')
              .slice(0, PAST_KEEP)
          : [],
      };
    }
  }
  return undefined;
}

/** Same subject, said differently? Cheap containment test, both directions. */
function sameTopic(a: string, b: string): boolean {
  const x = a.trim();
  const y = b.trim();
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

/**
 * Fold the director's latest topic line into the state.
 *
 * A repeat increments the counter (that is what "we are still on this" means);
 * a change files the old one under `past`, which is what stops the room from
 * circling straight back to it.
 */
export function advanceTopic(prev: TopicState | undefined, next: string, now: number): TopicState {
  const text = clip(next);
  if (!text) return prev ?? { text: '', since: now, turns: 0, past: [] };
  if (prev && sameTopic(prev.text, text)) {
    return { ...prev, text, turns: prev.turns + 1 };
  }
  const past = prev?.text
    ? [{ text: prev.text, at: now }, ...(prev.past ?? [])].slice(0, PAST_KEEP)
    : (prev?.past ?? []);
  return { text, since: now, turns: 1, past };
}

/** Topics finished recently enough that returning to them would read as a loop. */
export function coolingTopics(state: TopicState | undefined, now: number): string[] {
  if (!state) return [];
  return state.past
    .filter((p) => now - p.at < TOPIC_COOLDOWN_MS && !sameTopic(p.text, state.text))
    .map((p) => p.text);
}

/** Has this subject run its course? */
export function topicStale(state: TopicState | undefined, now: number): boolean {
  if (!state?.text) return false;
  return state.turns >= TOPIC_MAX_TURNS || now - state.since >= TOPIC_MAX_MS;
}

/**
 * How long the room has been quiet, in whole minutes.
 *
 * Separate from staleness on purpose: a stale topic is one that has been
 * talked about too much, silence is nobody talking at all, and they call for
 * opposite moves (change the subject vs. say anything).
 */
export function silenceMinutes(lastMsgAt: number | undefined, now: number): number {
  if (lastMsgAt == null) return 0;
  return Math.max(0, Math.floor((now - lastMsgAt) / MIN));
}

/**
 * The director's pacing block. Empty when there is nothing to say — an extra
 * paragraph that says "carry on as you were" costs tokens and dilutes the rest.
 */
export function pacingDirective(
  state: TopicState | undefined,
  now: number,
  lastMsgAt?: number,
): string {
  const lines: string[] = [];
  const cooling = coolingTopics(state, now);

  if (state?.text) {
    const mins = Math.floor((now - state.since) / MIN);
    lines.push(`【当前话题】${state.text}（已聊 ${state.turns} 轮${mins > 0 ? `，${mins} 分钟` : ''}）`);
  }
  if (topicStale(state, now)) {
    // Phrased as permission, not an order: a room that changes the subject on
    // a fixed schedule is as mechanical as one that never does.
    lines.push('这个话题已经聊得差不多了——可以让人自然转开或收个尾，别硬撑。');
  }
  if (cooling.length) {
    lines.push(`【刚聊过，别绕回去】${cooling.join('、')}`);
  }

  const quiet = silenceMinutes(lastMsgAt, now);
  if (quiet >= 25) {
    lines.push(
      `【冷场】群里已经 ${quiet >= 120 ? `${Math.floor(quiet / 60)} 小时` : `${quiet} 分钟`}没人说话了。` +
        '想开口的人可以直接起个新话头，别再接上一条。',
    );
  }
  return lines.join('\n');
}

/**
 * One line about who gets on with whom, warm AND cold.
 *
 * The old clique line only knew about closeness (aff ≥ 65), so the director
 * could stage 附和 but never 拉踩 — every disagreement it cast was arbitrary,
 * because nothing told it who actually has friction with whom. Friction is
 * where group chats get their texture.
 */
export function socialDirective(
  warmPairs: Array<[string, string]>,
  coldPairs: Array<[string, string]>,
): string {
  const parts = [
    ...warmPairs.slice(0, 2).map(([a, b]) => `${a}和${b}走得近`),
    ...coldPairs.slice(0, 2).map(([a, b]) => `${a}对${b}有点意见`),
  ];
  return parts.length ? parts.join('；') : '';
}
