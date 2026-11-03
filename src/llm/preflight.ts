/**
 * Pre-dispatch gate (M-J1): runs before ANY provider call the router makes.
 *
 * Installed by the app shell with `cost-gate.checkBudget` — it lives behind a
 * setter because the dependency direction is `ai → llm`, never the reverse
 * (constitution §1): the router cannot import the gate, so the gate installs
 * itself into the router. Throwing `LlmError('budget')` here aborts the call
 * BEFORE the degradation ladder — every rung of that ladder is itself a call,
 * so laddering an over-budget request would spend money to honour a spending
 * limit. Unset (tests, cold paths) = no gate.
 *
 * Its own module since M-L1: the gate is installed from code that sits in the
 * cold-start bundle, and the setter used to live in router.ts — importing it
 * pulled the router, the providers and zod into every launch. This file must
 * stay free of LLM runtime imports (guard: l1-lean-main.test.ts).
 */
import { LlmError } from './errors';

export type LlmPreflight = (now: number) => Promise<void>;

let preflight: LlmPreflight | null = null;

export function setLlmPreflight(fn: LlmPreflight | null): void {
  preflight = fn;
}

/** Run the installed gate, if any. Called by the router before every dispatch. */
export async function runLlmPreflight(now: number): Promise<void> {
  if (preflight) await preflight(now);
}

export function isBudgetError(e: unknown): boolean {
  return e instanceof LlmError && e.kind === 'budget';
}
