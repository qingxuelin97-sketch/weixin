import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { repo } from '../../src/db/repo';
import { idbGetAll, idbPut, idbGetAllByIndex } from '../../src/db/idb';
import {
  enqueue,
  cancelActionsForConversation,
  cancelActionsForContact,
  cancelPendingWhere,
  duePending,
  type ScheduledAction,
} from '../../src/ai/scheduler';
import { LlmRouter, type RoutingPolicy, type RoutePlan } from '../../src/llm/router';
import { LlmError, type ChatProvider, type CompletionResult, type Bubble } from '../../src/llm/types';
import { getErrors, clearErrors } from '../../src/lib/errlog';
import { restoreBackup, exportBackup, type BackupFile } from '../../src/lib/backup';
import { makePolicy } from '../../src/llm/service';
import type { MessageVM, ConversationVM } from '../../src/data/types';

/**
 * M-E0 hardening. Every case here is a bug that was live in the app and shared
 * one property: it failed INVISIBLY. No exception reached the user, no log line
 * was written, the feature simply stopped — which is why they survived four
 * milestones of review.
 */

const T0 = 1_754_800_000_000;

const conv = (id: string): ConversationVM => ({
  id,
  type: 'single',
  peerId: 'ai_z',
  title: 't',
  avatarColor: '#000',
  avatarText: 'z',
  isPinned: false,
  isMuted: false,
  unreadCount: 0,
  mentionMe: false,
  lastMsgPreview: '',
  lastMsgAt: T0,
});

describe('deleting a conversation takes its messages with it', () => {
  it('leaves no orphans that a same-id conversation could resurrect', async () => {
    await repo.putConversation(conv('conv_del'));
    for (let i = 0; i < 3; i++) {
      await repo.addMessage({
        convId: 'conv_del',
        senderId: 'self',
        type: 'text',
        content: `旧消息 ${i}`,
        status: 'sent',
        createdAt: T0 + i,
      });
    }
    await repo.putConvSummary({ convId: 'conv_del', summary: '聊过什么', uptoMsgId: 3, updatedAt: T0 });
    expect(await repo.getMessages('conv_del')).toHaveLength(3);

    await repo.deleteConversation('conv_del');

    expect(await repo.getConversation('conv_del')).toBeUndefined();
    expect(await repo.getMessages('conv_del')).toEqual([]);
    expect(await repo.getConvSummary('conv_del')).toBeUndefined();
    // The real failure mode: rows still indexed under byConv, invisible until a
    // conversation with the same id exists again.
    expect(await idbGetAllByIndex<MessageVM>('messages', 'byConv', 'conv_del')).toEqual([]);

    await repo.putConversation(conv('conv_del'));
    expect(await repo.getMessages('conv_del')).toEqual([]);
  });

  it('does not touch other conversations', async () => {
    await repo.putConversation(conv('conv_keep'));
    await repo.addMessage({
      convId: 'conv_keep',
      senderId: 'self',
      type: 'text',
      content: '留着',
      status: 'sent',
      createdAt: T0,
    });
    await repo.putConversation(conv('conv_drop'));
    await repo.deleteConversation('conv_drop');
    expect(await repo.getMessages('conv_keep')).toHaveLength(1);
  });
});

