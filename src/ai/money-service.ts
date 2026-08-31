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
import { splitLuckyPacket, splitEvenPacket, seededRng, fenToYuan } from '../lib/money';
import { claimShare, isFullyClaimed, markBestLuck, appendTx, grabDelayMs } from '../lib/wallet';
import { repo } from '../db/repo';
import { enqueue, actionExists } from './scheduler';
import { recordAffect } from '../lib/affect';
import { noteDrift } from './drift';
import { recordRelEvent } from './relationship';
import { planTransferReception } from './money-motive';

export interface MoneyHooks {
  appendMessage: (msg: Omit<MessageVM, 'id'>) => Promise<MessageVM>;
  updateMessage: (msg: MessageVM) => Promise<void>;
  now: () => number;
}

/**
 * Credit or debit the wallet, keeping the running balance correct.
 *
 * Reads ONE row, not the ledger (M-J8): `currentBalance` only ever needs the
 * newest entry's running total, and the full-table read here was the one that
 * made every money movement cost the install's whole history.
 *
 * `peerId` (optional) stamps the counterparty for the bill page's 按联系人
 * filter — omitted where there is no single counterparty (a group packet).
 */
export async function recordWalletTx(
  kind: WalletTxVM['kind'],
  amountFen: number,
  title: string,
  refId: string,
  now: number,
  peerId?: string,
): Promise<WalletTxVM> {
  const newest = await repo.getWalletTxs({ limit: 1 });
  const tx = appendTx(newest, {
    id: `wtx_${now}_${refId}`,
    kind,
    amountFen,
    refId,
    ...(peerId ? { peerId } : {}),
    title,
    createdAt: now,
  });
  await repo.putWalletTx(tx);
  return tx;
}

/** 红包玩法选项 (M-J8)。省略 = 拼手气，与 M3 起的每一次调用完全同义。 */
export interface RpOptions {
  mode?: NonNullable<RedPacketVM['mode']>;
  /** mode==='exclusive' 必填：指定领取人。 */
  exclusiveId?: string;
  /** mode==='exclusive' 时对方的显示名，定格进气泡 meta（快照，同名片）。 */
  exclusiveName?: string;
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
  opts?: RpOptions,
): Promise<RedPacketVM> {
  return createRedPacket('self', convId, totalFen, count, greeting, grabbers, hooks, undefined, opts);
}

/**
 * The same, sent BY an agent (M-H1).
 *
 * Money used to flow one way only — every packet in the codebase was
 * `senderId: 'self'`, so she could take and never give. The mechanics are
 * identical; the two differences are that no wallet is debited (her money is
 * fiction, and inventing a ledger for it would make the user's balance a lie)
 * and that the sender is excluded from the grab queue.
 */
export async function sendRedPacketFrom(
  senderId: string,
  convId: string,
  totalFen: number,
  count: number,
  greeting: string,
  grabbers: Array<{ contactId: string; persona?: PersonaVM }>,
  hooks: MoneyHooks,
  at?: number,
): Promise<RedPacketVM> {
  return createRedPacket(
    senderId,
    convId,
    totalFen,
    count,
    greeting,
    grabbers.filter((g) => g.contactId !== senderId),
    hooks,
    at,
  );
}

/** WeChat returns an unclaimed red packet after 24 hours. So does this one. */
export const RP_EXPIRE_MS = 24 * 3_600_000;

