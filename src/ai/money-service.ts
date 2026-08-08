/**
 * Red packet / transfer orchestration: creating them, claiming them, and moving
 * money in the wallet ledger. Time-driven parts (AI grabbing, AI accepting a
 * transfer) are queued onto `scheduled_actions` — the single time-evolution path.
 */
import type {
  RedPacketVM,
  RpClaimVM,
  TransferVM,
  WalletTxVM,
  MessageVM,
  PersonaVM,
} from '../data/types';
import { splitLuckyPacket } from '../lib/money';
import { claimShare, isFullyClaimed, markBestLuck, appendTx, grabDelayMs } from '../lib/wallet';
import { repo } from '../db/repo';
import { enqueue } from './scheduler';
import { recordRelEvent } from './relationship';

export interface MoneyHooks {
  appendMessage: (msg: Omit<MessageVM, 'id'>) => Promise<MessageVM>;
  updateMessage: (msg: MessageVM) => Promise<void>;
  now: () => number;
}

/** Credit or debit the wallet, keeping the running balance correct. */
export async function recordWalletTx(
  kind: WalletTxVM['kind'],
  amountFen: number,
  title: string,
  refId: string,
  now: number,
): Promise<WalletTxVM> {
  const txs = await repo.getWalletTxs();
  const tx = appendTx(txs, {
    id: `wtx_${now}_${refId}`,
    kind,
    amountFen,
    refId,
    title,
    createdAt: now,
  });
  await repo.putWalletTx(tx);
  return tx;
}

/**
 * Send a red packet: debit the wallet, pre-split the shares deterministically,
 * post the bubble, and queue each AI member's grab.
 */
export async function sendRedPacket(
  convId: string,
  totalFen: number,
  count: number,
  greeting: string,
  grabbers: Array<{ contactId: string; persona?: PersonaVM }>,
  hooks: MoneyHooks,
): Promise<RedPacketVM> {
  const now = hooks.now();
  const id = `rp_${now}`;
  const rp: RedPacketVM = {
    id,
    convId,
    senderId: 'self',
    totalFen,
    count,
    kind: 'lucky',
    greeting: greeting || '恭喜发财，大吉大利',
    // Deterministic split at creation: sum(shares) === totalFen, replay-safe.
    sharesFen: splitLuckyPacket(totalFen, count, id),
    status: 'active',
    createdAt: now,
  };
  await repo.putRedPacket(rp);
  await recordWalletTx('rp_out', -totalFen, '发出红包', id, now);

  await hooks.appendMessage({
    convId,
    senderId: 'self',
    type: 'rp',
    content: '',
    meta: { rpId: id, greeting: rp.greeting, opened: false },
    status: 'sent',
    createdAt: now,
  });

  // Stagger the AI grabs so the packet gets taken the way a real group does.
  for (const g of grabbers) {
    await enqueue({
      kind: 'rp_grab',
      fireAt: now + grabDelayMs(g.persona?.grabSpeed, id, g.contactId),
      payload: { rpId: id, contactId: g.contactId, convId },
      now,
    });
  }
  return rp;
}

/**
 * Claim a share for someone. Returns the claim, or null if already claimed/empty.
 * Credits the wallet when the claimer is the user, and posts the grey system line.
 */
export async function claimRedPacket(
  rpId: string,
  claimerId: string,
  claimerName: string,
  hooks: MoneyHooks,
): Promise<RpClaimVM | null> {
  const rp = await repo.getRedPacket(rpId);
  if (!rp || rp.status !== 'active') return null;
  const existing = await repo.getClaims(rpId);
  const now = hooks.now();

  const claim = claimShare(rp, existing, claimerId, now);
  if (!claim) return null;
  await repo.putClaim(claim);

  const all = [...existing, claim];
  if (claimerId === 'self') {
    await recordWalletTx('rp_in', claim.amountFen, '收到红包', rpId, now);
  }
  // Receiving money warms the edge between sender and claimer (skip self-claims
  // of one's own packet — that's bookkeeping, not a gesture).
  if (claimerId !== rp.senderId) {
    void recordRelEvent(rp.senderId, claimerId, 'rp_received', now).catch(() => {});
  }

  // Once the last share is gone, settle "best luck" and close the packet.
  if (isFullyClaimed(rp, all)) {
    for (const c of markBestLuck(rp, all)) await repo.putClaim(c);
    await repo.putRedPacket({ ...rp, status: 'done' });
    await markRpMessageOpened(rp, hooks, '已被领完');
  } else if (claimerId === 'self') {
    await markRpMessageOpened(rp, hooks, '');
  }

  await hooks.appendMessage({
    convId: rp.convId,
    senderId: 'self',
    type: 'system',
    content:
      claimerId === 'self'
        ? `你领取了${rp.senderId === 'self' ? '自己' : ''}的红包`
        : `${claimerName}领取了你的红包`,
    status: 'sent',
    createdAt: now,
  });
  return claim;
}

/** Flip the red packet bubble to its dim/claimed state. */
async function markRpMessageOpened(rp: RedPacketVM, hooks: MoneyHooks, statusText: string) {
  const msgs = await repo.getMessages(rp.convId, { limit: 200 });
  const target = msgs.find((m) => m.type === 'rp' && m.meta?.rpId === rp.id);
  if (!target) return;
  await hooks.updateMessage({
    ...target,
    meta: { ...target.meta, opened: true, statusText: statusText || target.meta?.statusText },
  });
}

/** Send a transfer to a peer: debit now, post a pending bubble, queue AI accept. */
export async function sendTransfer(
  convId: string,
  toId: string,
  amountFen: number,
  note: string,
  hooks: MoneyHooks,
): Promise<TransferVM> {
  const now = hooks.now();
  const id = `tr_${now}`;
  const t: TransferVM = {
    id,
    convId,
    fromId: 'self',
    toId,
    amountFen,
    note,
    status: 'pending',
    createdAt: now,
  };
  await repo.putTransfer(t);
  await recordWalletTx('transfer_out', -amountFen, note || '转账', id, now);

  await hooks.appendMessage({
    convId,
    senderId: 'self',
    type: 'transfer',
    content: '',
    meta: { transferId: id, amountFen, note, status: 'pending' },
    status: 'sent',
    createdAt: now,
  });

  // The peer accepts a few seconds later, like a real person noticing it.
  await enqueue({
    kind: 'transfer_accept',
    fireAt: now + 4_000 + (amountFen % 5) * 1_000,
    payload: { transferId: id, convId },
    now,
  });
  return t;
}

/** Accept a transfer (either direction): settle it and update both bubbles. */
export async function acceptTransfer(transferId: string, hooks: MoneyHooks): Promise<void> {
  const t = await repo.getTransfer(transferId);
  if (!t || t.status !== 'pending') return;
  const now = hooks.now();
  await repo.putTransfer({ ...t, status: 'accepted', acceptedAt: now });

  // Money only enters the user's wallet when the user is the recipient.
  if (t.toId === 'self') {
    await recordWalletTx('transfer_in', t.amountFen, t.note || '转账', t.id, now);
  }
  // A completed transfer is a strong warm gesture between the two parties.
  void recordRelEvent(t.fromId, t.toId, 'transfer_received', now).catch(() => {});

  const msgs = await repo.getMessages(t.convId, { limit: 200 });
  const target = msgs.find((m) => m.type === 'transfer' && m.meta?.transferId === t.id);
  if (target) {
    await hooks.updateMessage({
      ...target,
      meta: {
        ...target.meta,
        status: 'accepted',
        statusText: t.fromId === 'self' ? '已被接收' : '已收款',
      },
    });
  }
}