describe('cancelling a deleted thread’s queue', () => {
  beforeEach(async () => {
    for (const a of await idbGetAll<ScheduledAction>('scheduled_actions')) {
      await idbPut('scheduled_actions', { ...a, status: 'cancelled' });
    }
  });

  it('cancels by conversation without silencing that member elsewhere', async () => {
    await enqueue({ kind: 'heartbeat', fireAt: T0, payload: { convId: 'c1', contactId: 'ai_a' }, now: T0, id: 'hb_c1' });
    await enqueue({ kind: 'heartbeat', fireAt: T0, payload: { convId: 'c2', contactId: 'ai_a' }, now: T0, id: 'hb_c2' });
    await enqueue({ kind: 'group_msg', fireAt: T0, payload: { convId: 'c1', contactId: 'ai_b' }, now: T0, id: 'gm_c1' });

    expect(await cancelActionsForConversation('c1')).toBe(2);

    const live = (await duePending(T0 + 1)).map((a) => a.id);
    expect(live).toContain('hb_c2'); // the same AI's OTHER chat keeps its chain
    expect(live).not.toContain('hb_c1');
    expect(live).not.toContain('gm_c1');
  });

  it('cancels by contact across every payload field the handlers use', async () => {
    await enqueue({ kind: 'heartbeat', fireAt: T0, payload: { convId: 'c9', contactId: 'ai_gone' }, now: T0, id: 'k1' });
    await enqueue({ kind: 'agent_dm', fireAt: T0, payload: { a: 'ai_gone', b: 'ai_other' }, now: T0, id: 'k2' });
    await enqueue({ kind: 'moment_like', fireAt: T0, payload: { authorId: 'ai_gone' }, now: T0, id: 'k3' });
    await enqueue({ kind: 'heartbeat', fireAt: T0, payload: { contactId: 'ai_stay' }, now: T0, id: 'k4' });

    expect(await cancelActionsForContact('ai_gone')).toBe(3);
    expect((await duePending(T0 + 1)).map((a) => a.id)).toEqual(['k4']);
  });

  it('cancels rather than deletes, so a once-ever action cannot be revived', async () => {
    await enqueue({ kind: 'heartbeat', fireAt: T0, payload: { convId: 'c3', nudge: true }, now: T0, id: 'nudge_once' });
    await cancelActionsForConversation('c3');
    // The row must still EXIST — `enqueue` upserts by id, and actionExists() is
    // what stops a completed nudge from being re-queued forever.
    const row = (await idbGetAll<ScheduledAction>('scheduled_actions')).find((a) => a.id === 'nudge_once');
    expect(row?.status).toBe('cancelled');
  });

  it('skips rows with unparseable payloads instead of throwing', async () => {
    await idbPut('scheduled_actions', {
      id: 'broken',
      fireAt: T0,
      kind: 'heartbeat',
      payloadJson: '{not json',
      status: 'pending',
      createdAt: T0,
    });
    await expect(cancelPendingWhere(() => true)).resolves.toBeTypeOf('number');
  });
});

/* ------------------------------------------------------------------ */

class ThrowingProvider implements ChatProvider {
  constructor(
    public readonly id: string,
    public readonly kind: string,
    private err: unknown,
  ) {}
  async complete(): Promise<CompletionResult> {
    throw this.err;
  }
  async *generate(): AsyncIterable<Bubble> {
    /* unused */
  }
  async listModels() {
    return [];
  }
}

