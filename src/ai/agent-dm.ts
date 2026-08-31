/**
 * AI↔AI private DMs — the gossip-spread mechanism (八卦扩散, specs/agents.md).
 *
 * Two agents who share a group occasionally have a short private exchange the
 * user never sees. What makes it CHEMISTRY rather than theater is where the
 * output lands: the exchange's gossip is written into both agents' memory via
 * the ordinary MemoryFactVM path, so it resurfaces later in group banter and
 * single-chat asides through the exact same injection every other memory uses.
 * There is no "performance script" side channel.
 *
 * Cost discipline: one DM = ONE LLM call producing the whole exchange. Sessions
 * are chained like heartbeats with an 8–20h seeded gap — that spacing alone
 * bounds them to ≈≤2/day, with no counter to maintain. Offline backfill never
 * fabricates DMs (each would be a paid call).
 *
 * BOUNDED THREE-WAY (M-I3): a session sometimes has a third participant, and
 * never a fourth (`MAX_DM_PARTICIPANTS`). The cost gate is what makes that safe:
 * a trio is still `DM_LLM_CALLS_PER_SESSION` = 1 call — the director-style
 * single dispatch writes every speaker's lines in one pass, exactly as the RSVP
 * round does. Three participants must never mean three calls, and the constant
 * is unit-locked so a refactor cannot quietly make it so.
 */
import type {
  ContactVM,
  ConversationVM,
  MessageVM,
  MemoryFactVM,
  MomentVM,
  PersonaVM,
  NsfwTierVM,
} from '../data/types';
import { seededRng } from '../lib/money';
import { canSeeMoment } from '../lib/moment-visibility';
import { beginRecordingSuppression, endRecordingSuppression } from '../lib/llm-recorder';
import {
  recordRelEvent,
  recordStance,
  hostileTone,
  STANCE_GOSSIP_DELTA,
  STANCE_GOSSIP_NEG_DELTA,
} from './relationship';
import { maxTier, globalTier } from '../lib/nsfw-tier';
import type { NsfwTier } from '../llm/router';
import { isActiveAt } from './heartbeat';
import { assembleSystemPrompt } from './prompt';
import { toPersonaView } from './engine';
import { selectFactsForInjection } from './memory';
import { moodOf } from '../lib/mood';
import { lifelineAt, lifelineDirective, personaEpoch } from './lifeline';
import { agentEpoch, goalDirective, goalStateAt } from './goals';

const HOUR = 3_600_000;
const MINUTE = 60_000;

/**
 * Hard ceiling on a session's cast. Three is a conversation; four is a group
 * chat the user cannot see, which is a different (and much more expensive)
 * feature. The bound is enforced at planning time and again when a payload is
 * read back off the queue.
 */
export const MAX_DM_PARTICIPANTS = 3;

/** Seeded chance that a planned session takes a third participant. */
export const TRIO_CHANCE = 0.22;

/**
 * LLM calls one session costs, whatever its size. THE cost gate: a trio is one
 * dispatch that writes all three voices, never one call per speaker.
 */
export const DM_LLM_CALLS_PER_SESSION = 1;

/** Speaker slots, in order. Index i of a session's participants is SPEAKERS[i]. */
export const SPEAKERS = ['a', 'b', 'c'] as const;
export type Speaker = (typeof SPEAKERS)[number];

/** Stable conversation id for a session, order-independent (2 or 3 people). */
export function dmConvId(...ids: string[]): string {
  return `dm_${[...ids].sort().join('_')}`;
}

export interface DmPlan {
  a: string;
  b: string;
  /** Third participant (M-I3 bounded trio). Absent = the ordinary pair. */
  c?: string;
  /**
   * The shared group whose chatter this DM may spill into. OPTIONAL since
   * M-J1: two friends who know each other only through the relations graph
   * (no shared room) can still talk — their session simply has no group to
   * quote from and nowhere to spill.
   */
  groupId?: string;
  fireAt: number;
}

/**
 * A plan's cast, in speaker order and bounded. The ONE place that turns
 * `{a, b, c?}` into a list — a call site that spreads the fields by hand is how
 * a fourth participant would eventually sneak in.
 */
