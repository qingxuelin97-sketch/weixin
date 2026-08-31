/**
 * 全局成本闸 (M-J1): an hourly/daily budget on LLM calls, enforced in code.
 *
 * The usage page (M-E6) made spending VISIBLE; nothing yet made it BOUNDED. A
 * stuck chain, a hot group, or simply a very social day can burn the user's
 * key unattended — and "the app spent 900 calls overnight" is the one failure
 * that costs real money regardless of how gracefully everything else degrades.
 *
 * Enforcement points, in order:
 *   1. **Router preflight** — `checkBudget` installs into `setLlmPreflight`
 *      (the dependency direction is `ai → llm`, so the gate walks over to the
 *      router, never the reverse). Every provider call this app makes passes
 *      through the router, so this is the one honest choke point. Over budget
 *      → `LlmError('budget')` BEFORE anything leaves the process, and before
 *      the degradation ladder (each rung would be another call).
 *   2. **Scheduler pre-gate** — `schedulerBudgetGate` (installed via
 *      `setBudgetGate`) defers LLM-bound queue actions while over budget:
 *      the row stays PENDING with `fireAt` pushed to when the budget window
 *      rolls, so nothing is lost, just late. Free kinds (a red-packet grab, a
 *      recall flip) run regardless — they cost rows, not money.
 *   3. **Engine catch** — a user-facing turn that trips mid-flight closes in
 *      character (「有点累了，晚点聊」, engine.ts), never with a raw error.
 *
 * Counters use the wall clock (same precedent as `recordUsage`): the budget is
 * an operational policy about real spending in real time, not replayable world
 * state — nothing here feeds `simulate()` or a seeded decision.
 */
import { repo } from '../db/repo';
import { LlmError } from '../llm/types';
import { setLlmPreflight, isBudgetError } from '../llm/router';
import type { ScheduledActionKind } from '../db/schema';

export { isBudgetError };

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export interface LlmBudget {
  /** Max LLM calls per rolling clock hour. */
  hour: number;
  /** Max LLM calls per calendar day (UTC bucket, same as usage:daily). */
  day: number;
}

export const DEFAULT_LLM_BUDGET: LlmBudget = { hour: 60, day: 600 };

const BUDGET_KEY = 'llmBudget';
const SPEND_KEY = 'llmSpend';

interface SpendRow {
  /** Hour bucket (floor(now/1h)) and its count. */
  h: number;
  hc: number;
  /** Day bucket (floor(now/24h)) and its count. */
  d: number;
  dc: number;
}

const posInt = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : fallback;

/** The configured budget, defaults filled in. Absent/garbage rows never widen. */
export async function getLlmBudget(): Promise<LlmBudget> {
  try {
    const raw = await repo.getSetting<Partial<LlmBudget>>(BUDGET_KEY);
    return {
      hour: posInt(raw?.hour, DEFAULT_LLM_BUDGET.hour),
      day: posInt(raw?.day, DEFAULT_LLM_BUDGET.day),
    };
  } catch {
    return { ...DEFAULT_LLM_BUDGET };
  }
}

export async function setLlmBudget(budget: LlmBudget): Promise<void> {
  await repo.putSetting(BUDGET_KEY, {
    hour: posInt(budget.hour, DEFAULT_LLM_BUDGET.hour),
    day: posInt(budget.day, DEFAULT_LLM_BUDGET.day),
  });
}

function rolled(raw: unknown, now: number): SpendRow {
  const h = Math.floor(now / HOUR);
  const d = Math.floor(now / DAY);
  const r = (raw ?? {}) as Partial<SpendRow>;
  return {
    h,
    hc: r.h === h && typeof r.hc === 'number' ? r.hc : 0,
    d,
    dc: r.d === d && typeof r.dc === 'number' ? r.dc : 0,
  };
}

// Read-modify-write on one settings row; concurrent group actors all check at
// once, so the writes serialize through a chain (same shape as rel_edges).
let chain: Promise<unknown> = Promise.resolve();

/**
 * THE gate: spend one unit or throw. Called by the router before dispatch.
 *
 * Over budget → `LlmError('budget', …)` and the counter is NOT advanced — the
 * (N+1)th call is rejected, not billed. Storage failure → allow: an IDB hiccup
 * must degrade to "unmetered", never to "mute".
 */
