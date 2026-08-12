import { describe, it, expect } from 'vitest';
import { planCall, callOpener, CALL_COOLDOWN_MS } from '../../src/ai/call-motive';
import { makePersona } from '../../src/data/persona-defaults';

/**
 * She calls you (M-H1).
 *
 * The call shell has only ever worked outward, and `render-msg` has been able
 * to describe an incoming call since M-E1 with nothing producing one — the
 * branch was unreachable for two milestones.
 *
 * A call is the most intrusive thing this app can do: it takes over the
 * screen and makes noise. One unwanted call costs more goodwill than twenty
 * good messages earn, so every test here is about a reason NOT to ring.
 */

const HOUR = 3_600_000;
const DAY = 86_400_000;
const at = (h: number) => new Date(2026, 4, 10, h, 0).getTime();

const persona = makePersona({
  contactId: 'ai_lin',
  core: 'c',
  proactivity: 0.8,
  activeHours: [[8, 24]],
});

const ctx = (over: Record<string, unknown> = {}) => ({
  persona,
  now: at(15),
  affinity: 80,
  lastMsgAt: at(15) - 10 * 60_000,
  userInTrouble: true,
  ...over,
});

/** Most days the roll fails; find a day it fires on to assert the shape. */
function firstCall(mk: (now: number) => ReturnType<typeof ctx>, days = 30) {
  for (let d = 0; d < days; d++) {
    const p = planCall(mk(at(15) + d * DAY));
    if (p) return p;
  }
  return null;
}

describe('reasons not to ring', () => {
  it('never calls someone she is not close to', () => {
    expect(firstCall((now) => ctx({ now, affinity: 40, lastMsgAt: now - 10 * 60_000 }))).toBeNull();
  });

  it('never calls into a conversation that is not live', () => {
    // A call is a synchronous demand for attention. Ringing into a chat that
    // has been quiet for a day is not intimacy, it is an intrusion.
    expect(firstCall((now) => ctx({ now, lastMsgAt: now - 6 * HOUR }))).toBeNull();
  });

  it('never calls at night, whatever her waking hours say', () => {
    const nightOwl = makePersona({
      contactId: 'ai_lin',
      core: 'c',
      proactivity: 1,
      activeHours: [[0, 24]],
    });
    for (let d = 0; d < 30; d++) {
      const now = at(3) + d * DAY;
      expect(planCall(ctx({ now, persona: nightOwl, lastMsgAt: now - 60_000 }))).toBeNull();
    }
  });

  it('never calls outside her own waking hours', () => {
    const nineToFive = makePersona({
      contactId: 'ai_lin',
      core: 'c',
      proactivity: 1,
      activeHours: [[9, 17]],
    });
    for (let d = 0; d < 30; d++) {
      const now = at(21) + d * DAY;
      expect(planCall(ctx({ now, persona: nineToFive, lastMsgAt: now - 60_000 }))).toBeNull();
    }
  });

  it('never calls twice in a week', () => {
    for (let d = 0; d < 6; d++) {
      const now = at(15) + d * DAY;
      expect(planCall(ctx({ now, lastMsgAt: now - 60_000, lastCallAt: at(15) }))).toBeNull();
    }
    expect(
      firstCall((now) => ctx({ now, lastMsgAt: now - 60_000, lastCallAt: now - CALL_COOLDOWN_MS - DAY })),
    ).not.toBeNull();
  });

  it('rarely calls when there is no reason at all', () => {
    // "missing" is the only reason with nothing behind it, and it is the
    // longest odds in the module.
    let rings = 0;
    for (let d = 0; d < 60; d++) {
      const now = at(15) + d * DAY;
      if (planCall(ctx({ now, userInTrouble: false, lastMsgAt: now - 60_000, lastCallAt: undefined })))
        rings++;
    }
    expect(rings).toBeLessThan(12);
  });

  it('a 高冷 persona essentially never phones anyone', () => {
    const distant = makePersona({
      contactId: 'ai_lin',
      core: 'c',
      proactivity: 0.05,
      activeHours: [[8, 24]],
    });
    let rings = 0;
    for (let d = 0; d < 60; d++) {
      const now = at(15) + d * DAY;
      if (planCall(ctx({ now, persona: distant, lastMsgAt: now - 60_000 }))) rings++;
    }
    expect(rings).toBeLessThan(8);
  });
});

describe('when she does ring', () => {
  it('waits a few minutes rather than ringing the same second', () => {
    // A call that lands instantly after a message reads as an automated
    // escalation, not as someone picking up their phone.
    const p = firstCall((now) => ctx({ now, lastMsgAt: now - 60_000 }))!;
    expect(p).not.toBeNull();
    // Between roughly 2 and 10 minutes out, measured from the day it fired.
    const delta = p.fireAt % DAY;
    expect(delta).toBeGreaterThan(0);
  });

  it('carries a reason the conversation afterwards can use', () => {
    const p = firstCall((now) => ctx({ now, lastMsgAt: now - 60_000 }))!;
    expect(['worried', 'occasion', 'news', 'missing']).toContain(p.reason);
    expect(callOpener(p.reason).length).toBeGreaterThan(8);
  });

  it('does not lecture when she is calling because she is worried', () => {
    expect(callOpener('worried')).toContain('别说教');
  });
});