export function participantsOf(plan: DmPlan): string[] {
  const ids = [plan.a, plan.b, plan.c].filter((id): id is string => Boolean(id));
  return [...new Set(ids)].slice(0, MAX_DM_PARTICIPANTS);
}

export interface DmRosterEntry {
  contactId: string;
  persona: PersonaVM;
}

/**
 * Pick the next DM session: who, which shared group, and when.
 *
 * The cast is a pair by default and, on a seeded minority of rolls, a trio
 * drawn from the SAME group (a third person who was not in that room has no
 * business in the exchange). Never more than `MAX_DM_PARTICIPANTS`.
 *
 * 无群兜底 (M-J1): with no shared group, `edgePairs` — friend pairs that have a
 * relationship edge, resolved by the impure caller from `rel_edges` — keeps the
 * private social life alive. Such a session has no room to quote or spill into
 * (`groupId` absent), and never a trio: the third used to come from the shared
 * room, and there is none.
 */
export function planNextDm(
  roster: DmRosterEntry[],
  groups: Array<{ convId: string; memberIds: string[] }>,
  from: number,
  seed: string,
  edgePairs: Array<{ a: string; b: string }> = [],
): DmPlan | null {
  const byId = new Map(roster.map((r) => [r.contactId, r]));
  // All unordered pairs that share at least one group, remembering the room so
  // a third participant can be drawn from the same roster.
  const pairs: Array<{ a: DmRosterEntry; b: DmRosterEntry; groupId?: string; members: string[] }> =
    [];
  for (const g of groups) {
    const members = g.memberIds.filter((id) => byId.has(id));
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        pairs.push({
          a: byId.get(members[i])!,
          b: byId.get(members[j])!,
          groupId: g.convId,
          members,
        });
      }
    }
  }
  if (pairs.length === 0) {
    // Fallback lane: pairs that KNOW each other (an edge exists) even though
    // no room holds them both. Deduped and order-normalized so the seeded pick
    // is stable whichever way the caller handed the edge in.
    const seen = new Set<string>();
    for (const e of edgePairs) {
      const a = byId.get(e.a);
      const b = byId.get(e.b);
      if (!a || !b || a === b) continue;
      const key = [e.a, e.b].sort().join('~');
      if (seen.has(key)) continue;
      seen.add(key);
      pairs.push({ a, b, members: [] });
    }
  }
  if (pairs.length === 0) return null;

  const rng = seededRng(`dmplan:${seed}:${Math.floor(from / HOUR)}`);
  const pick = pairs[Math.floor(rng() * pairs.length)];

  // Sometimes a third person from the same room is in on it. Rolled BEFORE the
  // timing so the active-hours walk below can honour everyone who is coming.
  const cast: DmRosterEntry[] = [pick.a, pick.b];
  if (rng() < TRIO_CHANCE) {
    const others = pick.members.filter((id) => id !== pick.a.contactId && id !== pick.b.contactId);
    if (others.length > 0) {
      const third = byId.get(others[Math.floor(rng() * others.length)]);
      if (third) cast.push(third);
    }
  }

  // 8–20h out — the spacing itself enforces the ≈2/day budget.
  let fireAt = from + (8 + rng() * 12) * HOUR;
  // Walk forward until EVERY participant is awake (≤48 hourly steps).
  for (let i = 0; i < 48 && !cast.every((p) => isActiveAt(p.persona, fireAt)); i++) {
    fireAt += HOUR;
  }
  return {
    a: cast[0].contactId,
    b: cast[1].contactId,
    ...(cast[2] ? { c: cast[2].contactId } : {}),
    ...(pick.groupId ? { groupId: pick.groupId } : {}),
    fireAt: Math.round(fireAt),
  };
}

/** Candidate topics, seeded-picked. Pure so the choice is replayable. */
export function pickDmTopic(candidates: string[], seed: string): string | null {
  const pool = candidates.map((c) => c.trim()).filter(Boolean);
  if (pool.length === 0) return null;
  return pool[Math.floor(seededRng(`dmtopic:${seed}`)() * pool.length)];
}

