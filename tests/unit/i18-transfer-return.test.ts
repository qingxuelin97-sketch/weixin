import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { openDB, idbGetAll, _closeDbForTests } from '../../src/db/idb';
import { repo } from '../../src/db/repo';
import {
  sendTransfer,
  sendTransferFrom,
  acceptTransfer,
  returnTransfer,
  TRANSFER_EXPIRE_MS,
  type MoneyHooks,
} from '../../src/ai/money-service';
import { handleTransferReturn } from '../../src/ai/handlers';
import { pendingActions, type ScheduledAction } from '../../src/ai/scheduler';
import { renderMessageBody } from '../../src/ai/render-msg';
import { SCHEDULED_ACTION_KINDS } from '../../src/db/schema';
import type { MessageVM, TransferVM } from '../../src/data/types';

/**
 * 转账 24 小时未收款自动退还 (M-I18).
 *
 * `'returned'` existed in the schema, in `TransferVM` and in the transcript
 * projection with ZERO producers — an uncollected transfer stayed 「请收款」
 * forever and the sender's money stayed debited forever. Worse, render-msg's
 * branch compared against `'refunded'`, a string this codebase never writes, so
 * even a hand-set status could not have reached the model.
 *
 * The whole feature rides scheduled_actions (铁律 5): the return is queued when
 * the transfer is sent, and the executor drains it — which is also what makes
 * it survive being offline for a week.
 */

const T0 = 1_756_000_000_000;

/** Repo-backed hooks, the same shape useSchedulerRuntime builds. */
function hooksAt(now: number): MoneyHooks & { appended: MessageVM[] } {
  const appended: MessageVM[] = [];
  return {
    appended,
    appendMessage: async (m) => {
      const row = await repo.addMessage(m);
      appended.push(row);
      return row;
    },
    updateMessage: (m) => repo.updateMessage(m),
    now: () => now,
  };
}

const transferMsg = async (convId: string) =>
  (await repo.getMessages(convId, { limit: 50 })).find((m) => m.type === 'transfer');

beforeEach(async () => {
  globalThis.indexedDB = new IDBFactory();
  _closeDbForTests();
  await openDB();
});

describe('the auto-return rides the one time-evolution path', () => {
  it('is a registered kind, not a timer', () => {
    expect(SCHEDULED_ACTION_KINDS).toContain('transfer_return');
  });

  it('sending queues exactly one return, 24h out, under a stable id', async () => {
    const h = hooksAt(T0);
    const t = await sendTransfer('conv_lin', 'ai_lin', 5_00, '请你喝奶茶', h);
    const rows = (await pendingActions()).filter((a) => a.kind === 'transfer_return');
    expect(rows).toHaveLength(1);
    expect(rows[0].fireAt).toBe(T0 + TRANSFER_EXPIRE_MS);
    expect(rows[0].id).toBe(`tr_return_${t.id}`);

    // Her direction too — that is the case the user actually hits.
    const h2 = hooksAt(T0 + 1);
    const t2 = await sendTransferFrom('ai_lin', 'conv_lin', 8_00, '打车钱', h2);
    const rows2 = (await pendingActions()).filter((a) => a.kind === 'transfer_return');
    expect(rows2.map((r) => r.id).sort()).toEqual(
      [`tr_return_${t.id}`, `tr_return_${t2.id}`].sort(),
    );
  });
});

describe('她转给你，你没收 → 24h 后退还', () => {
  it('flips the status, the bubble and the transcript — and adds a system line', async () => {
    const h = hooksAt(T0);
    const t = await sendTransferFrom('ai_lin', 'conv_lin', 8_88, '打车钱', h);
    await repo.putContact({
      id: 'ai_lin',
      type: 'ai',
      name: '林小雨',
      avatarColor: '#000',
      avatarText: '林',
    });

    const at = T0 + TRANSFER_EXPIRE_MS;
    await returnTransfer(t.id, hooksAt(at), at);

    expect((await repo.getTransfer(t.id))?.status).toBe('returned');

    const bubble = await transferMsg('conv_lin');
    expect(bubble?.meta?.status).toBe('returned');
    expect(bubble?.meta?.statusText).toBe('已退还');

    // She has to be able to KNOW you never took it.
    expect(renderMessageBody(bubble as MessageVM)).toContain('已退还');

    const sys = (await repo.getMessages('conv_lin', { limit: 50 })).filter(
      (m) => m.type === 'system',
    );
    expect(sys).toHaveLength(1);
    expect(sys[0].content).toContain('林小雨');
    expect(sys[0].content).toContain('退还');
    expect(sys[0].createdAt).toBe(at);
  });

  it('moves no wallet money — her balance is fiction, and yours was never credited', async () => {
    const h = hooksAt(T0);
    const t = await sendTransferFrom('ai_lin', 'conv_lin', 8_88, '打车钱', h);
    const at = T0 + TRANSFER_EXPIRE_MS;
    await returnTransfer(t.id, hooksAt(at), at);
    expect(await repo.getWalletTxs()).toEqual([]);
  });
});

