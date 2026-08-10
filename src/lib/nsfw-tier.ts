/**
 * THE tier authority (M-E0, constitution rule #6 closure).
 *
 * Rule #6 says full-tier context must never reach a domestic official endpoint.
 * M-C1 closed that at the ROUTER (fallback set + sticky scoping) — but the
 * router can only honour the tier a caller declares, and nothing stopped a
 * caller from declaring `nsfwTier: 'off'` for context that is actually explicit.
 * Three call sites did exactly that and shipped:
 *
 *   - memory.ts        extractMemory  → verbatim chat transcript, off-tier
 *   - director.ts      callDirector   → last 20 group messages, off-tier
 *   - agent-dm         topic material → a copied group message, off-tier
 *
 * All three routed to `defaultProviderId`, which for a mainland user is almost
 * always DeepSeek. The breach was architectural, not a typo: **a call site must
 * not be able to invent its own tier**. Every LLM call that carries conversation
 * content now derives its tier here, from the same inputs the chat engine uses.
 */
import { repo } from '../db/repo';
import type { NsfwTierVM, PersonaVM, MessageVM } from '../data/types';
import type { NsfwTier } from '../llm/router';

/**
 * Effective tier for one AI: min(global setting, that persona's permit).
 * Mirrors engine.effectiveTier — kept here so non-chat call sites share it.
 */
export function tierFor(globalTier: NsfwTierVM, persona: Pick<PersonaVM, 'nsfwPermit'> | undefined): NsfwTier {
  if (!persona?.nsfwPermit) return 'off';
  return globalTier;
}

/** The strictest (highest) tier among several personas — used for group context. */
export function maxTier(globalTier: NsfwTierVM, personas: Array<Pick<PersonaVM, 'nsfwPermit'> | undefined>): NsfwTier {
  return personas.some((p) => p?.nsfwPermit) ? globalTier : 'off';
}

/** Read the global tier once (default 'off' — absent setting is never permissive). */
export async function globalTier(): Promise<NsfwTierVM> {
  return (await repo.getSetting<NsfwTierVM>('nsfwGlobalTier')) ?? 'off';
}

/**
 * Tier of the material a background job is about to send, derived from the
 * CONVERSATION it came from rather than from the job's own opinion.
 *
 * `contactIds` are the AI participants whose permits gate the content. For a
 * single chat that is the peer; for a group it is every member with a persona.
 */
export async function tierOfConversation(
  contactIds: string[],
  personaFor: (id: string) => PersonaVM | undefined,
): Promise<NsfwTier> {
  const g = await globalTier();
  return maxTier(g, contactIds.map(personaFor));
}

/**
 * Sensitivity to stamp on memory extracted from a transcript at `tier`.
 *
 * specs/nsfw.md requires NSFW facts to live behind an injection whitelist; the
 * extractor hard-coded 'normal', so explicit facts were eligible for Moments
 * and group prompts. Grading at the source is what makes the whitelist possible.
 */
export function sensitivityForTier(tier: NsfwTier): 'normal' | 'sensitive' | 'nsfw' {
  if (tier === 'full') return 'nsfw';
  if (tier === 'ambiguous') return 'sensitive';
  return 'normal';
}

/**
 * Whether a fact of this sensitivity may be injected into a given surface.
 *
 * The rule from specs/nsfw.md: nsfw facts are single-chat + full-tier + that
 * persona's permit ONLY. Groups, Moments and the director never see them.
 */
export function mayInjectFact(
  sensitivity: 'normal' | 'sensitive' | 'nsfw' | undefined,
  surface: 'single' | 'group' | 'moments' | 'director' | 'dm',
  tier: NsfwTier,
): boolean {
  const s = sensitivity ?? 'normal';
  if (s === 'normal') return true;
  if (s === 'sensitive') return surface === 'single' && tier !== 'off';
  // nsfw
  return surface === 'single' && tier === 'full';
}

/**
 * Redact a transcript for a surface that must not carry explicit text.
 * Used when a background job (director) needs conversational context but the
 * content is above its permitted tier: keep who spoke and how long, drop words.
 */
export function redactForTier(
  messages: Array<Pick<MessageVM, 'senderId' | 'content' | 'type'>>,
  nameOf: (id: string) => string,
  keepChars = 20,
): string {
  return messages
    .map((m) => {
      const body = m.content ?? `[${m.type}]`;
      const shown = body.length > keepChars ? `${body.slice(0, keepChars)}…` : body;
      return `${nameOf(m.senderId)}: ${shown}`;
    })
    .join('\n');
}
