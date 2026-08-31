import { describe, it, expect } from 'vitest';
import {
  importStCard,
  exportStCard,
  isStCard,
  expandMacros,
  parseExamples,
} from '../../src/ai/sillytavern';
import { makePersona } from '../../src/data/persona-defaults';

/**
 * SillyTavern V2 cards (M-H2).
 *
 * `docs/PLAN.md` promised this in M1 and it was never written. It matters more
 * than it looks: V2 is the interchange format for this whole category of app,
 * so without it every character the user already owns is unreachable and every
 * character made here is trapped inside this app.
 */

const card = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: '林小满',
    description: '{{char}} 是一个住在成都的插画师。',
    personality: '嘴硬心软',
    scenario: '{{user}} 是她三年的老朋友',
    first_mes: '{{char}}：在吗',
    mes_example: '<START>\n{{user}}: 在干嘛\n{{char}}: 刚交稿，人没了\n{{char}}: 累死',
    alternate_greetings: ['嗨', '哟'],
    system_prompt: 'You are a helpful assistant.',
    extensions: { someOtherApp: { theirField: 1 } },
  },
};

describe('reading a card', () => {
  it('recognises V2, V1, and refuses anything else', () => {
    expect(isStCard(card)).toBe(true);
    // V1 cards are a bare object with no `spec` — still worth importing.
    expect(isStCard({ name: 'x', description: 'y' })).toBe(true);
    expect(isStCard({ hello: 1 })).toBe(false);
    expect(isStCard(null)).toBe(false);
  });

  it('expands the two macros every card uses', () => {
    // Left in place they surface verbatim mid-reply, which is the single most
    // obvious tell an imported card was never adapted.
    expect(expandMacros('{{char}} 看了 {{user}} 一眼', '小满')).toBe('小满 看了 你 一眼');
  });

  it('takes only the character’s own lines as style samples', () => {
    // The user's half would teach her to imitate the person she is talking to.
    const out = parseExamples(card.data.mes_example, '小满');
    expect(out).toEqual(['刚交稿，人没了', '累死']);
  });
});

describe('importing', () => {
  const out = importStCard(card, 'ai_x')!;

  it('keeps all four prose fields instead of dropping three', () => {
    // A card whose scenario disappeared is a different character.
    expect(out.persona.core).toContain('插画师');
    expect(out.persona.core).toContain('嘴硬心软');
    expect(out.persona.core).toContain('三年的老朋友');
    expect(out.persona.core).not.toContain('{{');
  });

  it('produces a COMPLETE persona, not a half-filled one', () => {
    // Straight through makePersona: a foreign card says nothing about posting
    // rates, and `undefined` there reads as "never posts" with no error.
    expect(typeof out.persona.momentsPerDay).toBe('number');
    expect(typeof out.persona.proactivity).toBe('number');
    expect(out.persona.contactId).toBe('ai_x');
  });

  it('says what it could not take, instead of silently dropping it', () => {
    expect(out.notes.some((n) => n.includes('备用开场白'))).toBe(true);
    // The six-layer prompt order is fixed (constitution §2); splicing a
    // foreign system prompt in would move the NSFW boundary layer.
    expect(out.notes.some((n) => n.includes('system_prompt'))).toBe(true);
  });

  it('refuses junk rather than importing an empty character', () => {
    expect(importStCard({ nope: true }, 'ai_x')).toBeNull();
  });
});

describe('round-tripping', () => {
  const persona = makePersona({
    contactId: 'ai_x',
    core: '插画师，住成都',
    speechStyle: '短句',
    fewShots: ['刚交稿', '累死'],
    greeting: '在吗',
    proactivity: 0.77,
    heartbeatBaseMin: 90,
    generosity: 0.66,
    momentsPerDay: 0.9,
    relations: { user: '老朋友' },
  });

  it('carries this app’s own fields through a foreign format', () => {
    const back = importStCard(exportStCard('林小满', persona), 'ai_y')!;
    expect(back.name).toBe('林小满');
    expect(back.persona.proactivity).toBeCloseTo(0.77);
    expect(back.persona.heartbeatBaseMin).toBe(90);
    expect(back.persona.generosity).toBeCloseTo(0.66);
    expect(back.persona.relations.user).toBe('老朋友');
    expect(back.persona.fewShots).toEqual(['刚交稿', '累死']);
  });

  it('does not delete the parts of someone else’s card it does not understand', () => {
    const out = importStCard(card, 'ai_x')!;
    const again = exportStCard(out.name, out.persona, out.extensions);
    expect(again.data.extensions?.someOtherApp).toEqual({ theirField: 1 });
  });

  it('never exports the NSFW style samples', () => {
    // An export is a file that leaves the device; the most sensitive text in
    // the card should not leave with it by accident.
    const spicy = makePersona({ contactId: 'x', core: 'c', nsfwStyleSamples: ['秘密'] });
    expect(JSON.stringify(exportStCard('x', spicy))).not.toContain('秘密');
  });

  it('writes macros back so the card stays portable', () => {
    // A hard-coded name would read wrong in any app that renames the character.
    expect(exportStCard('林小满', persona).data.mes_example).toContain('{{char}}');
  });
});
