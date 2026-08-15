/**
 * Patch semantics for personas (M-I1) — the shared safety layer under both
 * one-click group reconfiguration (I1) and one-click humanization (I2).
 *
 * WHY THIS EXISTS: makePersona backfills every missing field with the
 * default. That is exactly right for CREATING a persona and exactly wrong for
 * EDITING one — a regeneration flow that routes its output through makePersona
 * silently RESETS every field the generator didn't mention. Nothing throws;
 * the persona just loses her voice samples, her model override, her relations.
 * The rule, enforced by a source-grep test: rewrite flows apply a
 * `Partial<PersonaVM>` through `applyPersonaPatch`, and never import
 * makePersona.
 *
 * The LOCKED fields can never arrive via a patch, no matter what a model
 * emits. They are either identity (contactId), social state owned by other
 * systems (relations — wiped edges是不可逆的社交失忆), user-curated
 * configuration (modelChat/ttsVoice/imageTags/nsfwPermit), or intimacy
 * material the user wrote (nsfwStyleSamples). A generator that "improves"
 * these is destroying data, so the patch applier strips them and reports what
 * it stripped for the caller to log.
 */
import type { PersonaVM } from './types';
import { clampPersona } from './persona-defaults';

/** Fields a generated patch may never touch. */
export const PERSONA_LOCKED_FIELDS = [
  'contactId',
  'relations',
  'nsfwStyleSamples',
  'nsfwPermit',
  'modelChat',
  'ttsVoice',
  'imageTags',
] as const;

export type PersonaLockedField = (typeof PERSONA_LOCKED_FIELDS)[number];

const LOCKED = new Set<string>(PERSONA_LOCKED_FIELDS);

export interface PatchResult {
  persona: PersonaVM;
  /** Locked or undefined-valued keys that were dropped from the patch. */
  stripped: string[];
}

/**
 * Apply a partial rewrite onto an existing persona.
 *
 * - keys ABSENT from the patch keep their existing value (never defaulted);
 * - keys with an `undefined` value are treated as absent (a model that emits
 *   `"speechStyle": null` must not erase the field);
 * - locked keys are stripped, and reported;
 * - the merged result is clamped like every other persona write.
 */
export function applyPersonaPatch(existing: PersonaVM, patch: Partial<PersonaVM>): PatchResult {
  const stripped: string[] = [];
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    if (LOCKED.has(k)) {
      stripped.push(k);
      continue;
    }
    if (v === undefined || v === null) {
      stripped.push(k);
      continue;
    }
    clean[k] = v;
  }
  return {
    persona: clampPersona({ ...existing, ...(clean as Partial<PersonaVM>) }),
    stripped,
  };
}

/**
 * Merge relation EDGES into a persona — the one sanctioned way to write
 * relations outside the editor.
 *
 * Deliberately a separate API from `applyPersonaPatch` (which refuses
 * relations wholesale): group rebuild legitimately adds edges toward new
 * members, but it must never REPLACE the map — the old second pass did, and a
 * rebuild would have wiped every edge toward people outside the group.
 */
export function mergeRelationEdges(
  existing: PersonaVM,
  edges: Record<string, string>,
): PersonaVM {
  const add: Record<string, string> = {};
  for (const [k, v] of Object.entries(edges)) {
    if (k && v && v.trim()) add[k] = v.trim().slice(0, 60);
  }
  if (Object.keys(add).length === 0) return existing;
  return { ...existing, relations: { ...existing.relations, ...add } };
}

/** Drop one relation edge (used by the deleteContact cascade). */
export function dropRelationEdge(existing: PersonaVM, contactId: string): PersonaVM {
  if (!(contactId in existing.relations)) return existing;
  const rest = { ...existing.relations };
  delete rest[contactId];
  return { ...existing, relations: rest };
}