export interface DmScript {
  /** Lines in order; `who` is the participant's speaker slot. */
  lines: Array<{ who: Speaker; text: string }>;
  gossip?: { about: string; fact: string };
}

/** Line ceiling per session size — a trio needs a little more room, not much. */
export function dmLineCap(participantCount: number): number {
  return participantCount >= 3 ? 10 : 8;
}

/**
 * Parse the model's NDJSON exchange. Tolerant per line, strict overall: fewer
 * than 2 usable lines voids the whole session (a half-materialized private chat
 * is worse than none). Junk lines and markdown fences are skipped.
 *
 * `participantCount` is the whitelist: a "C" line in a two-person session is a
 * hallucinated third party and is dropped, never guessed into an existing id.
 */
export function parseDmScript(raw: string, participantCount = 2): DmScript | null {
  const allowed = SPEAKERS.slice(0, Math.min(participantCount, MAX_DM_PARTICIPANTS)) as readonly Speaker[];
  const lines: DmScript['lines'] = [];
  let gossip: DmScript['gossip'];
  for (const lineRaw of raw.split('\n')) {
    const line = lineRaw.trim().replace(/^```(json)?|```$/g, '');
    if (!line.startsWith('{')) continue;
    try {
      const obj = JSON.parse(line) as Record<string, unknown>;
      if (typeof obj.gossip === 'object' && obj.gossip) {
        const g = obj.gossip as Record<string, unknown>;
        if (typeof g.about === 'string' && typeof g.fact === 'string' && g.fact.trim()) {
          gossip = { about: g.about, fact: g.fact.trim().slice(0, 60) };
        }
        continue;
      }
      const speaker = String(obj.speaker ?? '')
        .trim()
        .toLowerCase() as Speaker;
      const text = typeof obj.text === 'string' ? obj.text.trim() : '';
      if (!text) continue;
      if (allowed.includes(speaker)) lines.push({ who: speaker, text });
    } catch {
      /* junk line — skip */
    }
  }
  if (lines.length < 2) return null;
  return { lines: lines.slice(0, dmLineCap(allowed.length)), gossip };
}

export interface DmCastMember {
  name: string;
  persona: PersonaVM;
}

/** One member's inner-life lines (mood / goal / lifeline), pure and seeded. */
function castStateLines(m: DmCastMember, now: number): string {
  const id = m.persona.contactId;
  const goal = goalStateAt(id, now, agentEpoch(id));
  const goalBit = goal.status === 'active' ? `正在「${goal.title}」（${goal.stage}）` : '';
  return [`今天的状态：${moodOf(id, now).line}`, goalBit].filter(Boolean).join('；');
}

/**
 * The single-call prompt that produces the WHOLE exchange — two voices or
 * three, one dispatch either way (see `DM_LLM_CALLS_PER_SESSION`).
 *
 * 换脑 (M-J1): slot A — the teller, whose memory seeded the topic — speaks from
 * the SAME assembled brain the chat engines use (`assembleSystemPrompt` with
 * the full persona view, then lifeline + goal appended in engine order), plus a
 * mood line per participant. The exchange itself stays all-ages whatever the
 * routing tier — hidden DMs are the source of hearsay, and hearsay surfaces in
 * group chat — so the boundary layer is assembled at 'off' while the CALL's
 * tier (rule #6) is still declared by the caller from the participants.
 */
