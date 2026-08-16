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

/**
 * Hard caps on the persona's free text.
 *
 * They live HERE, in the data layer, rather than next to the prompt assembler
 * that also enforces them: `ai/` imports `data/`, so the reverse would be a
 * dependency inversion (and a cycle). `ai/prompt.ts` imports these.
 *
 * Before M-G0 there were no limits anywhere — not on the editor's inputs, not
 * on the write path, not in the prompt. The bounded parts of a system prompt
 * add up to ~2.5k characters; these five fields had no ceiling at all, so one
 * pasted 5,000-character persona rode along on every single turn forever.
 * Generous on purpose: a backstop against pathology, not a style guide.
 */
export const PERSONA_LIMITS = {
  core: 600,
  speechStyle: 120,
  catchphrases: 8,
  catchphraseChars: 24,
  fewShots: 6,
  fewShotChars: 80,
  nsfwSamples: 6,
  nsfwSampleChars: 100,
} as const;

/**
 * The neutral 表情使用率 (M-I19).
 *
 * Lives here, next to the default it equals, because it is the point at which
 * `stickerScale()` returns exactly 1 — every seeded sticker gate keeps the
 * probability it shipped with. Two numbers that must agree, written once.
 */
export const STICKER_RATE_BASELINE = 0.35;

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
  stickerRate: STICKER_RATE_BASELINE,
  affinityInit: 20,
  // Middling by default: she will send something on a birthday or after a
  // fight, and roughly never otherwise.
  generosity: 0.35,
  relations: {},
  imageTags: [],
};

/** Build a complete persona from a partial, filling anything unspecified. */
export function makePersona(p: Partial<PersonaVM> & Pick<PersonaVM, 'contactId' | 'core'>): PersonaVM {
  return clampPersona({ ...PERSONA_DEFAULTS, ...p });
}

const cut = (s: string | undefined, n: number): string | undefined =>
  s == null ? s : s.length > n ? s.slice(0, n) : s;

const cutList = (xs: string[] | undefined, count: number, chars: number): string[] | undefined =>
  xs == null ? xs : xs.slice(0, count).map((s) => String(s ?? '').slice(0, chars));

/**
 * Clamp the free-text fields to what the prompt layer will actually use.
 *
 * `prompt.ts` truncates on the way out, which protects the model; this
 * protects the STORE. The two are not redundant:
 *
 *   - the editor's `maxLength` only guards typing, not paste-then-save of a
 *     5,000-character persona, and not the two writers that bypass the editor
 *     entirely (SillyTavern import and AI-authored cards);
 *   - a row that holds text the prompt will never show is a lie the user reads
 *     back in the editor, and it rides along in every `.aiwx` backup forever.
 *
 * Numbers live in `PERSONA_LIMITS` so the store and the prompt cannot drift.
 */
export function clampPersona(p: PersonaVM): PersonaVM {
  return {
    ...p,
    core: cut(p.core, PERSONA_LIMITS.core) ?? '',
    speechStyle: cut(p.speechStyle, PERSONA_LIMITS.speechStyle),
    fewShots: cutList(p.fewShots, PERSONA_LIMITS.fewShots, PERSONA_LIMITS.fewShotChars) ?? [],
    catchphrases:
      cutList(p.catchphrases, PERSONA_LIMITS.catchphrases, PERSONA_LIMITS.catchphraseChars) ?? [],
    nsfwStyleSamples: cutList(
      p.nsfwStyleSamples,
      PERSONA_LIMITS.nsfwSamples,
      PERSONA_LIMITS.nsfwSampleChars,
    ),
  };
}
