/**
 * Relationship evolution engine (M-D1). Activates the long-dormant
 * relationship-edge concept: every meaningful interaction nudges a
 * (familiarity, affinity) edge, and the edge feeds back into heartbeat pacing,
 * opener warmth, the prompt's relation register, and Moments like/comment odds.
 *
 * Pure-code, zero LLM. Edges live in the settings store under one key
 * (`rel_edges`) — a handful of pairs in a personal app doesn't justify a new
 * object store (and the DB_VERSION ceremony that entails).
 *
 * Determinism: decay is a pure function of elapsed whole days — no wall-clock
 * reads in the math, no randomness. Same events at the same timestamps always
 * produce the same edge (backfill/replay safe, rule #4).
 */
import { repo } from '../db/repo';

export interface RelEdge {
  /** 0..100, monotonically non-decreasing — you can't un-know someone. */
  fam: number;
  /** 0..100, bounded, drifts 10%/day back toward `baseline`. */
  aff: number;
  /** Long-run resting affinity (seeded from persona.affinityInit). */
  baseline: number;
  /** Day bucket the last decay was applied for (lazy decay bookkeeping). */
  day: number;
}

export type RelEventKind =
  | 'user_reply' // the user answered this AI
  | 'group_chat' // exchanged words in a group round
  | 'rp_received' // received a red packet from the other side
  | 'transfer_received' // received (accepted) a transfer
  | 'moment_liked' // the other side liked my post
  | 'teased' // the director staged a disagree/tease at me
  | 'dm_gossip'; // shared an AI↔AI DM session

export const REL_SCORES: Record<RelEventKind, { fam: number; aff: number }> = {
  user_reply: { fam: 1, aff: 0.5 },
  group_chat: { fam: 0.3, aff: 0 },
  rp_received: { fam: 1, aff: 3 },
  transfer_received: { fam: 1, aff: 3 },
  moment_liked: { fam: 0.5, aff: 1 },
  teased: { fam: 0.5, aff: -2 },
  dm_gossip: { fam: 1, aff: 0.5 },
};

const DAY_MS = 86_400_000;
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Canonical undirected pair key — 'self' sorts like any other id. */
export function pairKey(a: string, b: string): string {
  return [a, b].sort().join('~');
}

export function makeEdge(baseline: number, now: number): RelEdge {
  return { fam: 0, aff: baseline, baseline, day: Math.floor(now / DAY_MS) };
}

/** Apply lazy daily decay: aff drifts 10%/day toward baseline. Pure. */
export function decayEdge(edge: RelEdge, now: number): RelEdge {
  const today = Math.floor(now / DAY_MS);
  const days = today - edge.day;
  if (days <= 0) return edge;
  const aff = edge.baseline + (edge.aff - edge.baseline) * Math.pow(0.9, days);
  return { ...edge, aff, day: today };
}

/** Decay-then-score. Pure; exported for unit tests. */
export function applyRelEvent(edge: RelEdge, kind: RelEventKind, now: number): RelEdge {
  const decayed = decayEdge(edge, now);
  const s = REL_SCORES[kind];
  return {
    ...decayed,
    fam: clamp(decayed.fam + s.fam, 0, 100),
    aff: clamp(decayed.aff + s.aff, 0, 100),
  };
}

/* ---------------- persistence (settings-backed, serialized writes) ---------------- */

type EdgeMap = Record<string, RelEdge>;
const SETTINGS_KEY = 'rel_edges';

// Read-modify-write on one settings row: serialize through a chain so two
// near-simultaneous events can't drop each other's update.
let writeChain: Promise<unknown> = Promise.resolve();

async function loadEdges(): Promise<EdgeMap> {
  return (await repo.getSetting<EdgeMap>(SETTINGS_KEY)) ?? {};
}

/**
 * THE single entry point for relationship events (constitution-style rule for
 * this module: scattered ad-hoc edge writes are how scoring silently drifts).
 * `baseline` seeds a new edge (pass persona.affinityInit when you have it).
 */
export function recordRelEvent(
  a: string,
  b: string,
  kind: RelEventKind,
  now: number,
  baseline = 20,
): Promise<void> {
  const run = async () => {
    if (a === b) return;
    const edges = await loadEdges();
    const key = pairKey(a, b);
    const edge = edges[key] ?? makeEdge(baseline, now);
    edges[key] = applyRelEvent(edge, kind, now);
    await repo.putSetting(SETTINGS_KEY, edges);
  };
  const p = writeChain.then(run, run);
  writeChain = p.catch(() => {});
  return p;
}

/** Current (decayed) edge, or undefined if the pair never interacted. */
export async function getEdge(a: string, b: string, now: number): Promise<RelEdge | undefined> {
  const edges = await loadEdges();
  const edge = edges[pairKey(a, b)];
  return edge ? decayEdge(edge, now) : undefined;
}

/** All decayed edges — the group director's clique detection reads this. */
export async function getAllEdges(now: number): Promise<Record<string, RelEdge>> {
  const edges = await loadEdges();
  const out: Record<string, RelEdge> = {};
  for (const [k, e] of Object.entries(edges)) out[k] = decayEdge(e, now);
  return out;
}

/* ---------------- feedback surfaces ---------------- */

/** Effective affinity for behavior scaling: the live edge, else the persona's constant. */
export function effectiveAffinity(edge: RelEdge | undefined, affinityInit: number): number {
  return edge ? edge.aff : affinityInit;
}

export type RelationTier = 'stranger' | 'familiar' | 'close';