export function buildDmPrompt(
  cast: DmCastMember[],
  topic: string,
  now: number,
): Array<{ role: 'system' | 'user'; content: string }> {
  const members = cast.slice(0, MAX_DM_PARTICIPANTS);
  const slots = SPEAKERS.slice(0, members.length).map((s) => s.toUpperCase());
  const trio = members.length >= 3;
  const [head, ...others] = members;

  // A 的完整大脑：与聊天引擎同一条装配线，同一个层序。
  const relations: Record<string, string> = {};
  const userRel = head.persona.relations.user?.trim();
  if (userRel) relations.user = userRel;
  for (const o of others) {
    const text = head.persona.relations[o.persona.contactId]?.trim();
    if (text) relations[o.name] = text;
  }
  let brain = assembleSystemPrompt({
    persona: toPersonaView(head.persona, head.name),
    relations: Object.keys(relations).length ? relations : undefined,
    nsfwTier: 'off',
    scene: {
      kind: 'single',
      now: new Date(now),
      moodLine: moodOf(head.persona.contactId, now).line,
    },
  });
  const arcLine = lifelineDirective(
    lifelineAt(head.persona, now, personaEpoch(head.persona.contactId)),
  );
  if (arcLine) brain += `\n\n${arcLine}`;
  const goalLine = goalDirective(
    goalStateAt(head.persona.contactId, now, agentEpoch(head.persona.contactId)),
    now,
  );
  if (goalLine) brain += `\n\n${goalLine}`;

  const cards = others
    .map(
      (m, i) =>
        `${slots[i + 1]} 是「${m.name}」：${m.persona.core}${
          m.persona.speechStyle ? `（说话风格：${m.persona.speechStyle}）` : ''
        }\n${slots[i + 1]} ${castStateLines(m, now)}`,
    )
    .join('\n');
  // Every directed edge that actually exists — "C 眼里的 A" matters as much in a
  // trio as "A 眼里的 B" does in a pair.
  const edges = members
    .flatMap((from, i) =>
      members.flatMap((to, j) => {
        if (i === j) return [];
        const text = from.persona.relations[to.persona.contactId];
        return text ? [`${slots[i]} 眼里的 ${slots[j]}：${text}`] : [];
      }),
    )
    .join('\n');

  const system = `${brain}

# 现在的场合
你（${slots[0]}，「${head.name}」）正在和朋友${trio ? '们开一个三人小窗' : '私聊'}——不是和用户聊天。
你要以编剧视角写出这段完整的微信${trio ? '小群聊' : '私聊'}，共 ${trio ? '6 到 10' : '4 到 8'} 条消息，${
    trio ? '三个人轮流出声' : '两人交替发言'
  }，每个人都严格保持自己的人设语气。

${cards}
${edges}

这次${trio ? '你们' : '你俩'}聊到：${topic}

要求：
- 像真人发微信：短句、口语，别写小作文，别用列表。
- 内容必须全年龄向。
- 逐行输出 NDJSON，每行 {"speaker":"${slots.join('"或"')}","text":"..."}。${
    trio ? '\n- 三个人都要说话，别让谁从头到尾不出声。' : ''
  }
- 最后额外输出一行 {"gossip":{"about":"user","fact":"不超过30字的一句话，概括这次聊天里关于用户或彼此的一个可被之后提起的信息"}}；
  about 只能是 "user" 或 ${slots.map((s) => `"${s}"`).join(' 或 ')}。
- 除这些 JSON 行外不要输出任何东西。`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: '开始。' },
  ];
}

/**
 * Timestamps for the exchange's rows: start at fireAt (floored past the
 * conversation's own last message — rowid order == time order holds for hidden
 * conversations too), stepping 30–90s per line.
 */
export function dmTimestamps(
  count: number,
  fireAt: number,
  lastMsgAt: number | undefined,
  seed: string,
): number[] {
  const rng = seededRng(`dmts:${seed}`);
  let t = Math.max(fireAt, (lastMsgAt ?? 0) + MINUTE);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(Math.round(t));
    t += 30_000 + rng() * 60_000;
  }
  return out;
}

/**
 * The hidden conversation row for a session (2 or 3 people), created on first
 * exchange. `isHidden` is the ONE thing standing between this row and every
 * user-visible surface (list, badge, search, forward picker, favorites,
 * notifications, year report) — all of them filter on it, none of them on the
 * `dm_` id shape, which is why a three-person row needs no new wall.
 */
export function makeDmConversation(participants: ContactVM[], now: number): ConversationVM {
  const cast = participants.slice(0, MAX_DM_PARTICIPANTS);
  const [head] = cast;
  return {
    id: dmConvId(...cast.map((c) => c.id)),
    type: 'single',
    title: cast.map((c) => c.remark ?? c.name).join('、'),
    avatarColor: head.avatarColor,
    avatarText: head.avatarText,
    memberIds: cast.map((c) => c.id),
    isPinned: false,
    isMuted: true,
    isHidden: true,
    unreadCount: 0,
    mentionMe: false,
    lastMsgPreview: '',
    lastMsgAt: now,
  };
}

