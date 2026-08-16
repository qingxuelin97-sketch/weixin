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
} from './moments-engine';
import { repostMoment } from './moment-repost';
import { canSeeMoment } from '../lib/moment-visibility';
import { repo } from '../db/repo';

export interface MomentsHooks {
  addMoment: (m: MomentVM) => Promise<void>;
  /** Idempotent add — NOT a toggle; an AI reacting must never un-like. */
  applyLike: (like: MomentLikeVM) => Promise<void>;
  addComment: (c: MomentCommentVM) => Promise<void>;
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
  // The whole row goes in, so the post's 可见范围 (M-I19) is inside the planner's
  // reach and cannot be dropped on the way.
  const planned = planReactions(moment, reactors, 'react');
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
  const rp = planRepost(moment, reactors, 'react');
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
  // Chain the next post even when generation failed, or this persona goes
  // permanently silent after one network blip.
  await scheduleNextMoment(persona, hooks.now());
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
}

/** Execute a due `moment_like`. */
export async function runMomentLike(
  momentId: string,
  contactId: string,
  hooks: MomentsHooks,
  at?: number,
): Promise<void> {
  const moment = await repo.getMoment(momentId);
  if (!moment) return; // post was deleted before the like landed
  // 可见范围 checked AGAIN at fire time (M-I19), the same two-checks rule
  // `canForwardFrom` follows: the row was queued hours ago, and what lands on
  // screen cannot be taken back.
  if (!canSeeMoment(moment, contactId)) return;
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
  const source = await repo.getMoment(momentId);
  if (!source) return; // post deleted before the repost landed
  // Re-check the audience at fire time (M-I19). A repost is republication —
  // the strictest of the three reactions, so it refuses anything restricted
  // outright rather than merely checking this reposter.
  if (source.visibility && source.visibility.mode !== 'public') return;
  if (!canSeeMoment(source, reposter.id)) return;
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
  const moment = await repo.getMoment(momentId);
  if (!moment) return;
  if (!canSeeMoment(moment, commenter.id)) return; // M-I19, checked twice
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
}