export function relationTier(aff: number): RelationTier {
  if (aff >= 65) return 'close';
  if (aff >= 30) return 'familiar';
  return 'stranger';
}

/** One register line appended to the prompt's relation layer (never a new layer). */
export function tierDirective(tier: RelationTier): string {
  switch (tier) {
    case 'close':
      return '你们已经很熟了：说话随意、亲近，可以开玩笑、用简称，不需要客套。';
    case 'familiar':
      return '你们正在熟起来：语气自然友好，偶尔主动分享自己的事。';
    default:
      return '你们还不算熟：友好但保留一点分寸，不过分自来熟。';
  }
}

/**
 * Heartbeat pacing multiplier: closer → reaches out sooner. Normalized so the
 * default affinity (20) is ×1.0 — activating the engine must not change pacing
 * for archives that never interacted (backfill replay parity).
 * aff 0 → ×1.067, aff 20 → ×1.0, aff 100 → ×0.73.
 */
export function heartbeatAffinityMul(aff: number): number {
  return (1.6 - aff / 200) / 1.5;
}

/* ==================================================================== */
/* Directional stance (M-E4)                                             */
/* ==================================================================== */

/**
 * `pairKey` is symmetric, and deliberately stays that way — the edge is a bond,
 * and bonds are mutual. But a slight is not: when the director stages 阿哲
 * disagreeing with 小雨, it is 小雨 who has been needled, and 阿哲 who did the
 * needling. Recording that as a symmetric `teased` cooled BOTH sides equally,
 * which reads as "everyone drifts apart whenever anyone is teased".
 *
 * Stance is the directional half, kept in its own settings rows so the existing
 * `pairKey` format is untouched (a migration there would be destructive and
 * would break `.aiwx` rollback — guardrail G7).
 */
export interface Stance {
  /** How `from` currently feels about `to`: −100 … +100. */
  value: number;
  /** Day bucket of the last decay pass. */
  day: number;
}

const STANCE_PREFIX = 'stance:';
const STANCE_DECAY_PER_DAY = 0.12;

function stanceKey(from: string, to: string): string {
  return `${STANCE_PREFIX}${from}:${to}`;
}

/** Stance decays toward neutral: nobody stays annoyed forever. Pure. */
export function decayStance(s: Stance, now: number): Stance {
  const day = Math.floor(now / DAY_MS);
  const days = Math.max(0, day - s.day);
  if (days === 0) return s;
  return { value: s.value * Math.pow(1 - STANCE_DECAY_PER_DAY, days), day };
}

export async function getStance(from: string, to: string, now: number): Promise<number> {
  try {
    const row = await repo.getSetting<Stance>(stanceKey(from, to));
    if (!row || typeof row.value !== 'number') return 0;
    return decayStance(row, now).value;
  } catch {
    return 0;
  }
}

/** Nudge how `from` feels about `to`. Directional and one-way by construction. */
export async function recordStance(
  from: string,
  to: string,
  delta: number,
  now: number,
): Promise<void> {
  if (from === to) return;
  try {
    const row = (await repo.getSetting<Stance>(stanceKey(from, to))) ?? {
      value: 0,
      day: Math.floor(now / DAY_MS),
    };
    const decayed = decayStance(row, now);
    await repo.putSetting(stanceKey(from, to), {
      value: clamp(decayed.value + delta, -100, 100),
      day: Math.floor(now / DAY_MS),
    });
  } catch {
    /* social bookkeeping is a nicety; never break a turn over it */
  }
}

/**
 * Being needled in front of everyone, recorded ONE-WAY.
 *
 * The needler loses nothing; the needled cools toward them. That asymmetry is
 * what lets a group develop actual dynamics instead of uniformly drifting apart.
 */
export async function recordTease(
  teaser: string,
  target: string,
  now: number,
): Promise<void> {
  await recordStance(target, teaser, REL_SCORES.teased.aff * 3, now);
}

export type StanceTier = 'hostile' | 'cool' | 'neutral' | 'warm';

export function stanceTier(value: number): StanceTier {
  if (value <= -35) return 'hostile';
  if (value <= -12) return 'cool';
  if (value >= 25) return 'warm';
  return 'neutral';
}

/**
 * How this actor should carry themselves toward the OTHER members, as one short
 * line for the prompt's relation layer.
 *
 * This is the payoff of the whole social layer: two agents who argued last week
 * pick each other up differently in the group today, and you can tell. Capped
 * hard — the tail of the prompt is a token budget, and a long social briefing
 * dilutes the persona it is attached to (guardrails G3/G10).
 */
export async function describePeerEdges(
  selfId: string,
  peers: Array<{ contactId: string; name: string }>,
  now: number,
  maxLines = 3,
): Promise<string> {
  const lines: string[] = [];
  for (const p of peers) {
    if (p.contactId === selfId) continue;
    const value = await getStance(selfId, p.contactId, now);
    const tier = stanceTier(value);
    if (tier === 'neutral') continue; // saying "you feel normal about X" is noise
    const how =
      tier === 'hostile'
        ? `你现在挺不待见${p.name}，接话会绕开或带刺`
        : tier === 'cool'
          ? `你对${p.name}有点疙瘩，没到翻脸，但不太想接他的话`
          : `你和${p.name}最近挺投缘，容易接住对方的话`;
    lines.push(`- ${how}`);
    if (lines.length >= maxLines) break;
  }
  return lines.length ? `【你和群里其他人】\n${lines.join('\n')}` : '';
}