async function createRedPacket(
  senderId: string,
  convId: string,
  totalFen: number,
  count: number,
  greeting: string,
  grabbers: Array<{ contactId: string; persona?: PersonaVM }>,
  hooks: MoneyHooks,
  at?: number,
  opts: RpOptions = {},
): Promise<RedPacketVM> {
  // `at` lets a backfilled packet carry the timestamp it "happened" at while
  // the row is still written now — same discipline as every other handler.
  const now = at ?? hooks.now();
  const id = `rp_${now}_${senderId}`;
  const mode = opts.mode ?? 'lucky';
  if (mode === 'exclusive' && !opts.exclusiveId) throw new Error('专属红包必须指定领取人');
  // 专属包永远是一整份给一个人；均分走 splitEvenPacket（整数分、余数前置）。
  const shareCount = mode === 'exclusive' ? 1 : count;
  const rp: RedPacketVM = {
    id,
    convId,
    senderId,
    totalFen,
    count: shareCount,
    kind: mode === 'even' ? 'normal' : 'lucky',
    ...(mode !== 'lucky' ? { mode } : {}),
    ...(mode === 'exclusive' ? { exclusiveId: opts.exclusiveId } : {}),
    greeting: greeting || '恭喜发财，大吉大利',
    // Deterministic split at creation: sum(shares) === totalFen, replay-safe.
    sharesFen:
      mode === 'exclusive'
        ? [totalFen]
        : mode === 'even'
          ? splitEvenPacket(totalFen, shareCount)
          : splitLuckyPacket(totalFen, shareCount, id),
    status: 'active',
    // expiresAt 从 M3 就在 schema 里，零读零写 (M-J8 finally)。
    expiresAt: now + RP_EXPIRE_MS,
    createdAt: now,
  };
  await repo.putRedPacket(rp);
  // Only the user has a wallet. An agent's packet costs nothing and must not
  // touch the ledger the balance page reads.
  if (senderId === 'self') {
    await recordWalletTx(
      'rp_out',
      -totalFen,
      '发出红包',
      id,
      now,
      mode === 'exclusive' ? opts.exclusiveId : grabbers.length === 1 ? grabbers[0].contactId : undefined,
    );
  }

  await hooks.appendMessage({
    convId,
    senderId,
    type: 'rp',
    content: '',
    meta: {
      rpId: id,
      greeting: rp.greeting,
      opened: false,
      ...(mode !== 'lucky' ? { mode } : {}),
      ...(mode === 'exclusive' && opts.exclusiveName ? { exclusiveName: opts.exclusiveName } : {}),
    },
    status: 'sent',
    createdAt: now,
  });

  // 24h 未领完 → 退还 (M-J8)。一次性动作问「有没有过」：enqueue 按 id upsert，
  // 盲目重排会把已退还的行覆写回 pending（nudge 之坑，在一条动钱的路径上）。
  const returnId = `rp_return_${id}`;
  if (!(await actionExists(returnId))) {
    await enqueue({
      kind: 'rp_return',
      fireAt: rp.expiresAt!,
      payload: { rpId: id, convId, at: rp.expiresAt },
      now,
      id: returnId,
    });
  }

  // Stagger the AI grabs so the packet gets taken the way a real group does.
  // 专属包只有指定的人会伸手 (M-J8) — 其他人的 grab 行连排都不排（claimShare
  // 里还有第二道纯规则守卫，兜住任何漏网的旧行）。
  const eligible =
    mode === 'exclusive' ? grabbers.filter((g) => g.contactId === opts.exclusiveId) : grabbers;
  for (const g of eligible) {
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
    const peer = rp.senderId !== 'self' ? rp.senderId : undefined;
    await recordWalletTx('rp_in', claim.amountFen, '收到红包', rpId, now, peer);
  }
  // Receiving money warms the edge between sender and claimer (skip self-claims
  // of one's own packet — that's bookkeeping, not a gesture).
  if (claimerId !== rp.senderId) {
    void recordRelEvent(rp.senderId, claimerId, 'rp_received', now).catch(() => {});
    // …and it lifts her mood, not just the relationship number (M-E3). An AI
    // grabbing a packet YOU sent is the clearest positive event in the app.
    if (rp.senderId === 'self' && claimerId !== 'self') {
      void recordAffect(claimerId, 'gift_received', now).catch(() => {});
      // …and the slow version of the same thing (M-H1): reciprocity is the
      // most human money instinct there is, so someone you keep giving to
      // becomes measurably more open-handed themselves.
      void noteDrift(claimerId, 'gift_received', now);
    }
  }

  // Once the last share is gone, settle "best luck" and close the packet.
  const mine = rp.senderId === 'self';
  if (isFullyClaimed(rp, all)) {
    for (const c of markBestLuck(rp, all)) await repo.putClaim(c);
    await repo.putRedPacket({ ...rp, status: 'done' });
    await markRpMessageOpened(rp, hooks, mine ? '已被领完' : '已领取');
  } else if (claimerId === 'self') {
    await markRpMessageOpened(rp, hooks, '');
  }

  // WeChat's grey line names both ends. Before agents could send packets this
  // only ever ran for the user's own, so the sender was left implicit — which
  // rendered as the headless 「你领取了的红包」 the moment one arrived from her.
  const senderName = mine ? '自己' : (await peerName(rp.senderId));
  await hooks.appendMessage({
    convId: rp.convId,
    senderId: 'self',
    type: 'system',
    content:
      claimerId === 'self'
        ? `你领取了${senderName}的红包`
        : `${claimerName}领取了${mine ? '你' : senderName}的红包`,
    status: 'sent',
    createdAt: now,
  });
  return claim;
}

