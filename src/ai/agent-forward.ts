/**
 * Cross-conversation forwarding (M-I3): an AI carries something said in a
 * USER-VISIBLE conversation into a group — "说到这个，他之前跟我说……" with the
 * actual line quoted.
 *
 * THE RULE THAT MATTERS (and the reason this module exists at all instead of
 * being three lines in the group engine): content from HIDDEN conversations —
 * the AI↔AI DMs — may NEVER be forwarded verbatim. Those threads exist so
 * agents have a private social life; their content reaches the user only as
 * paraphrased hearsay through the existing gossip path. A verbatim quote from
 * a thread the user has never seen is an irreversible fourth-wall break: it
 * proves the app fabricates conversations. `canForwardFrom` is checked at
 * PLAN time and again at FIRE time (the conversation's hidden flag could have
 * changed between the two), and a leak test locks both.
 *
 * COST: zero LLM calls. The forward is a template around a quote; any color
 * commentary comes later through the group's ordinary reply machinery.
 */
import { seededRng } from '../lib/money';

/** Per completed DM session, given a usable source line exists. */
export const FORWARD_CHANCE = 0.15;

/** The hard rule: only user-visible conversations are quotable. */
export function canForwardFrom(conv: { isHidden?: boolean } | undefined): boolean {
  return Boolean(conv) && !conv?.isHidden;
}

/**
 * Should this DM session end with the speaker carrying a line into the group?
 * Pure and seeded; null on no, or when the source is not quotable.
 */
export function maybeForward(
  sourceConv: { isHidden?: boolean } | undefined,
  lastUserText: string | undefined,
  dmId: string,
  now: number,
): { fireAt: number; quote: string } | null {
  if (!canForwardFrom(sourceConv)) return null;
  const text = lastUserText?.trim();
  if (!text) return null;
  const rng = seededRng(`fwd:${dmId}:${now}`);
  if (rng() >= FORWARD_CHANCE) return null;
  return {
    fireAt: now + Math.round((5 + rng() * 40) * 60_000),
    quote: text.slice(0, 60),
  };
}

/** The forwarded line. A template, not a generation — cost gate is literal 0. */
export function forwardLine(quote: string): string {
  return `说到这个，他之前跟我说：「${quote}」`;
}
