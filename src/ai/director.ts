/**
 * Group-chat director. Decides WHO speaks next and in what order; the actors
 * (personas) then write the actual lines.
 *
 * Two layers, on purpose:
 *  1. `prefilter` — pure code, <1ms. Handles the obvious cases (someone was @'d,
 *     everyone is asleep, only one plausible speaker) so we skip an LLM round-trip
 *     in ~half of all turns. This is what keeps the first reply under ~3s.
 *  2. `callDirector` — one cheap LLM call, only when the situation is genuinely
 *     ambiguous (≥2 plausible speakers). Returns a speaking plan.
 *
 * Everything in layer 1 is deterministic (seeded RNG) so a turn can be replayed.
 */
import { z } from 'zod';
import { redactForTier } from '../lib/nsfw-tier';
import { renderTranscript } from './render-msg';
import type { MessageVM, PersonaVM } from '../data/types';
import type { LlmRouter, NsfwTier } from '../llm/router';
import { seededRng } from '../lib/money';

/** A group member the director can choose from. `persona` may be missing. */
export interface GroupMember {
  contactId: string;
  name: string;
  persona?: PersonaVM;
}

export type SpeakIntent = 'reply' | 'follow' | 'disagree' | 'newtopic' | 'wrapup' | 'sticker_only';

export interface SpeakerPlan {
  agentId: string;
  /** Playback order; 1 speaks first. */
  priority: number;
  intent: SpeakIntent;
  /** Who they're speaking to ('user' or another agentId). */
  target?: string;
  /** ≤20-char direction for the actor — a hint, never the actual line. */
  hint?: string;
}

export interface PrefilterResult {
  mode: 'silence' | 'direct' | 'director';
  /** Members eligible to speak, after cooldown/active-hours/streak filtering. */
  candidates: GroupMember[];
  /** For mode==='direct', the speakers to run immediately (skipping the director). */
  speakers: SpeakerPlan[];
  reason: string;
}

export interface PrefilterOptions {
  /** A member who spoke within this window is on cooldown. */
  cooldownMs?: number;
  /** Max consecutive messages from one member before they're forced to yield. */
  maxStreak?: number;
  /** How many recent messages to consider for streak/cooldown. */
  window?: number;
}

const DEFAULTS = { cooldownMs: 45_000, maxStreak: 3, window: 12 };

/** Members explicitly @'d in a message body, matched by display name. */
export function findMentions(text: string, members: GroupMember[]): GroupMember[] {
  if (!text.includes('@')) return [];
  return members.filter((m) => text.includes(`@${m.name}`));
}

/** Local hour helper — active windows may wrap past midnight (e.g. [14, 26]). */
function isActive(persona: PersonaVM | undefined, now: number): boolean {
  if (!persona) return false;
  const h = new Date(now).getHours();
  return persona.activeHours.some(([start, end]) =>
    end <= 24 ? h >= start && h < end : h >= start || h < end - 24,
  );
}

/**
 * Decide, without any LLM call, whether anyone speaks and whether the director
 * is needed. Pure and deterministic given (members, recent, now, seed).
 */
export function prefilter(
  members: GroupMember[],
  recent: MessageVM[],
  now: number,
  seed: string,
  opts: PrefilterOptions = {},
): PrefilterResult {
  const { cooldownMs, maxStreak, window } = { ...DEFAULTS, ...opts };
  const tail = recent.slice(-window);
  const lastMsg = recent[recent.length - 1];

  // A member with no persona card can't act — skip rather than crash.
  const withPersona = members.filter((m) => m.persona);

  // 1) Explicit @mention wins outright: they must answer, no director needed.
  const mentioned = lastMsg?.content ? findMentions(lastMsg.content, withPersona) : [];
  if (mentioned.length > 0) {
    return {
      mode: 'direct',
      candidates: mentioned,
      speakers: mentioned.slice(0, 2).map((m, i) => ({
        agentId: m.contactId,
        priority: i + 1,
        intent: 'reply' as const,
        target: 'user',
      })),
      reason: 'mentioned',
    };
  }

  // 2) Filter out anyone asleep, on cooldown, or hogging the conversation.
  const candidates = withPersona.filter((m) => {
    if (!isActive(m.persona, now)) return false;
    const lastSpoke = [...tail].reverse().find((x) => x.senderId === m.contactId);
    if (lastSpoke && now - lastSpoke.createdAt < cooldownMs) return false;
    const streak = countTrailingStreak(tail, m.contactId);
    if (streak >= maxStreak) return false;
    return true;
  });

  if (candidates.length === 0) {
    return { mode: 'silence', candidates, speakers: [], reason: 'no-eligible-members' };
  }

  // 3) Exactly one plausible speaker → roll their proactivity; no director needed.
  if (candidates.length === 1) {
    const only = candidates[0];
    const rng = seededRng(`${seed}:${only.contactId}`);
    const speaks = rng() < (only.persona?.proactivity ?? 0.5) + 0.35; // biased toward replying
    return speaks
      ? {
          mode: 'direct',
          candidates,
          speakers: [{ agentId: only.contactId, priority: 1, intent: 'reply', target: 'user' }],
          reason: 'single-candidate',
        }
      : { mode: 'silence', candidates, speakers: [], reason: 'single-candidate-declined' };
  }

  // 4) Genuinely ambiguous → let the director stage it.
  return { mode: 'director', candidates, speakers: [], reason: 'ambiguous' };
}

/** How many messages at the tail were consecutively from this sender. */
function countTrailingStreak(tail: MessageVM[], contactId: string): number {
  let n = 0;
  for (let i = tail.length - 1; i >= 0; i--) {
    if (tail[i].senderId === contactId) n++;
    else break;
  }
  return n;
}

