import { describe, it, expect } from 'vitest';
import {
  classifyIncoming,
  INCOMING_CALL_PROB,
  msgNotifId,
  callNotifId,
} from '../../src/native/background-notify';

/**
 * The pure decision core of the background native-alert watcher (M-I10):
 * which surface (none / message / incoming call) a freshly-appended message
 * earns. The seeded-call branch must be deterministic (constitution rule 4).
 */
const base = {
  msg: { id: 42, senderId: 'ai_lin', type: 'text' as const },
  convId: 'c1',
  convType: 'single' as const,
  isHidden: false,
  appVisible: false,
  settings: { bubble: true, incomingCall: true },
};

describe('classifyIncoming', () => {
  it('never surfaces anything while the app is visible', () => {
    expect(classifyIncoming({ ...base, appVisible: true })).toBe('none');
  });

  it('NEVER surfaces a hidden AI↔AI thread — that leak is an irreversible tell', () => {
    expect(classifyIncoming({ ...base, isHidden: true })).toBe('none');
  });

  it('ignores the user’s own messages and system lines', () => {
    expect(classifyIncoming({ ...base, msg: { ...base.msg, senderId: 'self' } })).toBe('none');
    expect(classifyIncoming({ ...base, msg: { ...base.msg, type: 'system' } })).toBe('none');
  });

  it('is deterministic: the same message id always classifies the same way', () => {
    const first = classifyIncoming(base);
    for (let i = 0; i < 20; i++) expect(classifyIncoming(base)).toBe(first);
  });

  it('the call branch appears at roughly the configured probability, and only for singles', () => {
    let calls = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) {
      const r = classifyIncoming({ ...base, msg: { ...base.msg, id: i } });
      if (r === 'call') calls++;
      // Same message in a group must never become a call:
      expect(
        classifyIncoming({ ...base, msg: { ...base.msg, id: i }, convType: 'group' }),
      ).toBe('message');
    }
    expect(calls / N).toBeGreaterThan(INCOMING_CALL_PROB * 0.5);
    expect(calls / N).toBeLessThan(INCOMING_CALL_PROB * 1.8);
  });

  it('the incoming-call toggle silences the call branch entirely', () => {
    for (let i = 0; i < 500; i++) {
      const r = classifyIncoming({
        ...base,
        msg: { ...base.msg, id: i },
        settings: { bubble: true, incomingCall: false },
      });
      expect(r).toBe('message');
    }
  });

  it('non-text messages notify but never ring', () => {
    for (let i = 0; i < 200; i++) {
      expect(
        classifyIncoming({ ...base, msg: { ...base.msg, id: i, type: 'image' } }),
      ).toBe('message');
    }
  });
});

describe('notification ids', () => {
  it('are stable per conversation and distinct between surfaces', () => {
    expect(msgNotifId('c1')).toBe(msgNotifId('c1'));
    expect(callNotifId('c1')).toBe(callNotifId('c1'));
    expect(msgNotifId('c1')).not.toBe(callNotifId('c1'));
    expect(msgNotifId('c1')).not.toBe(msgNotifId('c2'));
  });
});
