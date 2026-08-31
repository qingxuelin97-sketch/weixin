/**
 * 群收款/AA (M-J8): creating a bill, and settling it one payer at a time.
 *
 * The split is the same module money already trusts (`splitEvenPacket` —
 * integer fen, remainder front-loaded, conservation by construction), the
 * time-driven part is the same single queue (`bill_pay` rows, one per AI
 * participant, seeded per persona — 铁律 5, no timer of its own), and the
 * decisions (pay after how long / 装死 / would an AI even start one) live in
 * `money-motive.ts` as pure seeded functions.
 *
 * TRUTH LIVES IN SETTINGS, MIRROR LIVES IN META. The settlement state is one
 * row per conversation — `bill:<convId>` → { billId → BillState } — registered
 * in `SETTINGS_KEY_CASCADE` as conv-scoped cascade (the key tail is the convId
 * precisely so the deleteContact cascade can match it; a `bill:<billId>` row
 * would be unmatchable and immortal). The card message's meta carries a
 * render-ready snapshot (names frozen at creation, like a 名片) that is
 * rewritten after every payment; a divergent mirror costs pixels, never money.
 */
import type { ConversationVM, ContactVM, PersonaVM } from '../data/types';
import { repo } from '../db/repo';
import { enqueue, actionExists } from './scheduler';
import { splitEvenPacket } from '../lib/money';
import { planBillPayment, planGroupBill } from './money-motive';
import { recordWalletTx, type MoneyHooks } from './money-service';

const WEEK = 7 * 86_400_000;

/** One settlement row's shape. `parts` is who owes; `paid` maps payer → paidAt. */
export interface BillState {
  billId: string;
  convId: string;
  initiatorId: string;
  title: string;
  totalFen: number;
  parts: Array<{ id: string; oweFen: number }>;
  paid: Record<string, number>;
  createdAt: number;
}

/** The settings key: ONE row per conversation, holding every bill in it. */
export const billsKey = (convId: string): string => `bill:${convId}`;

async function billsOf(convId: string): Promise<Record<string, BillState>> {
  try {
    return (await repo.getSetting<Record<string, BillState>>(billsKey(convId))) ?? {};
  } catch {
    return {};
  }
}

/** One bill's settlement state, or undefined if it never existed here. */
export async function billOf(convId: string, billId: string): Promise<BillState | undefined> {
  return (await billsOf(convId))[billId];
}

export interface BillParticipant {
  contactId: string;
  /** Display name frozen into the card meta (名片快照纪律). */
  name: string;
  persona?: PersonaVM;
}

/**
 * Create a bill: write the settlement row, post the card, queue each AI
 * participant's payment. Participants exclude the initiator (nobody owes
 * themselves); `'self'` in the list is the user, whose share is settled by
 * tapping the card, never by a queue row.
 */
export async function createGroupBill(args: {
  convId: string;
  initiatorId: string;
  totalFen: number;
  title: string;
  participants: BillParticipant[];
  hooks: MoneyHooks;
  at?: number;
}): Promise<BillState> {
  const { convId, initiatorId, totalFen, title, participants, hooks } = args;
  if (participants.length === 0) throw new Error('群收款至少要有一个参与人');
  const now = args.at ?? hooks.now();
  const billId = `bill_${now}_${initiatorId}`;
  const shares = splitEvenPacket(totalFen, participants.length);
  const bill: BillState = {
    billId,
    convId,
    initiatorId,
    title,
    totalFen,
    parts: participants.map((p, i) => ({ id: p.contactId, oweFen: shares[i] })),
    paid: {},
    createdAt: now,
  };
  const rows = await billsOf(convId);
  await repo.putSetting(billsKey(convId), { ...rows, [billId]: bill });

  await hooks.appendMessage({
    convId,
    senderId: initiatorId,
    type: 'group_bill',
    content: '',
    meta: {
      billId,
      title,
      totalFen,
      parts: participants.map((p, i) => ({ id: p.contactId, name: p.name, oweFen: shares[i] })),
      paidIds: [],
    },
    status: 'sent',
    createdAt: now,
  });

  // Each AI participant either queues a seeded payment or 装死 — decided NOW,
  // purely, so a replay of this creation queues exactly the same payers.
  for (const p of participants) {
    if (p.contactId === 'self') continue; // the user pays by tapping the card
    const plan = planBillPayment(billId, p.contactId, p.persona);
    if (!plan) continue; // this one is pretending not to have seen it
    await enqueue({
      kind: 'bill_pay',
      fireAt: now + plan.delayMs,
      payload: { billId, convId, contactId: p.contactId, at: now + plan.delayMs },
      now,
      id: `bill_pay_${billId}_${p.contactId}`,
    });
  }
  return bill;
}

/**
 * Settle one participant's share. Idempotent per payer (a re-fired queue row
 * or a double tap pays once), inert for strangers to the bill.
 *
 * Wallet rules follow the money-fiction line the packet code drew: an AI's
 * balance is invented, so only edges touching the USER move the ledger —
 * their payment into YOUR bill credits you (`bill_in`, the claimRedPacket
 * precedent: her fictional money becomes your real balance), and your payment
 * into theirs debits you (`bill_out`).
 */
