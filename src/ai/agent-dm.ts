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
 */
import type {
  ContactVM,
  ConversationVM,
  MessageVM,
  MemoryFactVM,
  MomentVM,
  PersonaVM,
} from '../data/types';
import { seededRng } from '../lib/money';
import { beginRecordingSuppression, endRecordingSuppression } from '../lib/llm-recorder';
import { recordRelEvent } from './relationship';
import { isActiveAt } from './heartbeat';

const HOUR = 3_600_000;
const MINUTE = 60_000;

/** Stable conversation id for a pair, order-independent. */
export function dmConvId(a: string, b: string): string {
  const [x, y] = [a, b].sort();
  return `dm_${x}_${y}`;
}

export interface DmPlan {
  a: string;
  b: string;
  /** The shared group whose chatter this DM may spill into. */
  groupId: string;
  fireAt: number;
}

export interface DmRosterEntry {
  contactId: string;
  persona: PersonaVM;
}

/**
 * Pick the next DM session: which pair, which shared group, and when.
 *
 * Returns null when no two persona-backed agents share a group — without a
 * shared group there is no surface for the chemistry to land on, so a DM would
 * be a paid LLM call with no observable effect.
 */
export function planNextDm(
  roster: DmRosterEntry[],
  groups: Array<{ convId: string; memberIds: string[] }>,
  from: number,
  seed: string,
): DmPlan | null {
  const byId = new Map(roster.map((r) => [r.contactId, r]));
  // All unordered pairs that share at least one group.
  const pairs: Array<{ a: DmRosterEntry; b: DmRosterEntry; groupId: string }> = [];
  for (const g of groups) {
    const members = g.memberIds.filter((id) => byId.has(id));
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        pairs.push({ a: byId.get(members[i])!, b: byId.get(members[j])!, groupId: g.convId });
      }
    }
  }
  if (pairs.length === 0) return null;

  const rng = seededRng(`dmplan:${seed}:${Math.floor(from / HOUR)}`);
  const pick = pairs[Math.floor(rng() * pairs.length)];

  // 8–20h out — the spacing itself enforces the ≈2/day budget.
  let fireAt = from + (8 + rng() * 12) * HOUR;
  // Walk forward until BOTH participants are awake (≤48 hourly steps).
  for (
    let i = 0;
    i < 48 &&
    !(isActiveAt(pick.a.persona, fireAt) && isActiveAt(pick.b.persona, fireAt));
    i++
  ) {
    fireAt += HOUR;
  }
  return { a: pick.a.contactId, b: pick.b.contactId, groupId: pick.groupId, fireAt: Math.round(fireAt) };
}

/** Candidate topics, seeded-picked. Pure so the choice is replayable. */
export function pickDmTopic(candidates: string[], seed: string): string | null {
  const pool = candidates.map((c) => c.trim()).filter(Boolean);
  if (pool.length === 0) return null;
  return pool[Math.floor(seededRng(`dmtopic:${seed}`)() * pool.length)];
}

export interface DmScript {
  /** Alternating-ish lines; who is 'a' or 'b'. */
  lines: Array<{ who: 'a' | 'b'; text: string }>;
  gossip?: { about: string; fact: string };
}

/**
 * Parse the model's NDJSON exchange. Tolerant per line, strict overall: fewer
 * than 2 usable lines voids the whole session (a half-materialized private chat
 * is worse than none). Junk lines and markdown fences are skipped.
 */
export function parseDmScript(raw: string): DmScript | null {
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
      const speaker = String(obj.speaker ?? '').toUpperCase();
      const text = typeof obj.text === 'string' ? obj.text.trim() : '';
      if (!text) continue;
      if (speaker === 'A') lines.push({ who: 'a', text });
      else if (speaker === 'B') lines.push({ who: 'b', text });
    } catch {
      /* junk line — skip */
    }
  }
  if (lines.length < 2) return null;
  return { lines: lines.slice(0, 8), gossip };
}

