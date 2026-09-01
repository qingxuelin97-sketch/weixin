/**
 * Moments orchestration: turning plans into queued actions, and executing them.
 *
 * Everything time-driven here goes onto `scheduled_actions` (the single
 * time-evolution path), which is what lets offline backfill reuse this code
 * verbatim — the only difference is that backfilled actions have a `fireAt` in
 * the past.
 */
import type { MomentVM, MomentLikeVM, MomentCommentVM, ContactVM, PersonaVM } from '../data/types';
import { enqueue } from './scheduler';
import {
  planReactions,
  planRepost,
  collectReactors,
  nextMomentAt,
  generateMomentPost,
  generateMomentComment,
  generateRepostText,
  momentRouteTier,
} from './moments-engine';
import { repostMoment } from './moment-repost';
import { generateToLibrary } from './gen-media';
import { canSeeMoment } from '../lib/moment-visibility';
import { recordStance, hostileTone, STANCE_CLASH_DELTA } from './relationship';
import { seededRng } from '../lib/money';
import { repo } from '../db/repo';

export interface MomentsHooks {
  addMoment: (m: MomentVM) => Promise<void>;
  /** Idempotent add — NOT a toggle; an AI reacting must never un-like. */
  applyLike: (like: MomentLikeVM) => Promise<void>;
  addComment: (c: MomentCommentVM) => Promise<void>;
  /**
   * Write an updated contact row (M-J3, AI 换头像). Optional so fakes that
   * predate the field keep working — absent hook = the swap silently never
   * happens, which is the correct degraded shape for an optional flourish.
   */
  updateContact?: (c: ContactVM) => Promise<void>;
  now: () => number;
}

/**
 * Queue the likes/comments a post will attract. Called right after ANY post is
 * published, including the user's own — the point of the feature is that your
 * friends react to what you post.
 */
export async function scheduleReactionsFor(
  moment: MomentVM,
  contacts: ContactVM[],
  personaFor: (id: string) => PersonaVM | undefined,
  now: number,
): Promise<void> {
  const reactors = await collectReactors(contacts, personaFor, now);
  // The whole row goes in, so the post's 可见范围 (M-I18) is inside the planner's
  // reach and cannot be dropped on the way.
  const perms = await repo.getFriendPerms();
  const planned = planReactions(moment, reactors, 'react', perms);
  for (const p of planned) {
    await enqueue({
      kind: p.kind,
      fireAt: p.at,
      payload: { momentId: moment.id, contactId: p.contactId },
      now,
      // Stable id: re-running the planner for the same post can't double-queue.
      id: `${p.kind}_${moment.id}_${p.contactId}`,
    });
  }
  // 转发 (M-I15): rarely, one close friend reposts a USER post. The planner
  // refuses everything else, so no queue row exists to go wrong for AI posts.
  const rp = planRepost(moment, reactors, 'react', perms);
  if (rp) {
    await enqueue({
      kind: 'moment_repost',
      fireAt: rp.at,
      payload: { momentId: moment.id, contactId: rp.contactId },
      now,
      id: `moment_repost_${moment.id}_${rp.contactId}`,
    });
  }
}

/** Queue this persona's next post, if they post at all. */
export async function scheduleNextMoment(persona: PersonaVM, from: number): Promise<void> {
  const at = nextMomentAt(persona, from);
  if (at == null) return;
  await enqueue({
    kind: 'moment_post',
    fireAt: at,
    payload: { contactId: persona.contactId },
    now: from,
    id: `mpost_${persona.contactId}_${at}`,
  });
}

/**
 * Execute a due `moment_post`: generate the text, store the post, queue the
 * reactions it will draw, and schedule this persona's next one.
 *
 * @param at the post's timestamp — in the past when backfilling
 */