/** Display name for a non-self sender; falls back to the id rather than empty. */
async function peerName(contactId: string): Promise<string> {
  try {
    const c = await repo.getContact(contactId);
    return c?.remark ?? c?.name ?? contactId;
  } catch {
    return contactId;
  }
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

/**
 * 红包 24 小时未领完自动退还 (M-J8).
 *
 * `expiresAt` sat in the schema since M3 with zero readers and zero writers —
 * an unclaimed packet stayed bright orange forever and the sender's money
 * stayed debited forever. Same construction as `returnTransfer`: queued at
 * send time (rule #5, no second timer), idempotent by status — anything but
 * `active` returns immediately, so the row is harmless once the packet was
 * fully claimed (status 'done') or already returned ('expired').
 *
 * @param at the queue row's fireAt — when this "happened", not when the app
 *           happened to be reopened. Clamped below so a backfilled expiry can
 *           never predate the thread's newest row (rowid 序 == 时间序).
 */
export async function returnRedPacket(
  rpId: string,
  hooks: MoneyHooks,
  at?: number,
): Promise<void> {
  const rp = await repo.getRedPacket(rpId);
  if (!rp || rp.status !== 'active') return;

  const claims = await repo.getClaims(rpId);
  const claimedFen = claims.reduce((n, c) => n + c.amountFen, 0);
  const remainingFen = rp.totalFen - claimedFen;
  // Fully claimed but still 'active' would be a broken invariant; whatever the
  // cause, there is no money to move — close the packet and stop.
  if (remainingFen <= 0) {
    await repo.putRedPacket({ ...rp, status: 'done' });
    return;
  }

  const msgs = await repo.getMessages(rp.convId, { limit: 200 });
  const lastAt = msgs.at(-1)?.createdAt ?? 0;
  const now = Math.max(at ?? hooks.now(), lastAt);

  await repo.putRedPacket({ ...rp, status: 'expired' });

  // The unclaimed balance goes home — integer fen, exactly what never left.
  // Only the user's wallet is real (an agent's packet debited nothing).
  if (rp.senderId === 'self') {
    await recordWalletTx('rp_in', remainingFen, '红包退款', `${rpId}_ret`, now);
  }

  const target = msgs.find((m) => m.type === 'rp' && m.meta?.rpId === rp.id);
  if (target) {
    await hooks.updateMessage({
      ...target,
      meta: { ...target.meta, opened: true, statusText: '已过期' },
    });
  }

  // The grey line is the legible half; through render-msg it is also how SHE
  // learns her packet sat there untouched for a day.
  const mine = rp.senderId === 'self';
  await hooks.appendMessage({
    convId: rp.convId,
    senderId: 'self',
    type: 'system',
    content: mine
      ? `红包已过期，退回 ${fenToYuan(remainingFen)} 元`
      : `${await peerName(rp.senderId)}的红包已过期`,
    status: 'sent',
    createdAt: now,
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
  await recordWalletTx('transfer_out', -amountFen, note || '转账', id, now, toId);

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
  // seededRng, not amount-modulo (M-J0): `amountFen % 5` meant the SAME amount
  // always produced the SAME delay — ¥1.00 and ¥6.00 too — which is neither
  // human nor the constitution's sanctioned determinism source (rule 4).
  await enqueue({
    kind: 'transfer_accept',
    fireAt: now + 4_000 + Math.floor(seededRng(`${id}:accept`)() * 5_000),
    payload: { transferId: id, convId },
    now,
  });
  await enqueueTransferReturn(t, now);
  return t;
}

/** WeChat returns an uncollected transfer after 24 hours. So does this one. */
export const TRANSFER_EXPIRE_MS = 24 * 3_600_000;

/**
 * Queue the 24h auto-return for a transfer that was just sent.
 *
 * Queued for BOTH directions. The user→AI direction normally settles in
 * seconds via `transfer_accept`, and then this row finds a non-pending transfer
 * and does nothing — but if that accept ever fails (the executor marks a row
 * done BEFORE running it and never retries), the money left the wallet at send
 * time and nothing would ever put it back. This is that floor.
 *
 * Stable id so a re-send of the same transfer id cannot stack two returns.
 */
async function enqueueTransferReturn(t: TransferVM, now: number): Promise<void> {
  await enqueue({
    kind: 'transfer_return',
    fireAt: now + TRANSFER_EXPIRE_MS,
    payload: { transferId: t.id, convId: t.convId, at: now + TRANSFER_EXPIRE_MS },
    now,
    id: `tr_return_${t.id}`,
  });
}

/**
 * A transfer sent BY an agent, to the user (M-H1).
 *
 * Deliberately NOT auto-accepted: in WeChat an incoming transfer sits there
 * until you tap 收款, and that tap is the whole moment. The chat page already
 * handles the tap for a pending transfer from the peer (`onMoneyTap`), and
 * `acceptTransfer` already credits the wallet whenever `toId === 'self'` — so
 * the money enters the ledger exactly when the user takes it, and never if
 * they don't.
 */
export async function sendTransferFrom(
  fromId: string,
  convId: string,
  amountFen: number,
  note: string,
  hooks: MoneyHooks,
  at?: number,
): Promise<TransferVM> {
  const now = at ?? hooks.now();
  const id = `tr_${now}_${fromId}`;
  const t: TransferVM = {
    id,
    convId,
    fromId,
    toId: 'self',
    amountFen,
    note,
    status: 'pending',
    createdAt: now,
  };
  await repo.putTransfer(t);
  await hooks.appendMessage({
    convId,
    senderId: fromId,
    type: 'transfer',
    content: '',
    meta: { transferId: id, amountFen, note, status: 'pending' },
    status: 'sent',
    createdAt: now,
  });
  // …but it does not sit there forever. 24h uncollected → back to her, which is
  // both WeChat's real behaviour and the case the user actually hits: she sends
  // you money, you never tap 收款, and a permanently pending card is a lie.
  await enqueueTransferReturn(t, now);
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
    await recordWalletTx('transfer_in', t.amountFen, t.note || '转账', t.id, now, t.fromId);
  }
  // A completed transfer is a strong warm gesture between the two parties.
  void recordRelEvent(t.fromId, t.toId, 'transfer_received', now).catch(() => {});
  if (t.fromId === 'self' && t.toId !== 'self') {
    void recordAffect(t.toId, 'gift_received', now).catch(() => {});
    void noteDrift(t.toId, 'gift_received', now);
  }

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

/** What `receiveTransfer` needs to know about HER side of the ledger. */
export interface ReceptionReads {
  personaFor: (contactId: string) => PersonaVM | undefined;
  /** Effective closeness 0..100 for (self → contactId). */
  affinityOf: (contactId: string) => Promise<number>;
  /** Current affect valence −1..1 (negative = she's upset with you). */
  valenceOf: (contactId: string) => Promise<number>;
}

/**
 * The queue-driven arrival of a user→AI transfer (M-J8): she now decides
 * whether to TAKE it, instead of auto-settling any amount in four seconds.
 *
 * Refusal = one persona-flavored line, then the standing 24h `transfer_return`
 * row (`tr_return_<id>`, queued at send) is pulled forward to a seeded 20–60s
 * — the money comes back through the very same kind that already knows how,
 * so refusal adds no second return path (rule #5). The user's own tap on an
 * incoming transfer still calls `acceptTransfer` directly: only HER lane
 * grows a motive.
 *
 * Deliberately zero LLM (`transfer_accept` is declared free in
 * ACTION_LLM_BOUND): the decision and the line are seeded templates.
 */
export async function receiveTransfer(
  transferId: string,
  hooks: MoneyHooks,
  reads: ReceptionReads,
): Promise<'accepted' | 'refused' | 'noop'> {
  const t = await repo.getTransfer(transferId);
  if (!t || t.status !== 'pending') return 'noop';
  // Only the user→AI lane carries a reception motive; anything else settles
  // the pre-J8 way (and a missing persona means there is nobody to refuse).
  const persona = t.fromId === 'self' && t.toId !== 'self' ? reads.personaFor(t.toId) : undefined;
  if (!persona) {
    await acceptTransfer(transferId, hooks);
    return 'accepted';
  }

  const plan = planTransferReception({
    persona,
    amountFen: t.amountFen,
    affinity: await reads.affinityOf(t.toId),
    valence: await reads.valenceOf(t.toId),
    transferId: t.id,
  });
  if (plan.action === 'accept') {
    await acceptTransfer(transferId, hooks);
    return 'accepted';
  }

  const now = hooks.now();
  await hooks.appendMessage({
    convId: t.convId,
    senderId: t.toId,
    type: 'text',
    content: plan.line,
    status: 'sent',
    createdAt: now,
  });
  // Same stable id the send queued — enqueue upserts, so this MOVES the 24h
  // floor row instead of stacking a second return beside it.
  await enqueue({
    kind: 'transfer_return',
    fireAt: now + plan.returnDelayMs,
    payload: { transferId: t.id, convId: t.convId, at: now + plan.returnDelayMs },
    now,
    id: `tr_return_${t.id}`,
  });
  return 'refused';
}

/**
 * 24 小时未收款自动退还.
 *
 * `'returned'` was a status the schema, the VM and the transcript projection
 * all knew about and NOTHING could ever produce — the one branch in render-msg
 * even compared against `'refunded'`, a string this codebase never writes. So
 * an uncollected transfer stayed 「请收款」 forever, the sender's money stayed
 * debited forever, and she had no way to know you never took it.
 *
 * Idempotent by construction: anything but `pending` returns immediately, so
 * the queued row is harmless once the transfer has been accepted (or returned
 * by an earlier duplicate row).
 *
 * @param at the row's `fireAt` — the moment this "happened", per the backfill
 *           rule that a queued action's timestamp is its fire time, not the
 *           moment the app happened to be reopened.
 */
export async function returnTransfer(
  transferId: string,
  hooks: MoneyHooks,
  at?: number,
): Promise<void> {
  const t = await repo.getTransfer(transferId);
  if (!t || t.status !== 'pending') return;

  const msgs = await repo.getMessages(t.convId, { limit: 200 });
  // rowid 序 == 时间序 (CLAUDE.md): this row is inserted NOW, so its timestamp
  // must never predate the newest one already in the thread — a backfilled
  // return can be days behind a conversation that kept going.
  const lastAt = msgs.at(-1)?.createdAt ?? 0;
  const now = Math.max(at ?? hooks.now(), lastAt);

  await repo.putTransfer({ ...t, status: 'returned' });

  // The money goes back where it came from. Only the user has a real wallet:
  // an agent's balance is fiction (see sendRedPacketFrom), so her returned
  // transfer moves no ledger row — it was never debited from one.
  if (t.fromId === 'self') {
    await recordWalletTx('transfer_in', t.amountFen, '转账已退还', `${t.id}_ret`, now, t.toId);
  }

  const target = msgs.find((m) => m.type === 'transfer' && m.meta?.transferId === t.id);
  if (target) {
    await hooks.updateMessage({
      ...target,
      meta: { ...target.meta, status: 'returned', statusText: '已退还' },
    });
  }

  // The system line is what makes it legible in the thread — and, through
  // render-msg, what lets HER know the money came back untouched.
  const mine = t.fromId === 'self';
  const who = mine ? '' : await peerName(t.fromId);
  await hooks.appendMessage({
    convId: t.convId,
    senderId: 'self',
    type: 'system',
    content: mine
      ? '你的转账超过 24 小时未被接收，已退还'
      : `${who}的转账超过 24 小时未被接收，已退还`,
    status: 'sent',
    createdAt: now,
  });
}
