/**
 * Moments (朋友圈): AI posts, and the staggered likes/comments that follow one.
 *
 * The believability of the feed rests entirely on *timing*. Real friends don't
 * all like your post the instant you publish it — they trickle in over hours, in
 * no particular order, and most of them never comment at all. So the planning
 * here is deliberately separated from the LLM calls: `planReactions()` and
 * `nextMomentAt()` are pure, seeded, and unit-tested; the generators are the only
 * parts that touch the network.
 *
 * Moments are unconditionally SFW (constitution rule #6 / specs/nsfw.md): the
 * feed is a shared surface, so nothing here ever raises the NSFW tier.
 */
import type { PersonaVM, ContactVM, MomentVM } from '../data/types';
import { seededRng } from '../lib/money';
import { assembleSystemPrompt } from './prompt';
import { toPersonaView } from './engine';
import { selectFactsForInjection } from './memory';
import { getRouter } from '../llm/service';
import { pickImages } from '../data/moments-images';
import { isActiveAt } from './heartbeat';
import { agentEpoch, goalStateAt, goalMomentMaterial } from './goals';
import { getAllEdges, pairKey, effectiveAffinity } from './relationship';
import { repo } from '../db/repo';

const MINUTE = 60_000;
const HOUR = 3_600_000;

/** A planned reaction to a moment — materialized into `scheduled_actions`. */
export interface PlannedReaction {
  kind: 'moment_like' | 'moment_comment';
  contactId: string;
  momentId: string;
  at: number;
}

/** What the planner needs to know about a potential reactor. */
export interface ReactorInfo {
  contactId: string;
  likeRate: number; // 0..1
  commentRate: number; // 0..1
  affinity: number; // 0..100
  activeHours: Array<[number, number]>;
}

/** Likes trickle in over this window; comments take longer (they take thought). */
const LIKE_WINDOW = 2 * HOUR;
const COMMENT_WINDOW = 4 * HOUR;
const MIN_LIKE_DELAY = MINUTE;
const MIN_COMMENT_DELAY = 3 * MINUTE;

/**
 * Decide who reacts to a moment and when. Pure and seeded: the same moment
 * always draws the same crowd, so a replayed or backfilled timeline is stable.
 *
 * Affinity scales the base rates — someone close to you is likelier to engage.
 * A commenter always likes first if they were also going to like, and their
 * comment lands after that like, which is what real ordering looks like.
 *
 * @param authorId who posted (never reacts to their own post)
 * @param postedAt when the moment was published
 */