export function checkBudget(now: number): Promise<void> {
  const run = async (): Promise<void> => {
    let budget: LlmBudget;
    let spend: SpendRow;
    try {
      budget = await getLlmBudget();
      spend = rolled(await repo.getSetting<SpendRow>(SPEND_KEY), now);
    } catch {
      return; // accounting must never brick the conversation
    }
    if (spend.hc >= budget.hour || spend.dc >= budget.day) {
      const which = spend.hc >= budget.hour ? `本小时 ${budget.hour}` : `今日 ${budget.day}`;
      throw new LlmError('budget', `LLM 调用预算已用完（${which} 次）`);
    }
    try {
      await repo.putSetting(SPEND_KEY, { ...spend, hc: spend.hc + 1, dc: spend.dc + 1 });
    } catch {
      /* counting failed; the call itself may proceed */
    }
  };
  const p = chain.then(run, run);
  // Keep the chain alive but let the caller see the throw.
  chain = p.catch(() => {});
  return p;
}

/** Non-spending probe for the scheduler pre-gate. */
export async function overBudget(now: number): Promise<boolean> {
  try {
    const budget = await getLlmBudget();
    const spend = rolled(await repo.getSetting<SpendRow>(SPEND_KEY), now);
    return spend.hc >= budget.hour || spend.dc >= budget.day;
  } catch {
    return false;
  }
}

/** When a deferred action should try again: the next window that could clear. */
export async function budgetRetryAt(now: number): Promise<number> {
  try {
    const budget = await getLlmBudget();
    const spend = rolled(await repo.getSetting<SpendRow>(SPEND_KEY), now);
    if (spend.dc >= budget.day) return (Math.floor(now / DAY) + 1) * DAY;
  } catch {
    /* fall through to the hourly roll */
  }
  return (Math.floor(now / HOUR) + 1) * HOUR;
}

/** For the usage page: today's spend against the budget, plus the hour view. */
export async function budgetStatus(
  now: number,
): Promise<{ hourUsed: number; hourBudget: number; dayUsed: number; dayBudget: number }> {
  const budget = await getLlmBudget();
  let spend: SpendRow;
  try {
    spend = rolled(await repo.getSetting<SpendRow>(SPEND_KEY), now);
  } catch {
    spend = rolled(undefined, now);
  }
  return { hourUsed: spend.hc, hourBudget: budget.hour, dayUsed: spend.dc, dayBudget: budget.day };
}

/* ==================================================================== */
/* Scheduler pre-gate                                                    */
/* ==================================================================== */

/**
 * Which queue kinds make LLM calls when they fire. TOTAL over the kind list —
 * the compiler forces every new `SCHEDULED_ACTION_KINDS` entry to declare its
 * cost here, exactly like `simulate.ts`'s LLM_COST table does for backfill.
 * `true` means the drain would spend money; the pre-gate defers those while
 * over budget and lets the free kinds through untouched.
 */
export const ACTION_LLM_BOUND: Record<ScheduledActionKind, boolean> = {
  heartbeat: true,
  rp_grab: false,
  transfer_accept: false,
  moment_post: true,
  moment_like: false,
  moment_comment: true,
  group_msg: true,
  agent_dm: true,
  recall: false,
  mem_extract: true,
  story_tick: true,
  ai_money: false, // line + note were written by the planner
  ai_call: true, // answering the ring starts a scripted session
  joint_plan: true,
  agent_forward: false, // forwardLine is a template
  group_event: true,
  agent_invite: false, // inviteLine is a template
  moment_repost: true,
  auto_backup: false,
  sticker_reply: false,
  transfer_return: false,
};

/**
 * The scheduler's gate: null = run it, a timestamp = keep it PENDING and try
 * then. Deferring (not dropping) is the point — the world pauses when the
 * wallet says so and resumes by itself, with rule #5's single queue intact.
 */
export async function schedulerBudgetGate(
  kind: ScheduledActionKind,
  now: number,
): Promise<number | null> {
  if (!ACTION_LLM_BOUND[kind]) return null;
  if (!(await overBudget(now))) return null;
  return budgetRetryAt(now);
}

/** Wire the gate into the router. Called once by the app shell. */
export function installCostGate(): void {
  setLlmPreflight(checkBudget);
}

export function uninstallCostGate(): void {
  setLlmPreflight(null);
}
