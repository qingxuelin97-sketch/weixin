import { describe, it, expect } from 'vitest';
import { voiceUrge, wantsVoice, voiceDirective } from '../../src/ai/voice-send';

/**
 * Voice notes (M-H1).
 *
 * `voice` has been a legal bubble type since M2 and the TTS pipeline works,
 * yet voice notes essentially never happened: the only thing that ever told
 * the model about them was one clause in the base rules. A rule can say the
 * type exists; it cannot say WHEN a person reaches for the mic, because that
 * depends on the hour, her mood, and what was just said.
 */

const at = (h: number) => new Date(2026, 4, 10, h, 0).getTime();

describe('when a person would talk instead of type', () => {
  it('is uncommon by default', () => {
    // A friend who answers everything by voice is a specific and fairly rare
    // kind of person. The default should be the common one.
    expect(voiceUrge({ now: at(14), seed: 's', mood: 'calm' })).toBeLessThan(0.12);
  });

  it('goes up late at night', () => {
    const day = voiceUrge({ now: at(14), seed: 's' });
    expect(voiceUrge({ now: at(23), seed: 's' })).toBeGreaterThan(day);
  });

  it('goes up when she is tired, because typing is work', () => {
    expect(voiceUrge({ now: at(14), seed: 's', mood: 'tired' })).toBeGreaterThan(
      voiceUrge({ now: at(14), seed: 's', mood: 'calm' }),
    );
  });

  it('goes up for something text cannot carry', () => {
    const flat = voiceUrge({ now: at(14), seed: 's', lastUserText: '今天中午吃什么' });
    const heavy = voiceUrge({ now: at(14), seed: 's', lastUserText: '我今天被裁了，挺难受的' });
    expect(heavy).toBeGreaterThan(flat + 0.1);
  });

  it('goes up when the user’s hands are obviously busy', () => {
    expect(voiceUrge({ now: at(14), seed: 's', lastUserText: '我在开车' })).toBeGreaterThan(
      voiceUrge({ now: at(14), seed: 's', lastUserText: '我在家' }),
    );
  });

  it('never becomes the norm, even with everything stacked', () => {
    const p = voiceUrge({
      now: at(1),
      seed: 's',
      mood: 'tired',
      lastUserText: `我在开车，刚跟人吵架了，难受${'很'.repeat(80)}`,
    });
    expect(p).toBeLessThanOrEqual(0.45);
  });

  it('decides the same way twice for the same turn', () => {
    const ctx = { now: at(23), seed: 'conv:42', mood: 'tired' };
    expect(wantsVoice(ctx)).toBe(wantsVoice(ctx));
  });
});

describe('the directive', () => {
  const ctx = { now: at(23), seed: 'yes', mood: 'tired', lastUserText: '我今天被裁了，难受' };

  it('stays silent when the persona has no voice configured', () => {
    // Offering it anyway produces voice bubbles that arrive as silent grey bars.
    expect(voiceDirective({ ttsVoice: undefined }, ctx, true)).toBe('');
  });

  it('stays silent when TTS is not set up at all', () => {
    expect(voiceDirective({ ttsVoice: 'female-shaonv' }, ctx, false)).toBe('');
  });

  it('asks for one short spoken line, not a written one', () => {
    // Find a seed the urge actually fires on — most turns it does not, which
    // is the point.
    let line = '';
    for (let i = 0; i < 100 && !line; i++) {
      line = voiceDirective({ ttsVoice: 'female-shaonv' }, { ...ctx, seed: `s${i}` }, true);
    }
    expect(line).toContain('voice');
    expect(line).toContain('一条就够');
    expect(line).toContain('别写成书面语');
  });
});