export function planReactions(
  momentId: string,
  authorId: string,
  postedAt: number,
  reactors: ReactorInfo[],
  seed: string,
): PlannedReaction[] {
  const out: PlannedReaction[] = [];
  for (const r of reactors) {
    if (r.contactId === authorId) continue;
    const rng = seededRng(`${seed}:${momentId}:${r.contactId}`);
    // Affinity 0→0.6x, 50→1.0x, 100→1.4x of the persona's base rate.
    const affinityScale = 0.6 + (r.affinity / 100) * 0.8;
    const willLike = rng() < r.likeRate * affinityScale;
    const willComment = rng() < r.commentRate * affinityScale;
    if (!willLike && !willComment) continue;

    const likeAt = postedAt + MIN_LIKE_DELAY + rng() * LIKE_WINDOW;
    if (willLike) {
      out.push({
        kind: 'moment_like',
        contactId: r.contactId,
        momentId,
        at: settle(likeAt, r.activeHours),
      });
    }
    if (willComment) {
      // Comment after their own like, so the ordering reads naturally.
      const floor = willLike ? likeAt : postedAt + MIN_COMMENT_DELAY;
      const commentAt = floor + MIN_COMMENT_DELAY + rng() * COMMENT_WINDOW;
      out.push({
        kind: 'moment_comment',
        contactId: r.contactId,
        momentId,
        at: settle(commentAt, r.activeHours),
      });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/**
 * Nudge a reaction time forward until it lands in one of the reactor's waking
 * hours — nobody likes your post at 4am. Gives up after 48 hourly steps and
 * returns the original, rather than looping forever on a malformed window.
 */
function settle(ts: number, activeHours: Array<[number, number]>): number {
  if (!activeHours.length) return Math.round(ts);
  const fake = { activeHours } as PersonaVM;
  let t = ts;
  for (let i = 0; i < 48; i++) {
    if (isActiveAt(fake, t)) return Math.round(t);
    t += HOUR;
  }
  return Math.round(ts);
}

/**
 * When should this persona next post? Driven by `momentsPerDay` (a rate, not a
 * count), so a 0.3/day persona posts roughly twice a week at unpredictable times.
 * Returns null if the persona never posts.
 */
export function nextMomentAt(persona: PersonaVM, from: number): number | null {
  if (persona.momentsPerDay <= 0) return null;
  const rng = seededRng(`moment:${persona.contactId}:${Math.floor(from / 86_400_000)}`);
  const meanGapMs = 86_400_000 / persona.momentsPerDay;
  // Exponential-ish spacing so posts cluster and gap like real ones do.
  const gap = meanGapMs * (0.4 + rng() * 1.2);
  let t = from + gap;
  for (let i = 0; i < 48 && !isActiveAt(persona, t); i++) t += HOUR;
  return Math.round(t);
}

/** Reactor info for every AI contact that has a persona. */
export async function collectReactors(
  contacts: ContactVM[],
  personaFor: (id: string) => PersonaVM | undefined,
  now?: number,
): Promise<ReactorInfo[]> {
  // Live relationship edges (M-D1): a friend you've warmed up to likes your
  // posts more often than their static card said they would.
  const edges = now != null ? await getAllEdges(now) : {};
  const out: ReactorInfo[] = [];
  for (const c of contacts) {
    if (c.type !== 'ai') continue;
    const p = personaFor(c.id);
    if (!p) continue;
    out.push({
      contactId: c.id,
      likeRate: p.likeRate,
      commentRate: p.commentRate,
      affinity: effectiveAffinity(edges[pairKey('self', c.id)], p.affinityInit),
      activeHours: p.activeHours,
    });
  }
  return out;
}

/** Strip model formatting habits that would look wrong in a feed post. */
function cleanPostText(raw: string): string {
  return raw
    .replace(/^```[a-z]*\n?|```$/g, '')
    .replace(/^["'“”]|["'“”]$/g, '')
    .trim()
    .split('\n')
    .slice(0, 4)
    .join('\n')
    .slice(0, 200);
}

/**
 * Write one Moments post in the persona's voice, drawing on what they remember.
 * Returns null if generation fails — a missing post is invisible, whereas a
 * broken one is not, so failure is silent by design.
 */
export async function generateMomentPost(
  persona: PersonaVM,
  peer: ContactVM,
  now: number,
): Promise<{ text: string; imageRefs: string[] } | null> {
  const facts = await repo.getMemory(peer.id);
  // Moments are unconditionally SFW (constitution #6), so the surface is
  // declared and the tier pinned at 'off' — not left to the default.
  const memory = selectFactsForInjection(facts, now, { surface: 'moments', tier: 'off' });
  const system = assembleSystemPrompt({
    persona: toPersonaView(persona, peer.remark ?? peer.name),
    nsfwTier: 'off', // constitution #6: Moments are never NSFW
    memory: memory.pinned.length || memory.topK.length ? memory : undefined,
    scene: { kind: 'single', now: new Date(now) },
  });
  const rng = seededRng(`mp:${peer.id}:${now}`);
  const imgCount = rng() < 0.45 ? 0 : rng() < 0.6 ? 1 : rng() < 0.85 ? 3 : 4;

  // Goal-arc material (M-I14): a fresh milestone or a completed goal sometimes
  // becomes the post. Seeded gate inside — the feed must not turn into a
  // progress log, so this is empty most of the time.
  const goal = goalStateAt(peer.id, now, agentEpoch(peer.id));
  const goalBg = goalMomentMaterial(goal, now, `${peer.id}:${now}`);

  try {
    const router = await getRouter();
    const res = await router.complete(
      { role: 'chat', nsfwTier: 'off' },
      {
        messages: [
          { role: 'system', content: system },
          {
            role: 'user',
            content:
              '写一条你现在会发的朋友圈。要求：' +
              '1) 第一人称，像真人随手发的，不是作文；' +
              '2) 40 字以内，可以只有一句话，允许口语和不完整句；' +
              '3) 不要话题标签、不要 emoji 堆砌、不要"分享一下"这类开场白；' +
              '4) 只输出正文，不要引号、不要解释。' +
              (goalBg ? `\n背景（不要照抄原句）：${goalBg}` : ''),
          },
        ],
      },
    );
    const text = cleanPostText(res.text ?? '');
    if (!text) return null;
    return { text, imageRefs: pickImages(`mi:${peer.id}:${now}`, imgCount, persona.imageTags) };
  } catch {
    return null;
  }
}

/**
 * Write a comment reacting to a specific post. The prompt pins the post text in
 * so the comment engages with what was actually said instead of emitting a
 * generic "说得好" — that specificity is the whole point of the feature.
 */
export async function generateMomentComment(
  persona: PersonaVM,
  commenter: ContactVM,
  moment: MomentVM,
  authorName: string,
  now: number,
): Promise<string | null> {
  const system = assembleSystemPrompt({
    persona: toPersonaView(persona, commenter.remark ?? commenter.name),
    nsfwTier: 'off',
    scene: { kind: 'single', now: new Date(now) },
  });
  try {
    const router = await getRouter();
    const res = await router.complete(
      { role: 'chat', nsfwTier: 'off' },
      {
        messages: [
          { role: 'system', content: system },
          {
            role: 'user',
            content:
              `${authorName} 发了一条朋友圈：「${moment.text ?? '[图片]'}」\n` +
              '用你的语气评论一句。要求：20 字以内，必须针对这条内容本身，' +
              '不要客套话、不要复述原文、只输出评论正文。',
          },
        ],
      },
    );
    const text = cleanPostText(res.text ?? '').slice(0, 40);
    return text || null;
  } catch {
    return null;
  }
}
