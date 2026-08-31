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
import { canSeeMoment } from '../lib/moment-visibility';
import { assembleSystemPrompt } from './prompt';
import { toPersonaView, peersOf } from './engine';
import { freshArc, arcMomentDirective, aboutYouDirective } from './rel-arcs';
import { driftedPersona } from './drift';
import { selectFactsForInjection } from './memory';
import { getRouter } from '../llm/service';
import { pickImages } from '../data/moments-images';
import { isActiveAt } from './heartbeat';
import { agentEpoch, goalStateAt, goalMomentMaterial, type GoalDomain, type GoalState } from './goals';
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

/**
 * The slice of a post the planners read.
 *
 * Deliberately an OBJECT rather than the loose `(id, authorId, postedAt)` triple
 * these functions used to take: `visibility` has to travel with the post to
 * every planner, and a fourth positional argument is a thing callers forget.
 * With the row itself as the parameter, the type system carries the audience in
 * and「她评论了一条你设置成不给她看的动态」stops being reachable by omission.
 */
export type PlannablePost = Pick<MomentVM, 'id' | 'authorId' | 'createdAt' | 'visibility'>;

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
 * 可见范围 (M-I18): anyone the post is not visible to is dropped BEFORE the dice
 * are rolled, so a restricted post plans exactly zero reactions for them. This
 * is the single most important consequence of the whole audience feature — a
 * like from someone you excluded is an instant, irreversible tell.
 */
export function planReactions(
  post: PlannablePost,
  reactors: ReactorInfo[],
  seed: string,
): PlannedReaction[] {
  const { id: momentId, authorId, createdAt: postedAt } = post;
  const out: PlannedReaction[] = [];
  for (const r of reactors) {
    if (r.contactId === authorId) continue;
    if (!canSeeMoment(post, r.contactId)) continue;
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
    const base = personaFor(c.id);
    if (!base) continue;
    // As she is NOW, not as the card was written (M-H1): months of being
    // ignored make someone engage less, and the rates are where that shows.
    const p = now != null ? await driftedPersona(base, now) : base;
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

/* --------------------------- AI reposts (M-I15) --------------------------- */

/** A planned repost of a USER post — materialized as a `moment_repost` action. */
export interface PlannedRepost {
  contactId: string;
  at: number;
}

/**
 * How often a user post attracts a repost at all. A repost is a much bigger
 * gesture than a like — someone putting YOUR words on THEIR wall — so it must
 * stay rare enough that each one lands as an event.
 */
export const REPOST_RATE = 0.08;

/** Only genuinely close friends repost; casual ones like and move on. */
export const REPOST_MIN_AFFINITY = 55;

/**
 * At most one friend reposts this post, seeded and rare. USER posts only:
 * agents boosting each other is feed noise, while a friend amplifying *you*
 * is the moment the 转发 feature exists for. The reposter's text and quote
 * are produced later through `moment-repost.ts`'s storage-re-read path, so
 * this planner decides WHO and WHEN, never WHAT.
 *
 * 可见范围 (M-I18): a repost puts your words on SOMEONE ELSE's wall, in front of
 * an audience you never chose — so a restricted post is not merely unlikely to
 * be reposted, it is ineligible. Both the "can she see it" filter on candidates
 * and the outright refusal below matter: the second is what stops a 部分可见
 * post from being republished to everyone by the one person who could see it.
 */
export function planRepost(
  post: PlannablePost,
  reactors: ReactorInfo[],
  seed: string,
): PlannedRepost | null {
  const { id: momentId, authorId, createdAt: postedAt } = post;
  if (authorId !== 'self') return null;
  // Anything with an audience stays where the user put it. Republishing is the
  // one reaction that cannot be un-seen.
  if (post.visibility && post.visibility.mode !== 'public') return null;
  const rng = seededRng(`${seed}:repost:${momentId}`);
  if (rng() >= REPOST_RATE) return null;
  const eligible = reactors.filter(
    (r) =>
      r.contactId !== authorId &&
      r.affinity >= REPOST_MIN_AFFINITY &&
      canSeeMoment(post, r.contactId),
  );
  if (eligible.length === 0) return null;
  const who = eligible[Math.floor(rng() * eligible.length)];
  // Later than a like would land: sharing takes deciding it's worth sharing.
  const at = settle(postedAt + 30 * MINUTE + rng() * 6 * HOUR, who.activeHours);
  return { contactId: who.contactId, at };
}

/**
 * The reposter's own line above the quote card. One short LLM call; empty
 * string on failure — a wordless repost is a perfectly normal repost, so this
 * degrades to silence rather than to a lost action.
 */
export async function generateRepostText(
  persona: PersonaVM,
  reposter: ContactVM,
  moment: MomentVM,
  now: number,
): Promise<string> {
  const system = assembleSystemPrompt({
    persona: toPersonaView(persona, reposter.remark ?? reposter.name),
    nsfwTier: 'off', // constitution #6: Moments are never NSFW
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
              `你朋友发了条朋友圈：「${moment.text ?? '[图片]'}」，你想转发到自己的朋友圈。\n` +
              '写一句你转发时的配文。要求：15 字以内、你的语气、' +
              '不复述原文、只输出配文本身。',
          },
        ],
      },
    );
    return cleanPostText(res.text ?? '').slice(0, 40);
  } catch {
    return '';
  }
}