/** The single-call prompt that produces the whole exchange. */
export function buildDmPrompt(
  aName: string,
  aPersona: PersonaVM,
  bName: string,
  bPersona: PersonaVM,
  topic: string,
): Array<{ role: 'system' | 'user'; content: string }> {
  const system = `你要写一段两个真实朋友之间的微信私聊，共 4 到 8 条消息，两人交替发言。

A 是「${aName}」：${aPersona.core}${aPersona.speechStyle ? `（说话风格：${aPersona.speechStyle}）` : ''}
B 是「${bName}」：${bPersona.core}${bPersona.speechStyle ? `（说话风格：${bPersona.speechStyle}）` : ''}
${aPersona.relations[bPersona.contactId] ? `A 眼里的 B：${aPersona.relations[bPersona.contactId]}` : ''}
${bPersona.relations[aPersona.contactId] ? `B 眼里的 A：${bPersona.relations[aPersona.contactId]}` : ''}

这次他们聊到：${topic}

要求：
- 像真人发微信：短句、口语，别写小作文，别用列表。
- 内容必须全年龄向。
- 逐行输出 NDJSON，每行 {"speaker":"A"或"B","text":"..."}。
- 最后额外输出一行 {"gossip":{"about":"user","fact":"不超过30字的一句话，概括这次聊天里关于用户或彼此的一个可被之后提起的信息"}}；
  about 只能是 "user" 或 "A" 或 "B"。
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

/** The hidden conversation row for a pair, created on first exchange. */
export function makeDmConversation(
  a: ContactVM,
  b: ContactVM,
  now: number,
): ConversationVM {
  return {
    id: dmConvId(a.id, b.id),
    type: 'single',
    title: `${a.remark ?? a.name}、${b.remark ?? b.name}`,
    avatarColor: a.avatarColor,
    avatarText: a.avatarText,
    memberIds: [a.id, b.id],
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

/** Assemble gossip memory rows for both participants. Pure. */
export function gossipFacts(
  plan: { a: string; b: string },
  aName: string,
  bName: string,
  gossip: { about: string; fact: string },
  contactExists: (id: string) => boolean,
  now: number,
): MemoryFactVM[] {
  // `about` referring to a contact that no longer exists is dropped upstream;
  // 'user'/'A'/'B' are the only values the prompt permits anyway.
  if (gossip.about !== 'user' && gossip.about !== 'A' && gossip.about !== 'B') return [];
  if (!contactExists(plan.a) || !contactExists(plan.b)) return [];
  const stamp = `${dmConvId(plan.a, plan.b)}_${now}`;
  return [
    {
      id: `gossip_${stamp}_a`,
      subjectId: plan.a,
      fact: `和${bName}聊到：${gossip.fact}`,
      importance: 2,
      sensitivity: 'normal',
      evidenceMsgIds: [],
      status: 'confirmed',
      isPinned: false,
      createdAt: now,
    },
    {
      id: `gossip_${stamp}_b`,
      subjectId: plan.b,
      fact: `听${aName}说：${gossip.fact}`,
      importance: 2,
      sensitivity: 'normal',
      evidenceMsgIds: [],
      status: 'confirmed',
      isPinned: false,
      createdAt: now,
    },
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
  ) => Promise<string>;
  enqueueGroupSpill: (groupId: string, speakerId: string, hint: string, at: number) => Promise<void>;
  now: () => number;
}

/**
 * Run one DM session end to end. Every failure path is silent-void by design:
 * a missing private exchange is invisible, a half-materialized one is not.
 */
export async function runAgentDm(plan: DmPlan, deps: DmDeps): Promise<boolean> {
  const pa = deps.getPersona(plan.a);
  const pb = deps.getPersona(plan.b);
  const ca = deps.getContact(plan.a);
  const cb = deps.getContact(plan.b);
  if (!pa || !pb || !ca || !cb) return false;
  const aName = ca.remark ?? ca.name;
  const bName = cb.remark ?? cb.name;

  // Topic: their memories, the shared group's recent chatter, their moments.
  const [famem, fbmem, groupMsgs, moments] = await Promise.all([
    deps.getMemoryFacts(plan.a),
    deps.getMemoryFacts(plan.b),
    deps.getGroupMessages(plan.groupId),
    deps.getMoments(),
  ]);
  const candidates = [
    ...famem.slice(0, 2).map((f) => f.fact),
    ...fbmem.slice(0, 2).map((f) => f.fact),
    ...groupMsgs
      .filter((m) => m.type === 'text' && m.content && !m.isRecalled)
      .slice(-3)
      .map((m) => `群里刚聊过：${m.content}`),
    ...moments
      .filter((m) => (m.authorId === plan.a || m.authorId === plan.b) && m.text)
      .slice(0, 2)
      .map((m) => `朋友圈那条「${m.text}」`),
    '最近各自在忙什么',
  ];
  const dmId = dmConvId(plan.a, plan.b);
  const topic = pickDmTopic(candidates, `${dmId}:${plan.fireAt}`);
  if (!topic) return false;

  let script: DmScript | null;
  // Hidden-DM containment: the LLM recording tap must never capture this
  // prompt/reply — the export surface would leak the gossip verbatim.
  beginRecordingSuppression();
  try {
    const raw = await deps.complete(buildDmPrompt(aName, pa, bName, pb, topic), `dm:${dmId}`);
    script = parseDmScript(raw);
  } catch {
    return false;
  } finally {
    endRecordingSuppression();
  }
  if (!script) return false;

  // Materialize into the hidden conversation.
  let conv = await deps.getConversation(dmId);
  if (!conv) {
    conv = makeDmConversation(ca, cb, plan.fireAt);
    await deps.addConversation(conv);
  }
  const stamps = dmTimestamps(script.lines.length, plan.fireAt, conv.lastMsgAt, `${dmId}:${plan.fireAt}`);
  for (let i = 0; i < script.lines.length; i++) {
    const line = script.lines[i];
    await deps.appendMessage({
      convId: dmId,
      senderId: line.who === 'a' ? plan.a : plan.b,
      type: 'text',
      content: line.text,
      status: 'sent',
      createdAt: stamps[i],
    });
  }

  // Gossip → both memories, through the same rows every other memory uses.
  if (script.gossip) {
    for (const f of gossipFacts(
      plan,
      aName,
      bName,
      script.gossip,
      (id) => Boolean(deps.getContact(id)),
      deps.now(),
    )) {
      await deps.putMemory(f);
    }
  }

  // A shared DM session builds the pair's own bond.
  void recordRelEvent(plan.a, plan.b, 'dm_gossip', deps.now()).catch(() => {});

  // Maybe spill a starter into the shared group, minutes-to-an-hour later.
  if (shouldSpillToGroup(dmId, plan.fireAt)) {
    const rng = seededRng(`dmspeak:${dmId}:${plan.fireAt}`);
    const speaker = rng() < 0.5 ? plan.a : plan.b;
    const at = deps.now() + (10 + rng() * 30) * MINUTE;
    await deps.enqueueGroupSpill(plan.groupId, speaker, topic.slice(0, 20), at);
  }
  return true;
}