describe('the degradation ladder stops eating its errors', () => {
  beforeEach(() => clearErrors());

  it('logs every rung it burned through', async () => {
    const policy: RoutingPolicy = {
      plan(): RoutePlan {
        return {
          provider: new ThrowingProvider('p_main', 'zen', new LlmError('server', '502 upstream')),
          model: 'm',
          fallbacks: [
            { provider: new ThrowingProvider('p_fb', 'custom', new Error('ECONNRESET')), model: 'f' },
          ],
        };
      },
    };
    await expect(
      new LlmRouter(policy).complete({ role: 'chat', nsfwTier: 'off' }, { messages: [] }),
    ).rejects.toThrow();

    const scopes = getErrors().map((e) => e.scope);
    expect(scopes).toContain('llm.primary[p_main]');
    expect(scopes).toContain('llm.fallback[p_fb]');
  });

  it('reports the real failure kind, not a blanket content_filter', async () => {
    const policy: RoutingPolicy = {
      plan(): RoutePlan {
        return {
          provider: new ThrowingProvider('p', 'zen', new LlmError('server', '502 upstream')),
          model: 'm',
          fallbacks: [],
        };
      },
    };
    // Calling an outage "the model refused" sent every diagnosis down the wrong
    // path — the user was told to soften their message, not to check the API.
    const err: LlmError = await new LlmRouter(policy)
      .complete({ role: 'chat', nsfwTier: 'off' }, { messages: [] })
      .then(() => { throw new Error('expected a rejection'); })
      .catch((e: unknown) => e as LlmError);
    expect(err.kind).toBe('server');
    expect(err.message).toContain('502 upstream');
    expect((err.cause as LlmError)?.kind).toBe('server');
  });

  it('still calls a total refusal a content_filter', async () => {
    const refuser: ChatProvider = {
      id: 'r',
      kind: 'zen',
      complete: async () => ({ text: '抱歉，我无法继续', finishReason: 'content_filter' }),
      generate: async function* () {},
      listModels: async () => [],
    };
    const policy: RoutingPolicy = {
      plan: (): RoutePlan => ({ provider: refuser, model: 'm', fallbacks: [] }),
    };
    const err: LlmError = await new LlmRouter(policy)
      .complete({ role: 'chat', nsfwTier: 'off' }, { messages: [] })
      .then(() => { throw new Error('expected a rejection'); })
      .catch((e: unknown) => e as LlmError);
    expect(err.kind).toBe('content_filter');
  });

  it('drops a sticky pin that just failed instead of retrying it every turn', async () => {
    let primaryFails = true;
    const primary: ChatProvider = {
      id: 'p',
      kind: 'zen',
      complete: async () => {
        if (primaryFails) return { text: '抱歉，我无法继续', finishReason: 'content_filter' };
        return { text: 'primary 好了', finishReason: 'stop' };
      },
      generate: async function* () {},
      listModels: async () => [],
    };
    let fbCalls = 0;
    const fb: ChatProvider = {
      id: 'fb',
      kind: 'custom',
      complete: async () => {
        fbCalls++;
        if (fbCalls === 1) return { text: 'fallback 接管', finishReason: 'stop' };
        throw new LlmError('network', 'fallback 挂了');
      },
      generate: async function* () {},
      listModels: async () => [],
    };
    const router = new LlmRouter({
      plan: (): RoutePlan => ({ provider: primary, model: 'm', fallbacks: [{ provider: fb, model: 'f' }] }),
    });

    expect((await router.complete({ role: 'chat', nsfwTier: 'off' }, { messages: [] }, {}, 'c')).text).toBe(
      'fallback 接管',
    );
    // The pin now points at a provider that has since died. Second turn: it
    // fails, the pin must be dropped so turn three starts from the plan again.
    primaryFails = false;
    await router.complete({ role: 'chat', nsfwTier: 'off' }, { messages: [] }, {}, 'c').catch(() => {});
    const third = await router.complete({ role: 'chat', nsfwTier: 'off' }, { messages: [] }, {}, 'c');
    expect(third.text).toBe('primary 好了');
  });
});

describe('a provider with no models fails where it can be understood', () => {
  it('names the cause instead of sending `model: undefined` over the wire', () => {
    const policy = makePolicy({
      providers: [
        { id: 'p_empty', kind: 'zen', label: '空槽位', baseUrl: 'https://x/v1', keyAlias: 'k', models: [], enabled: true },
      ],
      defaultProviderId: 'p_empty',
    });
    expect(() => policy.plan({ role: 'chat', nsfwTier: 'off' })).toThrow(/没有配置任何模型/);
  });
});

describe('restore is all-or-nothing about the destructive phase', () => {
  it('a file that fails to decode never reaches the clear step', async () => {
    await repo.putConversation(conv('conv_precious'));
    await repo.addMessage({
      convId: 'conv_precious',
      senderId: 'self',
      type: 'text',
      content: '这条不能丢',
      status: 'sent',
      createdAt: T0,
    });

    const good = await exportBackup(T0);
    const bad: BackupFile = {
      ...good,
      stores: {
        ...good.stores,
        // Decoding runs during preparation now; before M-E0 it ran per store
        // AFTER earlier stores had already been cleared.
        media: [{ id: 'm1', kind: 'avatar', mime: 'image/png', blobB64: '这不是 base64!!' }],
      },
    };

    await expect(restoreBackup(bad, T0 + 1)).rejects.toThrow();
    expect(await repo.getConversation('conv_precious')).toBeDefined();
    expect(await repo.getMessages('conv_precious')).toHaveLength(1);
  });

  it('a successful restore clears its own in-progress marker', async () => {
    const file = await exportBackup(T0);
    await restoreBackup(file, T0 + 2);
    expect(await repo.getSetting<number>('restoreInProgress')).toBe(0);
  });

  it('never exports the in-progress marker into the file', async () => {
    await repo.putSetting('restoreInProgress', T0);
    const file = await exportBackup(T0);
    const keys = (file.stores.settings ?? []).map((r) => (r as { key?: string }).key);
    expect(keys).not.toContain('restoreInProgress');
  });
});