export async function runMomentPost(
  persona: PersonaVM,
  peer: ContactVM,
  contacts: ContactVM[],
  personaFor: (id: string) => PersonaVM | undefined,
  hooks: MomentsHooks,
  at?: number,
): Promise<void> {
  const stamp = at ?? hooks.now();
  const generated = await generateMomentPost(persona, peer, stamp);
  // NO `scheduleNextMoment` here (M-I18). There used to be one, with the note
  // "chain the next post even when generation failed" — a concern that stopped
  // being this function's business in M-E1, when `moment_post` became a
  // registerChainedHandler kind: the chain step runs BEFORE the work and has
  // already queued the next post by the time generation is even attempted.
  //
  // Keeping both made TWO owners of "queue the next one", and their ids differ:
  // `mpost_<id>_<at>` where `at = from + gap`, chain's `from` taken before the
  // LLM round-trip and this one's after it. `enqueue` upserts by id, so two
  // different ids meant two pending rows — and each of those forked again next
  // cycle. On a device with a provider configured, an AI's moments double every
  // period until the feed is nothing else, each row a paid call.
  //
  // It survived four rounds because it is invisible offline: with no provider
  // `generateMomentPost` returns in well under a millisecond, both `from`s land
  // on the same `Date.now()`, the ids collide, and the upsert silently folds
  // them back into one. Every test in this repo runs in exactly that condition.
  if (!generated) return;

  const moment: MomentVM = {
    id: `mo_${peer.id}_${stamp}`,
    authorId: peer.id,
    text: generated.text,
    imageRefs: generated.imageRefs,
    isNsfw: false,
    createdAt: stamp,
  };
  await hooks.addMoment(moment);
  await scheduleReactionsFor(moment, contacts, personaFor, hooks.now());
  // 偶尔换个头像 (M-J3): rides the tail of the post that already fired — no
  // new action kind, no second timer, and offline backfill reaches it through
  // the same materialized `moment_post` row as everything else.
  await maybeAvatarSwap(persona, peer, contacts, personaFor, hooks, stamp);
}

/**
 * How often a due post ALSO becomes an avatar change. Rare on purpose: a
 * changed avatar is one of the loudest "she has a life" signals there is, and
 * each one costs a paid generation — at 3% of posts a 0.5/day persona changes
 * hers about once a month, which is what real people do.
 */
export const AVATAR_SWAP_RATE = 0.03;

/** Seeded gate, pure — replay and backfill agree on which post swaps. */
export function shouldSwapAvatar(contactId: string, stamp: number): boolean {
  return seededRng(`avatarswap:${contactId}:${stamp}`)() < AVATAR_SWAP_RATE;
}

/**
 * Generate a fresh 512 avatar, point the contact at it, and post the
 * 「换了个头像」moment that makes the change legible in the feed.
 *
 * Every exit is silent: no updateContact hook, dice say no, generation not
 * configured (or blocked by the 铁律 6 tier gate inside generateToLibrary),
 * or the endpoint failed — in all cases the ordinary post already published
 * and nothing on screen hints that anything more was attempted.
 *
 * The new avatar lands in the media library as `kind: 'avatar'` (not
 * 'generated'): startup hydration eagerly materializes avatars and the LRU
 * eviction exempts them — stored any other way, her face degrades to a
 * placeholder tint after the next cold start.
 */
export async function maybeAvatarSwap(
  persona: PersonaVM,
  peer: ContactVM,
  contacts: ContactVM[],
  personaFor: (id: string) => PersonaVM | undefined,
  hooks: MomentsHooks,
  stamp: number,
): Promise<void> {
  if (!hooks.updateContact) return;
  if (!shouldSwapAvatar(peer.id, stamp)) return;
  // Routing tier for HER card riding the prompt — derived, never declared
  // (the same rule the post generation itself follows).
  const tier = await momentRouteTier(persona);
  const style = persona.imageTags.filter(Boolean).join('、');
  const ref = await generateToLibrary({
    prompt:
      `一张社交软件个人头像，主角是：${persona.core.slice(0, 80)}。` +
      `${style ? `画面气质贴合：${style}。` : ''}构图居中、适合裁成方形小图、不要文字水印。`,
    tier,
    now: stamp,
    seed: `avatar:${peer.id}:${stamp}`,
    tags: ['AI生成'],
    kind: 'avatar',
    size: '512x512',
  });
  if (!ref) return;
  await hooks.updateContact({ ...peer, avatarRef: ref });
  const moment: MomentVM = {
    id: `mo_${peer.id}_${stamp}_avatar`,
    authorId: peer.id,
    text: '换了个头像',
    imageRefs: [ref],
    isNsfw: false,
    // Right after the post it rode in on, so the feed reads in order.
    createdAt: stamp + 1,
  };
  await hooks.addMoment(moment);
  await scheduleReactionsFor(moment, contacts, personaFor, hooks.now());
}