/** Should this DM spill a conversation starter into the shared group? */
export function shouldSpillToGroup(dmId: string, fireAt: number): boolean {
  return seededRng(`dmspill:${dmId}:${fireAt}`)() < 0.5;
}

/* -------------------------- 八卦二跳 (M-J1) -------------------------- */

/** Second-hand confidence decays this much per hop. */
export const HOP2_DECAY = 0.6;
/**
 * Only facts at least this confident travel on. First-hop hearsay lands at 0.4;
 * a retold fact carries 0.4 × 0.6 = 0.24 < 0.4, so a THIRD hop is impossible
 * by construction — the floor is the whole "仅一跳" rule, not a separate flag
 * someone could forget to check.
 */
export const HOP2_MIN_CONFIDENCE = 0.4;
/** Chance a retellable rumor actually gets retold this session. */
export const HOP2_CHANCE = 0.5;

const HEARSAY_RE = /^听(.{1,12}?)说：(.+)$/;

export interface Hop2Pick {
  /** The teller's own hearsay row the retelling springs from. */
  factId: string;
  /** The rumor body, stripped of its 「听X说：」 framing. */
  core: string;
  /** Who the teller originally heard it from. */
  sourceName: string;
  confidence: number;
}

/**
 * 八卦传到第二跳：a 「听X说」 memory the TELLER holds may, on a seeded minority
 * of sessions, become the next exchange's topic — retold to new listeners with
 * decayed confidence. Pure and seeded; the caller writes the hop-2 rows only
 * after the session actually materializes.
 */
export function pickHop2Gossip(tellerFacts: MemoryFactVM[], seed: string): Hop2Pick | null {
  const eligible = tellerFacts
    .filter(
      (f) =>
        f.status !== 'archived' &&
        f.source === 'hearsay' &&
        (f.confidence ?? 0) >= HOP2_MIN_CONFIDENCE &&
        HEARSAY_RE.test(f.fact),
    )
    .sort((a, b) => a.id.localeCompare(b.id)); // stable order → stable pick
  if (eligible.length === 0) return null;
  const rng = seededRng(`hop2:${seed}`);
  if (rng() >= HOP2_CHANCE) return null;
  const f = eligible[Math.floor(rng() * eligible.length)];
  const m = HEARSAY_RE.exec(f.fact)!;
  return {
    factId: f.id,
    core: m[2].trim().slice(0, 60),
    sourceName: m[1],
    confidence: f.confidence ?? HOP2_MIN_CONFIDENCE,
  };
}

/**
 * The listeners' second-hand rows for a retold rumor. The teller keeps their
 * original row; each listener now "heard it from the teller", at
 * `confidence × HOP2_DECAY` — which lands below `HOP2_MIN_CONFIDENCE`, so the
 * chain dies here on its own.
 */
export function hop2Facts(
  teller: { id: string; name: string },
  listeners: Array<{ id: string; name: string }>,
  pick: Hop2Pick,
  now: number,
): MemoryFactVM[] {
  const confidence = Math.round(pick.confidence * HOP2_DECAY * 100) / 100;
  return listeners.map((p, i) => ({
    id: `gossip2_${teller.id}_${p.id}_${now}_${i}`,
    subjectId: p.id,
    fact: `听${teller.name}说：${pick.core}`.slice(0, 80),
    importance: 2,
    sensitivity: 'normal' as const,
    evidenceMsgIds: [],
    status: 'confirmed' as const,
    source: 'hearsay' as const,
    confidence,
    isPinned: false,
    createdAt: now,
  }));
}

/**
 * Assemble gossip memory rows — one per participant, speaker/listener framed.
 * Pure. Works for a pair and for a trio (the head is the teller; everyone else
 * heard it from them).
 */
