import { describe, it, expect, vi } from 'vitest';
import {
  parseReplyItems,
  dispatchReplies,
  type NativeReplyItem,
  type ReplyDispatchDeps,
} from '../../src/native/reply-drain';

/**
 * The RemoteInput bridge queue (M-I10). The Kotlin side writes SharedPreferences
 * JSON; whatever crosses the bridge is untrusted here — parseReplyItems is the
 * revalidation gate, dispatchReplies the router into the normal send paths.
 */
describe('parseReplyItems', () => {
  it('accepts well-formed reply and call_declined items', () => {
    const items = parseReplyItems([
      { kind: 'reply', convId: 'c1', text: '在呢', at: 1000 },
      { kind: 'call_declined', convId: 'c2', at: 2000 },
    ]);
    expect(items).toEqual([
      { kind: 'reply', convId: 'c1', text: '在呢', at: 1000 },
      { kind: 'call_declined', convId: 'c2', at: 2000 },
    ]);
  });

  it('drops malformed rows item-by-item instead of failing the batch', () => {
    const items = parseReplyItems([
      null,
      42,
      { kind: 'reply', convId: 'c1', text: '好', at: 1 }, // valid
      { kind: 'reply', convId: '', text: 'x', at: 1 }, // empty conv
      { kind: 'reply', convId: 'c1', text: '   ', at: 1 }, // blank text
      { kind: 'reply', convId: 'c1', text: 'x', at: 'soon' }, // bad timestamp
      { kind: 'selfdestruct', convId: 'c1', at: 1 }, // unknown kind
      { kind: 'call_declined', convId: 'c3', at: 3 }, // valid
    ]);
    expect(items.map((i) => i.convId)).toEqual(['c1', 'c3']);
  });

  it('is not an array → empty, never a throw', () => {
    expect(parseReplyItems(undefined)).toEqual([]);
    expect(parseReplyItems('[]')).toEqual([]);
    expect(parseReplyItems({ items: [] })).toEqual([]);
  });

  it('caps text length and batch size (a queue nobody drained for a month)', () => {
    const long = 'x'.repeat(10_000);
    const parsed = parseReplyItems([{ kind: 'reply', convId: 'c1', text: long, at: 1 }]);
    expect(parsed[0].text!.length).toBe(2_000);
    const flood = Array.from({ length: 200 }, (_, i) => ({
      kind: 'reply',
      convId: `c${i}`,
      text: 'hi',
      at: i,
    }));
    expect(parseReplyItems(flood).length).toBe(50);
  });
});

function fakeDeps(over: Partial<ReplyDispatchDeps> = {}): ReplyDispatchDeps & {
  sentSingle: Array<[string, string]>;
  sentGroup: Array<[string, string]>;
  declined: Array<[string, string, number]>;
} {
  const sentSingle: Array<[string, string]> = [];
  const sentGroup: Array<[string, string]> = [];
  const declined: Array<[string, string, number]> = [];
  return {
    sentSingle,
    sentGroup,
    declined,
    convType: (id) => (id.startsWith('g_') ? 'group' : id.startsWith('c_') ? 'single' : undefined),
    peerIdOf: (id) => (id.startsWith('c_') ? `peer_${id}` : undefined),
    sendSingle: async (convId, text) => {
      sentSingle.push([convId, text]);
    },
    sendGroup: async (convId, text) => {
      sentGroup.push([convId, text]);
    },
    appendCallDeclined: async (convId, peerId, at) => {
      declined.push([convId, peerId, at]);
    },
    ...over,
  };
}

describe('dispatchReplies', () => {
  it('routes replies to the matching engine path (single vs group)', async () => {
    const deps = fakeDeps();
    const res = await dispatchReplies(
      [
        { kind: 'reply', convId: 'c_1', text: '单聊', at: 1 },
        { kind: 'reply', convId: 'g_1', text: '群聊', at: 2 },
      ],
      deps,
    );
    expect(deps.sentSingle).toEqual([['c_1', '单聊']]);
    expect(deps.sentGroup).toEqual([['g_1', '群聊']]);
    expect(res).toEqual({ drained: 2, sent: 2, declinedCalls: 0, skipped: 0 });
  });

  it('materializes a declined call as a missed-call record on the peer side', async () => {
    const deps = fakeDeps();
    const res = await dispatchReplies([{ kind: 'call_declined', convId: 'c_1', at: 77 }], deps);
    expect(deps.declined).toEqual([['c_1', 'peer_c_1', 77]]);
    expect(res.declinedCalls).toBe(1);
  });

  it('skips unknown conversations (uninstalled/reset between reply and drain)', async () => {
    const deps = fakeDeps();
    const res = await dispatchReplies([{ kind: 'reply', convId: 'ghost', text: 'x', at: 1 }], deps);
    expect(res).toEqual({ drained: 1, sent: 0, declinedCalls: 0, skipped: 1 });
  });

  it('one failing send does not sink the rest of the queue', async () => {
    const deps = fakeDeps({
      sendSingle: vi
        .fn<(c: string, t: string) => Promise<void>>()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValue(undefined),
    });
    const items: NativeReplyItem[] = [
      { kind: 'reply', convId: 'c_1', text: 'a', at: 1 },
      { kind: 'reply', convId: 'c_2', text: 'b', at: 2 },
    ];
    const res = await dispatchReplies(items, deps);
    expect(res.sent).toBe(1);
    expect(res.skipped).toBe(1);
  });

  it('a group call_declined is skipped — group calls do not exist', async () => {
    const deps = fakeDeps();
    const res = await dispatchReplies([{ kind: 'call_declined', convId: 'g_1', at: 1 }], deps);
    expect(res.skipped).toBe(1);
    expect(deps.declined).toEqual([]);
  });
});
