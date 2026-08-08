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
  collectReactors,
  nextMomentAt,
  generateMomentPost,
  generateMomentComment,
} from './moments-engine';
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
  const reactors = await collectReactors(contacts, personaFor);
  const planned = planReactions(moment.id, moment.authorId, moment.createdAt, reactors, 'react');
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
  // Route through the store so an open feed updates without a reload; the store
  // writes through to the Repo and ignores a like that already exists.
  await hooks.applyLike({
    id: `${momentId}:${contactId}`,
    momentId,
    contactId,
    createdAt: at ?? hooks.now(),
  });
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