export function gossipFacts(
  participants: Array<{ id: string; name: string }>,
  gossip: { about: string; fact: string },
  contactExists: (id: string) => boolean,
  now: number,
): MemoryFactVM[] {
  const cast = participants.slice(0, MAX_DM_PARTICIPANTS);
  if (cast.length < 2) return [];
  // `about` referring to a contact that no longer exists is dropped upstream;
  // 'user' and this session's OWN speaker slots are the only permitted values —
  // a "C" in a two-person exchange is a hallucinated party.
  const slots = SPEAKERS.slice(0, cast.length).map((s) => s.toUpperCase());
  if (gossip.about !== 'user' && !slots.includes(gossip.about)) return [];
  if (!cast.every((p) => contactExists(p.id))) return [];
  const stamp = `${dmConvId(...cast.map((p) => p.id))}_${now}`;
  const [teller, ...listeners] = cast;
  const base = {
    // 3, not 2 (M-J0): maintainMemory's fast lane archives importance≤2 rows
    // untouched for 30 days, and gossip rows are written for the AI side — the
    // single-chat touchFacts path never refreshes them. At 2 every piece of
    // gossip self-destructed in exactly 30 days, no matter how juicy.
    importance: 3 as const,
    sensitivity: 'normal' as const,
    evidenceMsgIds: [] as number[],
    status: 'confirmed' as const,
    source: 'hearsay' as const,
    confidence: 0.4,
    isPinned: false,
    createdAt: now,
  };
  return [
    {
      ...base,
      id: `gossip_${stamp}_a`,
      subjectId: teller.id,
      fact: `和${listeners.map((p) => p.name).join('、')}聊到：${gossip.fact}`,
    },
    ...listeners.map((p, i) => ({
      ...base,
      id: `gossip_${stamp}_${SPEAKERS[i + 1]}`,
      subjectId: p.id,
      fact: `听${teller.name}说：${gossip.fact}`,
    })),
  ];
}

/** Types the runtime hands to the impure orchestrator (kept minimal for tests). */
export interface DmDeps {
  getPersona: (id: string) => PersonaVM | undefined;
  getContact: (id: string) => ContactVM | undefined;
  getConversation: (id: string) => Promise<ConversationVM | undefined>;
  addConversation: (c: ConversationVM) => Promise<void>;
  appendMessage: (m: Omit<MessageVM, 'id'>) => Promise<MessageVM>;
  putMemory: (f: MemoryFactVM) => Promise<void>;
  getMemoryFacts: (subjectId: string) => Promise<MemoryFactVM[]>;
  getGroupMessages: (convId: string) => Promise<MessageVM[]>;
  getMoments: () => Promise<MomentVM[]>;
  complete: (
    messages: Array<{ role: 'system' | 'user'; content: string }>,
    convKey: string,
    /**
     * Effective tier of the topic material. DM topics are copied verbatim from
     * group messages and memories, so a full-tier source declared as 'off' put
     * explicit text on a domestic endpoint — and because DMs run under
     * `beginRecordingSuppression`, it left no local trace (rule #6).
     */
    tier?: NsfwTier,
  ) => Promise<string>;
  enqueueGroupSpill: (groupId: string, speakerId: string, hint: string, at: number) => Promise<void>;
  now: () => number;
  /**
   * The global NSFW ceiling. Injected rather than read from storage here so this
   * orchestrator keeps its "no ambient state" property — the participants'
   * permits still gate the tier, so a call site cannot raise it by lying.
   */
  getGlobalTier?: () => Promise<NsfwTierVM>;
}

/**
 * Run one DM session end to end. Every failure path is silent-void by design:
 * a missing private exchange is invisible, a half-materialized one is not.
 */
