/**
 * Persona field defaults, mirroring the `.default()` values on the persona
 * columns in src/db/schema.ts.
 *
 * Personas gain fields as features land (Moments added four). Without a single
 * defaults source, every new field means editing every seed row, every test
 * fixture, and the persona editor — and a missed one becomes `undefined` at
 * runtime, where it silently reads as "never posts" or "never likes".
 */
import type { PersonaVM } from './types';

/** Not `as const` — the array fields must stay mutable to satisfy PersonaVM. */
export const PERSONA_DEFAULTS: Omit<PersonaVM, 'contactId' | 'core'> = {
  fewShots: [],
  catchphrases: [],
  activeHours: [[9, 23]],
  proactivity: 0.4,
  typingCpm: 300,
  heartbeatBaseMin: 240,
  temperature: 0.8,
  nsfwPermit: false,
  momentsPerDay: 0.3,
  likeRate: 0.5,
  commentRate: 0.25,
  affinityInit: 20,
};

/** Build a complete persona from a partial, filling anything unspecified. */
export function makePersona(p: Partial<PersonaVM> & Pick<PersonaVM, 'contactId' | 'core'>): PersonaVM {
  return { ...PERSONA_DEFAULTS, ...p };
}
