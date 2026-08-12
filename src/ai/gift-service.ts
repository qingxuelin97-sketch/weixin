/**
 * Turning "she would send you something" into rows (M-H1).
 *
 * `money-motive.ts` decides; this schedules and executes. The split is the same
 * one `heartbeat.ts` / `handlers.ts` already use, and for the same reason: the
 * decision is where all the judgement lives and must stay a pure function, while
 * the part that touches the queue, the store and the ledger is mostly plumbing.
 *
 * Rule #5: a gift is a thing that happens by itself at a future time, so it
 * happens through `scheduled_actions` (`ai_money`) — no timer of its own.
 */
import type { ContactVM, ConversationVM, MessageVM, PersonaVM } from '../data/types';
import { repo } from '../db/repo';
import { enqueue, actionExists } from './scheduler';
import { getEdge, effectiveAffinity } from './relationship';
import { occasionsFor, firstSpokeAt } from './occasions';
import { planGift, planGroupGift, type GiftPlan } from './money-motive';
import { driftedPersona } from './drift';
import { sendRedPacketFrom, sendTransferFrom, type MoneyHooks } from './money-service';

const DAY = 86_400_000;

/** When she last gave money in this conversation. */
const giftKey = (convId: string) => `giftAt:${convId}`;

export async function lastGiftAt(convId: string): Promise<number | undefined> {
  try {
    return (await repo.getSetting<number>(giftKey(convId))) ?? undefined;
  } catch {
    return undefined;
  }
}

/** The payload an `ai_money` row carries. Flat on purpose — payloads are JSON. */
export interface GiftPayload {
  convId: string;
  contactId: string;
  kind: 'rp' | 'transfer';
  reason: string;
  amountFen: number;
  note: string;
  line: string;
  /** Red packets only: how many shares. 1 for a single chat. */
  count?: number;
}

function payloadOf(plan: GiftPlan, convId: string, contactId: string, count: number): GiftPayload {
  return {
    convId,
    contactId,
    kind: plan.kind,
    reason: plan.reason,
    amountFen: plan.amountFen,
    note: plan.note,
    line: plan.line,
    ...(plan.kind === 'rp' ? { count } : {}),
  };
}

/**
 * Consider one single chat, and queue a gift if she would send one.
 *
 * Called from the foreground pass alongside the heartbeat and Moments seeding.
 * Returns whether anything was queued, which is what the tests assert on.
 *
 * The action id is stable per (conversation, day) and checked with
 * `actionExists` rather than a pending-only query: `enqueue` upserts by id, so
 * a plain re-enqueue would flip an already-DELIVERED gift back to pending and
 * send it a second time — the nudge trap, in a code path that moves money.
 */
export async function considerGift(args: {
  conv: ConversationVM;
  persona: PersonaVM;
  now: number;
  recent: MessageVM[];
}): Promise<boolean> {
  const { conv, persona, now, recent } = args;
  const contactId = persona.contactId;
  const id = `gift_${conv.id}_${Math.floor(now / DAY)}`;
  if (await actionExists(id)) return false;

  const edge = await getEdge('self', contactId, now);
  const facts = await repo.getMemory(contactId).catch(() => []);
  const plan = planGift({
    // Generosity drifts (M-H1): someone you have been warm to for months is
    // more open-handed than the card says, and someone you fought with is less.
    persona: await driftedPersona(persona, now),
    now,
    affinity: effectiveAffinity(edge, persona.affinityInit),
    occasions: occasionsFor({ now, facts, firstMsgAt: await firstSpokeAt(conv.id) }),
    recent,
    lastGiftAt: await lastGiftAt(conv.id),
  });
  if (!plan) return false;

  await enqueue({
    kind: 'ai_money',
    fireAt: plan.fireAt,
    payload: { ...payloadOf(plan, conv.id, contactId, 1) },
    now,
    id,
  });
  return true;
}

/** The group version: one festival packet for the whole room, from one member. */
export async function considerGroupGift(args: {
  conv: ConversationVM;
  members: Array<{ contactId: string; persona: PersonaVM }>;
  now: number;
  facts: Array<{ fact: string }>;
}): Promise<boolean> {
  const { conv, members, now } = args;
  const id = `ggift_${conv.id}_${Math.floor(now / DAY)}`;
  if (await actionExists(id)) return false;

  const plan = planGroupGift({
    now,
    convId: conv.id,
    members,
    occasions: occasionsFor({ now, facts: args.facts }),
    lastMsgAt: conv.lastMsgAt,
    lastGiftAt: await lastGiftAt(conv.id),
  });
  if (!plan) return false;

  await enqueue({
    kind: 'ai_money',
    fireAt: plan.fireAt,
    payload: { ...payloadOf(plan, conv.id, plan.contactId, plan.count) },
    now,
    id,
  });
  return true;
}

export interface GiftDeps {
  hooks: MoneyHooks;
  /** Everyone who might grab a group packet, minus the sender (filtered inside). */
  grabbers: (convId: string, senderId: string) => Array<{ contactId: string; persona?: PersonaVM }>;
  contactById: (id: string) => ContactVM | undefined;
  now: () => number;
}

/**
 * Deliver a planned gift.
 *
 * Stamped at `now()`, never at the row's `fireAt`: a gift that catches up when
 * you reopen the app is her sending it now, and a past stamp on a row inserted
 * now would invert `rowid order == time order` (the pagination invariant) the
 * moment anything else was said in between.
 */
export async function runGift(p: GiftPayload, deps: GiftDeps): Promise<void> {
  const { convId, contactId } = p;
  if (!convId || !contactId) return;
  const now = deps.now();

  // She says something first. A packet with no words in front of it reads as a
  // system event; one line of her own makes it a gesture.
  if (p.line) {
    await deps.hooks.appendMessage({
      convId,
      senderId: contactId,
      type: 'text',
      content: p.line,
      status: 'sent',
      createdAt: now,
    });
  }

  const at = now + (p.line ? 1_200 : 0);
  if (p.kind === 'transfer') {
    await sendTransferFrom(contactId, convId, p.amountFen, p.note, deps.hooks, at);
  } else {
    await sendRedPacketFrom(
      contactId,
      convId,
      p.amountFen,
      Math.max(1, p.count ?? 1),
      p.note,
      deps.grabbers(convId, contactId),
      deps.hooks,
      at,
    );
  }
  await repo.putSetting(giftKey(convId), now);
}
