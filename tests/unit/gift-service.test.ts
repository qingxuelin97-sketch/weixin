import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { MessageVM } from '../../src/data/types';

/**
 * Delivering a gift (M-H1).
 *
 * `money-motive` decides; this is the half that writes rows, and the rows are
 * where the expensive mistakes live: an agent's packet must not move the
 * user's balance, an incoming transfer must not accept itself, and a queued
 * gift must not be able to fire twice.
 */

/* --------- a repo that is only what these two modules actually touch --------- */

const settings = new Map<string, unknown>();
const packets = new Map<string, Record<string, unknown>>();
const transfers = new Map<string, Record<string, unknown>>();
const walletTxs: Array<Record<string, unknown>> = [];

// Only `repo` is doubled — the module's CONSTANTS (REL_PAIR_SEP, the cascade
// ledgers) pass through, so adding one there never breaks this mock again.
vi.mock('../../src/db/repo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/db/repo')>()),
  repo: {
    getSetting: async (k: string) => settings.get(k),
    putSetting: async (k: string, v: unknown) => void settings.set(k, v),
    getMemory: async () => [],
    getMessages: async () => [],
    firstMessageAt: async () => undefined,
    getContact: async (id: string) => ({ id, name: id }),
    putRedPacket: async (rp: Record<string, unknown>) => void packets.set(rp.id as string, rp),
    getRedPacket: async (id: string) => packets.get(id),
    putTransfer: async (t: Record<string, unknown>) => void transfers.set(t.id as string, t),
    getTransfer: async (id: string) => transfers.get(id),
    getWalletTxs: async () => walletTxs,
    putWalletTx: async (tx: Record<string, unknown>) => void walletTxs.push(tx),
    getClaims: async () => [],
    putClaim: async () => {},
  },
}));

vi.mock('../../src/db/idb', () => {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    idbGet: async (_s: string, k: string) => rows.get(k),
    idbGetAll: async () => [...rows.values()],
    idbPut: async (_s: string, row: Record<string, unknown>) => void rows.set(row.id as string, row),
    idbDelete: async (_s: string, k: string) => void rows.delete(k),
    idbRangeByIndex: async () => [...rows.values()],
    idbGetAllByIndex: async (_s: string, index: string, value: IDBValidKey) => {
      const field = index === 'byStatus' ? 'status' : 'id';
      return [...rows.values()].filter((r) => r[field] === value);
    },
    __rows: rows,
  };
});

import { runGift, considerGift } from '../../src/ai/gift-service';
import { pendingActions } from '../../src/ai/scheduler';
import { makePersona } from '../../src/data/persona-defaults';
import type { ConversationVM } from '../../src/data/types';

const T0 = new Date(2026, 4, 10, 14, 0).getTime();

const appended: Array<Omit<MessageVM, 'id'>> = [];
const hooks = {
  appendMessage: async (m: Omit<MessageVM, 'id'>) => {
    appended.push(m);
    return { ...m, id: appended.length } as MessageVM;
  },
  updateMessage: async () => {},
  now: () => T0,
};

const deps = {
  hooks,
  grabbers: () => [],
  contactById: (id: string) => ({ id, name: '林小雨' }) as never,
  now: () => T0,
};

beforeEach(() => {
  appended.length = 0;
  walletTxs.length = 0;
  packets.clear();
  transfers.clear();
  settings.clear();
});

describe('a transfer from her', () => {
  const payload = {
    convId: 'c1',
    contactId: 'ai_lin',
    kind: 'transfer' as const,
    reason: 'apology',
    amountFen: 5_200,
    note: '刚才是我不好',
    line: '别生气了行不行',
  };

  it('says something first, then sends the money', async () => {
    await runGift(payload, deps);
    expect(appended[0].type).toBe('text');
    expect(appended[0].content).toBe('别生气了行不行');
    expect(appended[1].type).toBe('transfer');
    // Both from her — the whole point is that the money is moving the other way.
    expect(appended.every((m) => m.senderId === 'ai_lin')).toBe(true);
  });

  it('never touches the user’s wallet', async () => {
    await runGift(payload, deps);
    // Her money is fiction. Debiting a ledger for it would make the balance
    // page — the one honest number in the app — a lie.
    expect(walletTxs).toHaveLength(0);
  });

  it('waits to be collected instead of accepting itself', async () => {
    await runGift(payload, deps);
    const t = [...transfers.values()][0];
    expect(t.status).toBe('pending');
    expect(t.toId).toBe('self');
    // In WeChat the tap on 收款 is the moment. Auto-accepting would skip it —
    // and would credit the wallet for money the user never took.
    const queued = (await pendingActions()).map((a) => a.kind);
    expect(queued).not.toContain('transfer_accept');
  });
});

describe('a red packet from her', () => {
  it('is a real packet with the shares pre-split', async () => {
    await runGift(
      {
        convId: 'c1',
        contactId: 'ai_lin',
        kind: 'rp',
        reason: 'birthday',
        amountFen: 8_888,
        note: '生日快乐',
        line: '生日快乐呀',
        count: 1,
      },
      deps,
    );
    const rp = [...packets.values()][0];
    expect(rp.senderId).toBe('ai_lin');
    expect((rp.sharesFen as number[]).reduce((a, b) => a + b, 0)).toBe(8_888);
    expect(walletTxs).toHaveLength(0);
  });

  it('a malformed payload becomes nothing, not a ¥0.00 packet', async () => {
    await runGift({ convId: '', contactId: '' } as never, deps);
    expect(appended).toHaveLength(0);
    expect(packets.size).toBe(0);
  });
});

describe('planning cannot fire the same gift twice', () => {
  const conv: ConversationVM = {
    id: 'c1',
    type: 'single',
    peerId: 'ai_lin',
    title: '林小雨',
    avatarColor: '#000',
    avatarText: '林',
    isPinned: false,
    isMuted: false,
    unreadCount: 0,
    mentionMe: false,
    lastMsgPreview: '',
    lastMsgAt: T0,
  };
  const persona = makePersona({ contactId: 'ai_lin', core: 'c', generosity: 1, affinityInit: 90 });
  const recentAt = (now: number) =>
    [
      {
        id: 1,
        convId: 'c1',
        senderId: 'self',
        type: 'text',
        content: '好累啊',
        status: 'sent',
        createdAt: now - 7_200_000,
      },
    ] as MessageVM[];

  it('is idempotent across repeated foreground passes', async () => {
    // Most days the planner says no, so first find a day it says yes on —
    // asserting on a day where nothing was queued would prove nothing.
    let now = T0;
    let queued = false;
    for (let d = 0; d < 40 && !queued; d++) {
      now = T0 + d * 86_400_000;
      queued = await considerGift({ conv, persona, now, recent: recentAt(now) });
    }
    expect(queued).toBe(true);

    // `enqueue` upserts by id, so a second pass that re-planned the same day
    // would flip an already-delivered gift back to pending and send it again —
    // the nudge trap, in the one code path where it costs money.
    const again = await considerGift({ conv, persona, now: now + 60_000, recent: recentAt(now) });
    expect(again).toBe(false);
    expect((await pendingActions()).filter((a) => a.kind === 'ai_money')).toHaveLength(1);
  });

  it('records when she last gave, so the cooldown has something to read', async () => {
    await runGift(
      { convId: 'c1', contactId: 'ai_lin', kind: 'rp', reason: 'treat', amountFen: 666, note: '拿去花', line: '' },
      deps,
    );
    expect(settings.get('giftAt:c1')).toBe(T0);
  });
});