export async function payBill(
  billId: string,
  convId: string,
  payerId: string,
  hooks: MoneyHooks,
  at?: number,
): Promise<'paid' | 'noop'> {
  const rows = await billsOf(convId);
  const bill = rows[billId];
  if (!bill) return 'noop';
  if (bill.paid[payerId] != null) return 'noop';
  const part = bill.parts.find((p) => p.id === payerId);
  if (!part) return 'noop';

  const msgs = await repo.getMessages(convId, { limit: 200 });
  // rowid 序 == 时间序: a payment draining late (reopened app) must not stamp
  // itself before the thread's newest row.
  const lastAt = msgs.at(-1)?.createdAt ?? 0;
  const now = Math.max(at ?? hooks.now(), lastAt);

  const paid = { ...bill.paid, [payerId]: now };
  await repo.putSetting(billsKey(convId), { ...rows, [billId]: { ...bill, paid } });

  if (bill.initiatorId === 'self' && payerId !== 'self') {
    await recordWalletTx('bill_in', part.oweFen, `群收款-${bill.title || 'AA'}`, `${billId}_${payerId}`, now, payerId);
  } else if (payerId === 'self') {
    await recordWalletTx(
      'bill_out',
      -part.oweFen,
      bill.title || '群收款',
      `${billId}_self`,
      now,
      bill.initiatorId !== 'self' ? bill.initiatorId : undefined,
    );
  }

  // Mirror into the card so the 已付/未付 roster repaints.
  const card = msgs.find((m) => m.type === 'group_bill' && m.meta?.billId === billId);
  if (card) {
    await hooks.updateMessage({ ...card, meta: { ...card.meta, paidIds: Object.keys(paid) } });
  }

  // 收齐了 — one grey line, not one per payment (four "已支付" rows is spam).
  if (bill.parts.every((p) => paid[p.id] != null)) {
    await hooks.appendMessage({
      convId,
      senderId: 'self',
      type: 'system',
      content: bill.initiatorId === 'self' ? '你发起的群收款已完成' : '群收款已完成',
      status: 'sent',
      createdAt: now,
    });
  }
  return 'paid';
}

/**
 * Would one of this group's AIs start an AA bill? Called from the foreground
 * pass beside `considerGroupGift` — same weekly seeded dice, same stable-id +
 * `actionExists` discipline (enqueue upserts; a delivered bill must not be
 * revived as pending). The creation rides `ai_money` with payload kind 'bill',
 * so the fire-time machinery is the one the other planned money already uses.
 */
export async function considerGroupBill(args: {
  conv: ConversationVM;
  members: Array<{ contactId: string; persona: PersonaVM }>;
  now: number;
}): Promise<boolean> {
  const { conv, members, now } = args;
  const id = `gbill_${conv.id}_${Math.floor(now / WEEK)}`;
  if (await actionExists(id)) return false;
  const plan = planGroupBill({ now, convId: conv.id, members, lastMsgAt: conv.lastMsgAt });
  if (!plan) return false;
  await enqueue({
    kind: 'ai_money',
    fireAt: plan.fireAt,
    payload: {
      kind: 'bill',
      convId: conv.id,
      contactId: plan.initiatorId,
      amountFen: plan.perFen,
      note: plan.title,
    },
    now,
    id,
  });
  return true;
}

/** What `startAiBill` needs from the store — injected so tests stay storeless. */
export interface AiBillDeps {
  conversationById: (id: string) => ConversationVM | undefined;
  contactById: (id: string) => ContactVM | undefined;
  personaFor: (id: string) => PersonaVM | undefined;
  hooks: MoneyHooks;
}

/**
 * An `ai_money` bill row fires: materialize the bill SHE planned. The roster
 * is resolved NOW, not at planning time — members who left in the meantime
 * must not owe anything, which is the same staleness re-check every money
 * handler performs.
 */
export async function startAiBill(
  p: { convId: string; contactId: string; perFen: number; title: string },
  deps: AiBillDeps,
): Promise<void> {
  const conv = deps.conversationById(p.convId);
  if (!conv || conv.type !== 'group' || conv.isHidden) return;
  if (!(conv.memberIds ?? []).includes(p.contactId)) return; // initiator left
  const participants: BillParticipant[] = (conv.memberIds ?? [])
    .filter((id) => id !== p.contactId && deps.personaFor(id))
    .map((id) => {
      const c = deps.contactById(id);
      return { contactId: id, name: c?.remark ?? c?.name ?? id, persona: deps.personaFor(id) };
    });
  // The user owes a share too — that is the whole「用户也能付」surface.
  participants.push({ contactId: 'self', name: '你' });
  await createGroupBill({
    convId: p.convId,
    initiatorId: p.contactId,
    totalFen: p.perFen * participants.length,
    title: p.title,
    participants,
    hooks: deps.hooks,
  });
}