describe('你转给她，她没收 → 钱回到你的零钱', () => {
  it('credits the ledger back in whole fen and leaves the balance where it started', async () => {
    const h = hooksAt(T0);
    await repo.putWalletTx({
      id: 'seed',
      kind: 'adjust',
      amountFen: 100_00,
      refId: '',
      title: '初始',
      balanceAfterFen: 100_00,
      createdAt: T0 - 1,
    });

    const t = await sendTransfer('conv_lin', 'ai_lin', 12_34, '还你', h);
    const afterSend = await repo.getWalletTxs();
    expect(afterSend.at(-1)?.balanceAfterFen).toBe(100_00 - 12_34);

    const at = T0 + TRANSFER_EXPIRE_MS;
    await returnTransfer(t.id, hooksAt(at), at);

    const txs = await repo.getWalletTxs();
    const back = txs.at(-1)!;
    expect(back.kind).toBe('transfer_in');
    expect(back.amountFen).toBe(12_34);
    expect(Number.isInteger(back.amountFen)).toBe(true);
    // 铁律 3: money round-trips exactly, no float drift.
    expect(back.balanceAfterFen).toBe(100_00);
  });
});

describe('the return is inert once the transfer settled', () => {
  it('an accepted transfer is untouched — no double credit, no second bubble flip', async () => {
    const h = hooksAt(T0);
    const t = await sendTransferFrom('ai_lin', 'conv_lin', 5_00, '', h);
    await acceptTransfer(t.id, hooksAt(T0 + 1_000));
    const txsAfterAccept = await repo.getWalletTxs();

    await returnTransfer(t.id, hooksAt(T0 + TRANSFER_EXPIRE_MS), T0 + TRANSFER_EXPIRE_MS);

    expect((await repo.getTransfer(t.id))?.status).toBe('accepted');
    expect(await repo.getWalletTxs()).toEqual(txsAfterAccept);
    expect((await transferMsg('conv_lin'))?.meta?.status).toBe('accepted');
    expect(
      (await repo.getMessages('conv_lin', { limit: 50 })).filter((m) => m.type === 'system'),
    ).toHaveLength(0);
  });

  it('running it twice returns once', async () => {
    const h = hooksAt(T0);
    const t = await sendTransfer('conv_lin', 'ai_lin', 3_00, '', h);
    const at = T0 + TRANSFER_EXPIRE_MS;
    await returnTransfer(t.id, hooksAt(at), at);
    await returnTransfer(t.id, hooksAt(at + 5), at + 5);
    const txs = (await repo.getWalletTxs()).filter((x) => x.kind === 'transfer_in');
    expect(txs).toHaveLength(1);
  });

  it('a missing or malformed payload is inert, never fatal', async () => {
    const deps = {
      returnTransfer: (id: string, _h: unknown, at?: number) => {
        calls.push(`${id}:${at ?? '-'}`);
        return Promise.resolve();
      },
      hooks: hooksAt(T0),
    } as never;
    const calls: string[] = [];
    await handleTransferReturn(deps, {});
    await handleTransferReturn(deps, { transferId: 42 });
    expect(calls).toEqual([]);
    await handleTransferReturn(deps, { transferId: 'tr_1', at: T0 });
    expect(calls).toEqual([`tr_1:${T0}`]);
  });
});

describe('回填不得倒挂时间戳 (rowid 序 == 时间序)', () => {
  it('a return backfilled behind a live conversation lands after its newest row', async () => {
    const h = hooksAt(T0);
    const t = await sendTransferFrom('ai_lin', 'conv_lin', 6_00, '', h);

    // The thread kept going long after the transfer — the app was simply
    // closed when the 24h mark passed, so the row drains late.
    const later = T0 + 5 * TRANSFER_EXPIRE_MS;
    await repo.addMessage({
      convId: 'conv_lin',
      senderId: 'self',
      type: 'text',
      content: '在忙',
      status: 'sent',
      createdAt: later,
    } as Omit<MessageVM, 'id'>);

    const fireAt = T0 + TRANSFER_EXPIRE_MS; // in the PAST relative to `later`
    await returnTransfer(t.id, hooksAt(later + 1_000), fireAt);

    const rows = await idbGetAll<MessageVM>('messages');
    const ids = rows.map((m) => m.id);
    const times = rows.map((m) => m.createdAt);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(
      times,
      '退还的系统消息时间戳早于会话最后一条——rowid 序与时间序错开，游标分页会乱',
    ).toEqual([...times].sort((a, b) => a - b));
  });
});

describe('the queued row is what actually delivers it', () => {
  it('the handler reads transferId + at off the payload', async () => {
    const h = hooksAt(T0);
    const t = await sendTransferFrom('ai_lin', 'conv_lin', 4_50, '', h);
    const row = (await pendingActions()).find(
      (a: ScheduledAction) => a.kind === 'transfer_return',
    )!;
    const payload = JSON.parse(row.payloadJson) as Record<string, unknown>;

    const at = payload.at as number;
    await handleTransferReturn(
      {
        returnTransfer: (id: string, hooks: MoneyHooks, when?: number) =>
          returnTransfer(id, hooks, when),
        hooks: hooksAt(at),
      } as never,
      payload,
    );

    const settled = (await repo.getTransfer(t.id)) as TransferVM;
    expect(settled.status).toBe('returned');
    expect((await transferMsg('conv_lin'))?.meta?.statusText).toBe('已退还');
  });
});
