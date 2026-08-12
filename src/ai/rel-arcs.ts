/**
 * Things that happen BETWEEN the agents, that you can tell (M-H1).
 *
 * M-E4 gave the cast a social graph: a symmetric edge per pair plus a
 * directional stance, nudged by teases and group turns. It works — and it is
 * completely invisible. The numbers move, the group's phrasing shifts by a
 * degree, and nothing ever crosses the threshold of "something happened
 * between them". A social simulation you cannot perceive is indistinguishable
 * from no social simulation at all.
 *
 * This module reads those same numbers and names the ARC: they had a falling
 * out, they made up, they're thick as thieves, one of them is put out that the
 * other has your attention. Naming it is what lets it be mentioned — in a DM,
 * in the group, in an opener — which is the only way you ever find out.
 *
 * NO SECOND RELATIONSHIP STORE. Everything is derived from the existing edge
 * and stance rows; the only thing persisted is a one-field marker per pair
 * (which arc, since when), because an arc like "they made up" is by definition
 * a TRANSITION and a transition cannot be read off a snapshot.
 */
import { stanceTier, getStance, getAllEdges, pairKey, effectiveAffinity } from './relationship';
import { repo } from '../db/repo';
import { logError } from '../lib/errlog';

const DAY = 86_400_000;

export type ArcKind = 'feud' | 'makeup' | 'alliance' | 'jealousy';

export interface ArcMarker {
  kind: ArcKind;
  /** When this arc was first observed. */
  since: number;
}

/** Everything the derivation looks at. All of it already exists (M-E4). */
export interface PairSignals {
  /** Symmetric closeness of the pair, 0..100. */
  aff: number;
  /** How A currently feels about B, −100..100. */
  stanceAB: number;
  /** How close B has grown to the USER, 0..100. */
  userAffB?: number;
}

/**
 * How long an arc stays worth mentioning.
 *
 * Real news has a shelf life: "他们俩前天吵架了" is conversation, "他们俩上个月
 * 吵过架" is a database. After this the marker still exists (it is what a later
 * `makeup` transitions from) but nothing will bring it up unprompted.
 */
export const ARC_FRESH_MS = 3 * DAY;

/** A feud has to have lasted a day before making up means anything. */
const MAKEUP_MIN_MS = DAY;

/**
 * Which arc these two are in, given where the numbers are now and what they
 * were in before. `null` = nothing worth naming.
 *
 * Pure. The transition cases (`makeup`) are exactly why `prev` is a parameter:
 * "they made up" is not a state you can see in a stance value, it is the shape
 * of a change.
 */
export function deriveArc(
  prev: ArcMarker | undefined,
  sig: PairSignals,
  now: number,
): ArcMarker | null {
  const tier = stanceTier(sig.stanceAB);

  // Making up outranks everything: it is the only arc that expires by being
  // resolved rather than by getting old, and missing it leaves a stale feud
  // colouring the group for as long as the marker survives.
  if (prev?.kind === 'feud' && tier !== 'hostile' && now - prev.since >= MAKEUP_MIN_MS) {
    return { kind: 'makeup', since: now };
  }
  if (tier === 'hostile') {
    // Keep the original `since`: a feud's age is what makes it a feud rather
    // than a bad afternoon.
    return prev?.kind === 'feud' ? prev : { kind: 'feud', since: now };
  }
  // Someone else having your attention only stings if they are not close.
  if ((sig.userAffB ?? 0) >= 70 && tier === 'cool' && sig.aff < 55) {
    return prev?.kind === 'jealousy' ? prev : { kind: 'jealousy', since: now };
  }
  if (sig.aff >= 70 && sig.stanceAB >= 25) {
    return prev?.kind === 'alliance' ? prev : { kind: 'alliance', since: now };
  }
  // A makeup is news, not a state: it fades on its own rather than becoming a
  // permanent label. Everything else that no longer holds simply ends — a feud
  // that cooled off inside a day was a bad afternoon, and calling that a
  // reconciliation would cheapen the ones that are.
  if (prev?.kind === 'makeup') return now - prev.since >= ARC_FRESH_MS ? null : prev;
  return null;
}

/** Is this arc recent enough that a person would still bring it up? */
export function arcFresh(marker: ArcMarker | undefined, now: number): boolean {
  return Boolean(marker && now - marker.since < ARC_FRESH_MS);
}

/**
 * The prompt line, written from A's side about B.
 *
 * Awareness, never instruction — the same discipline as the lifeline and
 * occasion layers. "You two aren't speaking much right now" changes how she
 * answers if the subject comes up; "tell the user you had a fight" produces a
 * character who opens every conversation with a bulletin.
 */
export function arcLine(kind: ArcKind, otherName: string, now: number, since: number): string {
  const days = Math.max(0, Math.floor((now - since) / DAY));
  const when = days === 0 ? '今天' : days === 1 ? '昨天' : `${days}天前`;
  switch (kind) {
    case 'feud':
      return `你和${otherName}${when}闹得不太愉快，现在还没缓过来——提到TA你会有点绕开或带刺，但不会主动到处说。`;
    case 'makeup':
      return `你和${otherName}前阵子闹别扭，${when}算是过去了，现在关系比之前还松快点。`;
    case 'alliance':
      return `你最近和${otherName}特别投缘，聊什么都能接上，也会替TA说话。`;
    case 'jealousy':
      return `你觉得${otherName}最近跟对方走得有点太近了。你不会明说，但心里那点别扭是有的。`;
  }
}

