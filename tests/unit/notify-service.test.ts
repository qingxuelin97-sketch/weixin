import { describe, it, expect } from 'vitest';
import { toNotifiable, buildNotifications } from '../../src/ai/notify-service';
import { displayBody, NO_PREVIEW_BODY } from '../../src/lib/notify';
import { canPreWriteGreeting } from '../../src/ai/heartbeat';
import { SCHEDULED_ACTION_KINDS } from '../../src/db/schema';
import { makePersona } from '../../src/data/persona-defaults';
import type { ScheduledAction } from '../../src/ai/scheduler';

const NOW = new Date(2025, 7, 6, 12, 0, 0).getTime();
const HOUR = 3_600_000;

function action(over: Partial<ScheduledAction> & { payload?: unknown } = {}): ScheduledAction {
  const { payload, ...rest } = over;
  return {
    id: 'hb_a_1',
    fireAt: NOW + HOUR,
    kind: 'heartbeat',
    payloadJson: JSON.stringify(payload ?? { contactId: 'a', convId: 'conv_a' }),
    status: 'pending',
    createdAt: NOW,
    ...rest,
  };
}

const nameOf = (id: string) => (id === 'a' ? '林小雨' : undefined);

describe('toNotifiable', () => {
  it('keeps pending heartbeats', () => {
    expect(toNotifiable([action()])).toHaveLength(1);
  });

  it('ignores kinds that are not heartbeats', () => {
    expect(toNotifiable([action({ kind: 'moment_like' })])).toEqual([]);
  });

  it('ignores actions that already ran', () => {
    expect(toNotifiable([action({ status: 'done' })])).toEqual([]);
  });

  it('survives a malformed payload instead of throwing', () => {
    expect(toNotifiable([action({ payloadJson: '{not json' })])).toEqual([]);
  });

  it('skips a payload with no contactId', () => {
    expect(toNotifiable([action({ payload: { convId: 'c' } })])).toEqual([]);
  });

  it('picks up a pre-written body', () => {
    const [n] = toNotifiable([action({ payload: { contactId: 'a', body: '早安' } })]);
    expect(n.body).toBe('早安');
  });

  it('treats a blank body as absent', () => {
    const [n] = toNotifiable([action({ payload: { contactId: 'a', body: '   ' } })]);
    expect(n.body).toBeUndefined();
  });
});

describe('buildNotifications', () => {
  it('grades a pre-written body as showable', () => {
    const items = buildNotifications(
      toNotifiable([action({ payload: { contactId: 'a', body: '嘿，忙完啦？' } })]),
      nameOf,
      NOW,
    );
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('greeting');
    expect(displayBody(items[0])).toBe('嘿，忙完啦？');
  });

  it('grades a body-less heartbeat as no-preview', () => {
    const items = buildNotifications(toNotifiable([action()]), nameOf, NOW);
    expect(items[0].kind).toBe('followup');
    expect(displayBody(items[0])).toBe(NO_PREVIEW_BODY);
  });

  it('titles the notification with the contact’s display name', () => {
    expect(buildNotifications(toNotifiable([action()]), nameOf, NOW)[0].title).toBe('林小雨');
  });

  it('drops actions whose contact no longer exists', () => {
    const a = action({ payload: { contactId: 'ghost', convId: 'c' } });
    expect(buildNotifications(toNotifiable([a]), nameOf, NOW)).toEqual([]);
  });

  it('skips already-due actions — the live tick owns those', () => {
    const a = action({ fireAt: NOW - 1000 });
    expect(buildNotifications(toNotifiable([a]), nameOf, NOW)).toEqual([]);
  });

  it('skips anything past the 24h horizon', () => {
    const a = action({ fireAt: NOW + 48 * HOUR });
    expect(buildNotifications(toNotifiable([a]), nameOf, NOW)).toEqual([]);
  });

  it('returns them in fire order', () => {
    const items = buildNotifications(
      toNotifiable([
        action({ id: 'x', fireAt: NOW + 5 * HOUR }),
        action({ id: 'y', fireAt: NOW + 2 * HOUR }),
      ]),
      nameOf,
      NOW,
    );
    expect(items.map((i) => i.fireAt)).toEqual([NOW + 2 * HOUR, NOW + 5 * HOUR]);
  });

  it('gives distinct actions distinct notification ids', () => {
    const items = buildNotifications(
      toNotifiable([
        action({ id: 'hb_a_1', fireAt: NOW + HOUR }),
        action({ id: 'hb_a_2', fireAt: NOW + 2 * HOUR }),
      ]),
      nameOf,
      NOW,
    );
    expect(items[0].id).not.toBe(items[1].id);
  });
});

describe('canPreWriteGreeting', () => {
  const p = makePersona({ contactId: 'a', core: 'c', greeting: '嘿' });

  it('allows a generic opener after a long silence', () => {
    expect(canPreWriteGreeting(p, NOW - 12 * HOUR, NOW)).toBe(true);
  });

  it('refuses it when they spoke recently — it would read as amnesia', () => {
    expect(canPreWriteGreeting(p, NOW - HOUR, NOW)).toBe(false);
  });

  it('allows it for a conversation with no history', () => {
    expect(canPreWriteGreeting(p, undefined, NOW)).toBe(true);
  });

  it('refuses when the persona has no greeting to pre-write', () => {
    const bare = makePersona({ contactId: 'a', core: 'c' });
    expect(canPreWriteGreeting(bare, undefined, NOW)).toBe(false);
  });

  it('treats a whitespace-only greeting as none', () => {
    const blank = makePersona({ contactId: 'a', core: 'c', greeting: '  ' });
    expect(canPreWriteGreeting(blank, undefined, NOW)).toBe(false);
  });
});

describe('scheduled action kinds stay in one place', () => {
  it('covers every kind the runtime enqueues', () => {
    // The TS union is derived from this list, so drift is impossible by
    // construction — this guards the list itself against losing an entry.
    for (const k of ['heartbeat', 'rp_grab', 'transfer_accept', 'moment_post', 'group_msg']) {
      expect(SCHEDULED_ACTION_KINDS).toContain(k);
    }
  });

  it('has no duplicates', () => {
    expect(new Set(SCHEDULED_ACTION_KINDS).size).toBe(SCHEDULED_ACTION_KINDS.length);
  });
});