/** Execute a due `moment_like`. */
export async function runMomentLike(
  momentId: string,
  contactId: string,
  hooks: MomentsHooks,
  at?: number,
): Promise<void> {
  // Fetched AS THE REACTOR (M-J7), not as 'self': with 朋友权限 in the driver,
  // a 'self' read would also apply 不看他 — muting someone's feed would then
  // silently stop them liking OTHER people's posts too, which is not what the
  // switch says it does.
  const moment = await repo.getMoment(momentId, contactId);
  if (!moment) return; // post was deleted before the like landed
  // 可见范围 checked AGAIN at fire time (M-I18), the same two-checks rule
  // `canForwardFrom` follows: the row was queued hours ago, and what lands on
  // screen cannot be taken back.
  if (!canSeeMoment(moment, contactId, await repo.getFriendPerms())) return;
  // Route through the store so an open feed updates without a reload; the store
  // writes through to the Repo and ignores a like that already exists.
  await hooks.applyLike({
    id: `${momentId}:${contactId}`,
    momentId,
    contactId,
    createdAt: at ?? hooks.now(),
  });
}

/**
 * Execute a due `moment_repost` (M-I15): an AI puts the user's post on her own
 * wall with a one-line caption.
 *
 * The quote goes through `repostMoment`, which re-reads the source from
 * storage by id — the same leak rule as the user path, enforced twice. A
 * source deleted since planning publishes nothing, silently. The new post
 * draws its own likes/comments; it can never draw another repost, because
 * `planRepost` only ever fires on posts authored by 'self'.
 */
export async function runMomentRepost(
  momentId: string,
  reposter: ContactVM,
  persona: PersonaVM,
  contacts: ContactVM[],
  personaFor: (id: string) => PersonaVM | undefined,
  hooks: MomentsHooks,
  at?: number,
): Promise<void> {
  const source = await repo.getMoment(momentId, reposter.id);
  if (!source) return; // post deleted before the repost landed
  // Re-check the audience at fire time (M-I18). A repost is republication —
  // the strictest of the three reactions, so it refuses anything restricted
  // outright rather than merely checking this reposter.
  if (source.visibility && source.visibility.mode !== 'public') return;
  if (!canSeeMoment(source, reposter.id, await repo.getFriendPerms())) return;
  const stamp = at ?? hooks.now();
  const text = await generateRepostText(persona, reposter, source, stamp);
  const posted = await repostMoment(
    momentId,
    { authorId: reposter.id, text, now: stamp },
    { getMoment: (id) => repo.getMoment(id), addMoment: hooks.addMoment },
  );
  if (!posted) return;
  await scheduleReactionsFor(posted, contacts, personaFor, hooks.now());
}

/** Execute a due `moment_comment`. */
export async function runMomentComment(
  momentId: string,
  commenter: ContactVM,
  persona: PersonaVM,
  authorName: string,
  hooks: MomentsHooks,
  at?: number,
): Promise<void> {
  const moment = await repo.getMoment(momentId, commenter.id);
  if (!moment) return;
  // M-I18, checked twice; 朋友权限 rides the same check since M-J7.
  if (!canSeeMoment(moment, commenter.id, await repo.getFriendPerms())) return;
  const stamp = at ?? hooks.now();
  const text = await generateMomentComment(persona, commenter, moment, authorName, stamp);
  if (!text) return;
  await hooks.addComment({
    id: `mc_${momentId}_${commenter.id}_${stamp}`,
    momentId,
    authorId: commenter.id,
    text,
    createdAt: stamp,
  });
  // Stance writer 3 of 4 (M-J1): a combative comment lands, and the AUTHOR
  // cools toward the sniper — same direction as recordTease (the needled cools
  // toward the needler). Keyword-judged at the落库 moment, never a new LLM
  // call; the user has no stance row, so their posts record nothing.
  if (moment.authorId !== 'self' && moment.authorId !== commenter.id && hostileTone(text)) {
    void recordStance(moment.authorId, commenter.id, STANCE_CLASH_DELTA, stamp).catch(() => {});
  }
}