/* ------------------------- storage & derivation ------------------------- */

/**
 * One marker per DIRECTED pair: what A is currently in with B.
 *
 * Directed because the arcs are: B can be perfectly comfortable while A is
 * quietly put out that B has your attention, and collapsing that to one
 * symmetric row would erase the only interesting half.
 */
const arcKey = (a: string, b: string) => `relarc:${a}:${b}`;

export interface PeerRef {
  contactId: string;
  name: string;
}

/**
 * Recompute A's arc with each peer, persisting transitions.
 *
 * One edges read for the whole call rather than one per peer — `getEdge` loads
 * the entire edge map every time, so the naive loop would read the same row
 * five times per turn.
 */
export async function refreshArcs(
  selfId: string,
  peers: PeerRef[],
  now: number,
): Promise<Array<{ peer: PeerRef; marker: ArcMarker }>> {
  const out: Array<{ peer: PeerRef; marker: ArcMarker }> = [];
  try {
    const edges = await getAllEdges(now);
    for (const peer of peers) {
      if (peer.contactId === selfId || peer.contactId === 'self') continue;
      const prev = (await repo.getSetting<ArcMarker>(arcKey(selfId, peer.contactId))) ?? undefined;
      const next = deriveArc(
        prev && typeof prev.since === 'number' ? prev : undefined,
        {
          aff: edges[pairKey(selfId, peer.contactId)]?.aff ?? 0,
          stanceAB: await getStance(selfId, peer.contactId, now),
          // How close this peer has grown to the USER — the input the jealousy
          // arc turns on, and the one number neither agent's own graph holds.
          userAffB: effectiveAffinity(edges[pairKey('self', peer.contactId)], 0),
        },
        now,
      );
      if (JSON.stringify(next) !== JSON.stringify(prev ?? null)) {
        await repo.putSetting(arcKey(selfId, peer.contactId), next);
      }
      if (next) out.push({ peer, marker: next });
    }
  } catch (e) {
    // The social layer is a garnish on every path that uses it; a failure here
    // must never cost a reply.
    logError('relarc.refresh', e);
  }
  return out;
}

/**
 * The prompt block for one actor: what they are currently in with whom.
 *
 * Capped at two. This rides on turns that already carry a persona, a memory
 * selection and a mood — a third line of social briefing starts competing with
 * the character it is attached to.
 */
export async function arcAwareness(
  selfId: string,
  peers: PeerRef[],
  now: number,
  maxLines = 2,
): Promise<string> {
  const arcs = await refreshArcs(selfId, peers, now);
  const lines = arcs
    .slice(0, maxLines)
    .map(({ peer, marker }) => `- ${arcLine(marker.kind, peer.name, now, marker.since)}`);
  return lines.length ? `【最近和其他人之间】\n${lines.join('\n')}` : '';
}

/**
 * The freshest arc worth reaching out about, if any.
 *
 * Used by the proactive path: an agent who just fell out with a mutual friend
 * has an actual reason to message you, which is the difference between a
 * heartbeat and a person.
 */
export async function freshArc(
  selfId: string,
  peers: PeerRef[],
  now: number,
): Promise<{ peer: PeerRef; marker: ArcMarker } | null> {
  const arcs = await refreshArcs(selfId, peers, now);
  const fresh = arcs.filter((a) => arcFresh(a.marker, now));
  if (fresh.length === 0) return null;
  // Newest first: the thing that just happened is the thing you mention.
  fresh.sort((a, b) => b.marker.since - a.marker.since);
  return fresh[0];
}

/**
 * What it does to a Moments post.
 *
 * Never names anyone: people subtweet, they do not file reports. Half of the
 * value of this line is the instruction NOT to explain — a post that spells
 * out what happened reads as exposition, and the ambiguity is exactly what
 * makes the user go and ask about it.
 */
export function arcMomentDirective(kind: ArcKind): string {
  switch (kind) {
    case 'feud':
      return '你今天跟朋友闹得不痛快，心里还有点堵。可以发一条不点名、不解释的——真人不会在朋友圈里指名道姓，也不会把事情讲清楚。';
    case 'makeup':
      return '你和朋友前阵子的别扭过去了，心情松快了不少。';
    case 'alliance':
      return '你最近和一个朋友处得特别好，心情不错。';
    case 'jealousy':
      return '你心里有点酸，但说不出口。写得含蓄一点，别点名，也别解释。';
  }
}

/**
 * The version she would actually SAY to you, as an opener.
 *
 * Separate from `arcLine` on purpose: the prompt line describes an internal
 * state, this one is a reason to message you at all. Only fresh arcs qualify —
 * see ARC_FRESH_MS.
 */
export function arcOpener(kind: ArcKind, otherName: string): string {
  switch (kind) {
    case 'feud':
      return `你和${otherName}闹了点不愉快，心里还堵着。你想找对方说说，但别一上来就控诉——` +
        '先聊别的，或者半句带过，看对方接不接。';
    case 'makeup':
      return `你和${otherName}和好了，心情松快。可以顺口跟对方提一句。`;
    case 'alliance':
      return `你最近和${otherName}处得很好，有件小事想跟对方分享。`;
    case 'jealousy':
      return `你有点在意${otherName}和对方的走动。别质问——酸一句、或者干脆多找对方说说话。`;
  }
}