/* ---------------- Director LLM call ---------------- */

const SpeakerSchema = z.object({
  agentId: z.string(),
  priority: z.number().int().min(1).max(9).optional(),
  intent: z
    .enum(['reply', 'follow', 'disagree', 'newtopic', 'wrapup', 'sticker_only'])
    .optional(),
  target: z.string().optional(),
  hint: z.string().optional(),
});

const DecisionSchema = z.object({
  silence: z.boolean().optional(),
  topicState: z.string().optional(),
  speakers: z.array(SpeakerSchema).optional(),
});

export interface DirectorDecision {
  silence: boolean;
  topicState?: string;
  speakers: SpeakerPlan[];
}

const DIRECTOR_SYSTEM = `你是群聊导演，只负责调度，不写台词。
根据最近的聊天和成员性格，决定这一轮谁开口、按什么顺序。
规则：
- 最多选 2-3 人；与话题最相关的人优先。
- 允许没人说话（冷场也是真实的）——这时 silence 为 true。
- 刚连续发过言的人降权。
- hint 是给演员的方向提示（不超过 20 字），绝不能是台词原文。
只输出 JSON：
{"silence":false,"topicState":"当前话题一句话",
 "speakers":[{"agentId":"...","priority":1,"intent":"reply|follow|disagree|newtopic|wrapup|sticker_only","target":"user|agentId","hint":"..."}]}`;

export interface DirectorContext {
  candidates: GroupMember[];
  recent: MessageVM[];
  /** Display-name lookup for rendering the transcript. */
  nameOf: (senderId: string) => string;
  /** Last round's topicState — the group remembers what it was talking about. */
  prevTopic?: string;
  /** One line of social intel, e.g. "小雨和阿哲走得近" (derived from edges). */
  cliqueLine?: string;
  /**
   * Effective tier of the transcript being sent. The director quotes the last
   * 20 group messages verbatim, so declaring 'off' for a full-tier group routed
   * explicit text to a domestic endpoint (constitution rule #6). Callers derive
   * it from the members' permits; above 'off' the transcript is also redacted —
   * casting decisions need who-said-roughly-what, never the words themselves.
   */
  tier?: NsfwTier;
}

/**
 * Ask the director who should speak. Never throws: on any failure (network,
 * refusal, unparseable JSON) it degrades to "the single most relevant speaker",
 * because a silent broken group is worse than a slightly wrong casting choice.
 */
export async function callDirector(
  router: LlmRouter,
  ctx: DirectorContext,
  convId: string,
  signal?: AbortSignal,
): Promise<DirectorDecision> {
  const roster = ctx.candidates
    .map((m) => `- ${m.contactId} | ${m.name} | ${m.persona?.core?.slice(0, 40) ?? ''}`)
    .join('\n');
  const tier = ctx.tier ?? 'off';
  const tail = ctx.recent.slice(-20);
  // Above 'off' the words never leave in full: redaction keeps the routing
  // decision honest even if a permissive channel is unavailable.
  const transcript =
    tier === 'off'
      ? renderTranscript(tail, { nameOf: ctx.nameOf, maxChars: 120 })
      : redactForTier(tail, ctx.nameOf);
  const extras = [
    ctx.prevTopic ? `【上次话题】${ctx.prevTopic}` : '',
    ctx.cliqueLine ? `【关系】${ctx.cliqueLine}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const res = await router.complete(
      { role: 'director', nsfwTier: tier },
      {
        messages: [
          { role: 'system', content: DIRECTOR_SYSTEM },
          {
            role: 'user',
            content: `【成员】\n${roster}\n${extras ? `${extras}\n` : ''}\n【最近对话】\n${transcript}`,
          },
        ],
        json: true,
        temperature: 0.6,
        maxTokens: 400,
        signal,
      },
      {},
      `director:${convId}`,
    );
    return parseDecision(res.text, ctx.candidates);
  } catch {
    return fallbackDecision(ctx.candidates);
  }
}

/** Parse + repair the director's JSON. Exported for unit testing. */
export function parseDecision(text: string, candidates: GroupMember[]): DirectorDecision {
  const valid = new Set(candidates.map((c) => c.contactId));
  try {
    const body = text
      .replace(/^\s*```(?:json)?\s*/i, '')
      .replace(/\s*```\s*$/i, '')
      .trim();
    const parsed = DecisionSchema.parse(JSON.parse(body));
    if (parsed.silence) return { silence: true, topicState: parsed.topicState, speakers: [] };

    const speakers = (parsed.speakers ?? [])
      .filter((s) => valid.has(s.agentId)) // drop hallucinated members
      .slice(0, 3)
      .map((s, i) => ({
        agentId: s.agentId,
        priority: s.priority ?? i + 1,
        intent: s.intent ?? ('reply' as SpeakIntent),
        target: s.target,
        hint: s.hint,
      }))
      .sort((a, b) => a.priority - b.priority);

    if (speakers.length === 0) return fallbackDecision(candidates);
    return { silence: false, topicState: parsed.topicState, speakers };
  } catch {
    return fallbackDecision(candidates);
  }
}

/** Degradation: pick one speaker rather than going silent on a parse failure. */
function fallbackDecision(candidates: GroupMember[]): DirectorDecision {
  if (candidates.length === 0) return { silence: true, speakers: [] };
  const pick = [...candidates].sort(
    (a, b) => (b.persona?.proactivity ?? 0) - (a.persona?.proactivity ?? 0),
  )[0];
  return {
    silence: false,
    speakers: [{ agentId: pick.contactId, priority: 1, intent: 'reply', target: 'user' }],
  };
}