/* ---------------------- topic tags & goal series (M-I15) ---------------------- */

/**
 * Tags a persona might plausibly hang on a post. Small on purpose: a topic
 * page needs REPEAT hits to feel like a topic, and a hundred-tag pool would
 * scatter every post into its own bucket. Goal-domain tags come first so a
 * study-arc post tends to tag its own storyline.
 */
export const TOPIC_POOLS: Record<GoalDomain, string[]> = {
  study: ['备考日记', '学习打卡'],
  money: ['攒钱计划', '旅行基金'],
  romance: ['恋爱脑', '心动瞬间'],
  health: ['减肥日常', '自律打卡'],
  career: ['打工人', '搞钱要紧'],
  skill: ['厨房翻车现场', '今日份手艺'],
};

/** Everyday tags for posts with no goal storyline behind them. */
export const GENERIC_TOPICS = ['日常', '碎碎念', '深夜emo', '干饭日记', '周末愉快'];

/** Fraction of AI posts that carry a tag at all. A feed of hashtags reads as marketing. */
export const TOPIC_TAG_RATE = 0.18;

/**
 * Should this post carry a #话题#, and which? Seeded per post so backfill and
 * replay agree. Goal-flavored posts pull from their domain's pool — that is
 * what turns three posts a month into a legible series.
 */
export function maybeTopicTag(domain: GoalDomain | undefined, seed: string): string | null {
  const rng = seededRng(`mtopic:${seed}`);
  if (rng() >= TOPIC_TAG_RATE) return null;
  const pool = domain ? TOPIC_POOLS[domain] : GENERIC_TOPICS;
  return pool[Math.floor(rng() * pool.length)];
}

/**
 * 连续剧感 (M-I15): the extra prompt line that makes goal posts read as
 * installments of ONE story instead of isolated updates. Only meaningful from
 * the second reached milestone on — episode one has nothing to call back to.
 * Pure; the caller appends it to `goalMomentMaterial`'s output.
 */
export function goalSeriesLine(g: GoalState): string {
  if (g.status !== 'active' || g.milestoneIndex < 1) return '';
  const prev = g.milestones.filter((m) => m.reached).at(-2);
  if (!prev?.text) return '';
  const episode = g.milestoneIndex + 1;
  return (
    `这不是你第一次围绕「${g.title}」发朋友圈了（这大概是第 ${episode} 篇，` +
    `上一篇时你还在「${prev.text}」的阶段）。写出一点"连载下一集"的感觉——` +
    '可以轻轻呼应之前的状态，让常看你朋友圈的人看得出进展，但别写成汇报。'
  );
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
  // Something that just happened with a mutual friend, sometimes (M-H1). This
  // is the surface where the social graph is most legible to the user: an
  // unexplained, unnamed post right after a falling-out is how you find out
  // there WAS one. Seeded and minority-weighted — a feed of subtweets is a
  // different and much worse character than one that occasionally has a bad day.
  const arc = rng() < 0.4 ? await freshArc(peer.id, await peersOf(persona), now) : null;
  // …or something that happened with the USER today (M-H1). Until now the feed
  // was her life with the user entirely absent from it, which is a strange
  // sort of friendship: you talk every day and never appear in anything she
  // posts. A same-day memory is exactly the material a person would use.
  const shared = arc
    ? null
    : rng() < 0.35
      ? facts.find((f) => f.status === 'confirmed' && now - f.createdAt < 24 * 3_600_000)
      : null;
  const material = arc
    ? arcMomentDirective(arc.marker.kind)
    : shared
      ? aboutYouDirective(shared.fact)
      : '';

  // Goal-arc material (M-I14): a fresh milestone or a completed goal sometimes
  // becomes the post. Seeded gate inside — the feed must not turn into a
  // progress log, so this is empty most of the time.
  const goal = goalStateAt(peer.id, now, agentEpoch(peer.id));
  let goalBg = goalMomentMaterial(goal, now, `${peer.id}:${now}`);
  // 连续剧式发帖 (M-I15): when the post IS goal material and this is not the
  // first installment, ask for continuity with the previous one.
  if (goalBg) {
    const series = goalSeriesLine(goal);
    if (series) goalBg += `\n${series}`;
  }
  // 偶尔带话题标签 (M-I15): seeded minority. Goal-flavored posts tag their own
  // storyline's pool so the topic page accumulates a real series.
  const topic = maybeTopicTag(
    goalBg && goal.status === 'active' ? goal.domain : undefined,
    `${peer.id}:${now}`,
  );

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
              (material ? `${material}\n` : '') +
              '写一条你现在会发的朋友圈。要求：' +
              '1) 第一人称，像真人随手发的，不是作文；' +
              '2) 40 字以内，可以只有一句话，允许口语和不完整句；' +
              (topic
                ? `3) 在正文里自然带上话题标签 #${topic}#（只这一个，别再加别的标签）、` +
                  '不要 emoji 堆砌、不要"分享一下"这类开场白；'
                : '3) 不要话题标签、不要 emoji 堆砌、不要"分享一下"这类开场白；') +
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