export async function runAgentDm(plan: DmPlan, deps: DmDeps): Promise<boolean> {
  const ids = participantsOf(plan);
  if (ids.length < 2) return false;
  const cast = ids.map((id) => ({
    id,
    persona: deps.getPersona(id),
    contact: deps.getContact(id),
  }));
  // One missing participant voids the session: a trio silently degrading to a
  // pair would materialize an exchange nobody planned.
  if (!cast.every((p) => p.persona && p.contact)) return false;
  const named = cast.map((p) => ({
    id: p.id,
    name: p.contact!.remark ?? p.contact!.name,
    persona: p.persona!,
    contact: p.contact!,
  }));

  // Topic: their memories, the shared group's recent chatter, their moments.
  // A no-group session (M-J1 兜底) simply has no room to quote.
  const [memories, groupMsgs, moments] = await Promise.all([
    Promise.all(named.map((p) => deps.getMemoryFacts(p.id))),
    plan.groupId ? deps.getGroupMessages(plan.groupId) : Promise.resolve([] as MessageVM[]),
    deps.getMoments(),
  ]);
  // Routing tier (rule #6): every participant's permit gates the material any
  // of them may quote. Derived BEFORE the memory read below, because the same
  // tier now also gates which facts are even eligible as topics. Failure is
  // silent-void like every other path here — never a permissive default.
  let dmTier: NsfwTier;
  try {
    dmTier = maxTier(
      await (deps.getGlobalTier ?? globalTier)(),
      named.map((p) => p.persona),
    );
  } catch {
    return false;
  }
  // 评分检索 + 注入白名单 (M-J1). The old read was `facts.slice(0, 2)` — raw
  // storage order, no scoring, and NO sensitivity gate: an archived fact or a
  // full-tier one could become two agents' chat topic, and hidden DMs are the
  // one surface whose leaks resurface in front of the user as group hearsay.
  // `surface: 'dm'` has been defined in the whitelist since M-E0 with zero
  // callers; this is the caller. It admits `normal` facts only, whatever the
  // tier — and archived rows are filtered by selection itself.
  const groupQuery = groupMsgs
    .filter((m) => m.type === 'text' && m.content && !m.isRecalled)
    .slice(-3)
    .map((m) => m.content ?? '')
    .join(' ')
    .slice(0, 120);
  const factTopics = memories.flatMap((facts) => {
    const sel = selectFactsForInjection(facts, deps.now(), {
      surface: 'dm',
      tier: dmTier,
      query: groupQuery,
      topK: 2,
      maxPinned: 2,
    });
    return [...sel.pinned, ...sel.topK].slice(0, 2);
  });
  const candidates = [
    ...factTopics,
    ...groupMsgs
      .filter((m) => m.type === 'text' && m.content && !m.isRecalled)
      .slice(-3)
      .map((m) => `群里刚聊过：${m.content}`),
    ...moments
      // 可见范围 (M-I18): the read behind `deps.getMoments` uses the default
      // viewer ('self'), because there is no single viewer for a DM — so the
      // audience check belongs HERE, and it must hold for EVERY participant.
      // Quoting a post one speaker cannot see is not a private slip: hidden
      // DMs are the source of hearsay, and hearsay surfaces in group chat, so
      // it would come back to the user as 「她怎么知道这条」.
      //
      // Today this is belt-and-braces — the filter already keeps only posts
      // authored by the participants, and an agent's own post is always
      // public. It is written anyway because the day an agent can post
      // 部分可见 (the plan's AI 连续剧式发帖 heads that way), the leak would
      // open silently, with no test failing.
      .filter((m) => ids.includes(m.authorId) && m.text)
      .filter((m) => ids.every((viewer) => canSeeMoment(m, viewer)))
      .slice(0, 2)
      .map((m) => `朋友圈那条「${m.text}」`),
    '最近各自在忙什么',
  ];
  const dmId = dmConvId(...ids);
  // 八卦二跳 (M-J1): a rumor the teller HEARD may outrank the ordinary topics
  // and travel one more step — seeded, minority, and self-terminating via the
  // confidence floor (see `pickHop2Gossip`).
  const hop2 = pickHop2Gossip(memories[0] ?? [], `${dmId}:${plan.fireAt}`);
  const topic = hop2
    ? `你（${named[0].name}）之前听${hop2.sourceName}说过一件事：「${hop2.core}」。这次忍不住讲给对方听，顺便聊开。`
    : pickDmTopic(candidates, `${dmId}:${plan.fireAt}`);
  if (!topic) return false;

  let script: DmScript | null;
  // Hidden-DM containment: the LLM recording tap must never capture this
  // prompt/reply — the export surface would leak the gossip verbatim.
  beginRecordingSuppression();
  try {
    // ONE call, whatever the cast size (DM_LLM_CALLS_PER_SESSION).
    const raw = await deps.complete(
      buildDmPrompt(
        named.map((p) => ({ name: p.name, persona: p.persona })),
        topic,
        plan.fireAt,
      ),
      `dm:${dmId}`,
      dmTier,
    );
    script = parseDmScript(raw, named.length);
  } catch {
    return false;
  } finally {
    endRecordingSuppression();
  }
  if (!script) return false;

  // Materialize into the hidden conversation.
  let conv = await deps.getConversation(dmId);
  if (!conv) {
    conv = makeDmConversation(
      named.map((p) => p.contact),
      plan.fireAt,
    );
    await deps.addConversation(conv);
  }
  const stamps = dmTimestamps(script.lines.length, plan.fireAt, conv.lastMsgAt, `${dmId}:${plan.fireAt}`);
  for (let i = 0; i < script.lines.length; i++) {
    const line = script.lines[i];
    const senderId = ids[SPEAKERS.indexOf(line.who)];
    if (!senderId) continue; // parser already whitelists, belt and braces
    await deps.appendMessage({
      convId: dmId,
      senderId,
      type: 'text',
      content: line.text,
      status: 'sent',
      createdAt: stamps[i],
    });
  }

  // Gossip → every participant's memory, through the same rows every other
  // memory uses.
  if (script.gossip) {
    for (const f of gossipFacts(
      named.map((p) => ({ id: p.id, name: p.name })),
      script.gossip,
      (id) => Boolean(deps.getContact(id)),
      deps.now(),
    )) {
      await deps.putMemory(f);
    }
    // Stance writer 4 of 4 (M-J1): talking ABOUT someone moves how the teller
    // carries them — a notch warmer for being on their mind, a notch cooler
    // when the talk was unkind. `about` resolves through the same slot
    // whitelist the memory rows use; 'user' has no stance row and never will.
    const slots = SPEAKERS.slice(0, named.length).map((s) => s.toUpperCase());
    const aboutIdx = slots.indexOf(script.gossip.about);
    const aboutId = aboutIdx >= 0 ? ids[aboutIdx] : null;
    if (aboutId && aboutId !== ids[0]) {
      const delta = hostileTone(script.gossip.fact)
        ? STANCE_GOSSIP_NEG_DELTA
        : STANCE_GOSSIP_DELTA;
      // Awaited (unlike the reply-path writers): this is a background job with
      // no user staring at a typing indicator, and the rows around it await too.
      await recordStance(ids[0], aboutId, delta, deps.now()).catch(() => {});
    }
  }

  // 二跳落库 (M-J1): the retold rumor becomes the LISTENERS' second-hand
  // memory, at decayed confidence — below the retell floor, so it stops here.
  if (hop2) {
    for (const f of hop2Facts(
      { id: named[0].id, name: named[0].name },
      named.slice(1).map((p) => ({ id: p.id, name: p.name })),
      hop2,
      deps.now(),
    )) {
      await deps.putMemory(f);
    }
  }

  // A shared session builds each pair's own bond — including the two who only
  // met because a third person pulled them into the same thread.
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      void recordRelEvent(ids[i], ids[j], 'dm_gossip', deps.now()).catch(() => {});
    }
  }

  // Maybe spill a starter into the shared group, minutes-to-an-hour later.
  // A no-group session (M-J1 兜底) has nowhere to spill, by definition.
  if (plan.groupId && shouldSpillToGroup(dmId, plan.fireAt)) {
    const rng = seededRng(`dmspeak:${dmId}:${plan.fireAt}`);
    const speaker = ids[Math.floor(rng() * ids.length)];
    const at = deps.now() + (10 + rng() * 30) * MINUTE;
    await deps.enqueueGroupSpill(plan.groupId, speaker, topic.slice(0, 20), at);
  }
  return true;
}
