/**
 * Per-persona goal templates + user goal edits (M-J1).
 *
 * `goals.ts` is a pure, seeded timeline over a template set; until now that set
 * was the same six hardcoded lives for everyone, so 「准备考一个证」 showed up
 * on the rock climber and the retiree alike. This module supplies the impure
 * edges the pure core must not have:
 *
 *  - **Generated templates**: ONE `runChain` call writes a persona-flavored set
 *    (title + milestones + setbacks + duration + abandon rate), validated by
 *    `sanitizeGoalTemplates` and stored under `goalTpl:<contactId>`. Generation
 *    is triggered from user-attended moments (StatusPage) — never from a chat
 *    turn, so the zero-LLM property of goal *reads* is untouched. A failed or
 *    invalid generation stores nothing and every reader falls back to
 *    `GOAL_TEMPLATES` — 不许空目标.
 *  - **Overrides**: rename the current goal / abandon it now, stored under
 *    `goalOvr:<contactId>` and applied by the pure `applyGoalOverrides`.
 *
 * Every consumer of goal state (engine prompt line, proactive share, moments
 * material, drift, StatusPage) reads through this module, so a generated set or
 * a user edit reaches ALL surfaces at once — one character, one brain.
 */
import type { PersonaVM } from '../data/types';
import { repo } from '../db/repo';
import { logError } from '../lib/errlog';
import { getRouter } from '../llm/service';
import { runChain, type ChainDeps } from './generate-chain';
import {
  GOAL_TEMPLATES,
  GOAL_DOMAINS,
  GOAL_TEMPLATE_BOUNDS,
  agentEpoch,
  applyGoalOverrides,
  goalStateAt,
  latestTerminalEvent,
  sanitizeGoalTemplates,
  type GoalEvent,
  type GoalOverrides,
  type GoalState,
  type GoalTemplate,
} from './goals';

const tplKey = (contactId: string) => `goalTpl:${contactId}`;
const ovrKey = (contactId: string) => `goalOvr:${contactId}`;

/** The template set this agent lives by: stored+valid, else the built-ins. */
export async function goalTemplatesFor(contactId: string): Promise<GoalTemplate[]> {
  try {
    const stored = await repo.getSetting(tplKey(contactId));
    return sanitizeGoalTemplates(stored) ?? GOAL_TEMPLATES;
  } catch {
    return GOAL_TEMPLATES;
  }
}

export async function goalOverridesFor(contactId: string): Promise<GoalOverrides> {
  try {
    const raw = await repo.getSetting<GoalOverrides>(ovrKey(contactId));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

/** The goal state every surface should show: templates + user overrides. */
export async function goalStateFor(contactId: string, now: number): Promise<GoalState> {
  const [templates, ovr] = await Promise.all([
    goalTemplatesFor(contactId),
    goalOverridesFor(contactId),
  ]);
  return applyGoalOverrides(goalStateAt(contactId, now, agentEpoch(contactId), templates), ovr, now);
}

/**
 * The share channel's terminal event, override-aware: a goal the USER abandoned
 * must never be announced as a seeded completion, and the abandonment itself is
 * not news to the person who did it — so an overridden cycle simply goes quiet.
 */
export async function latestTerminalEventFor(
  contactId: string,
  now: number,
): Promise<GoalEvent | null> {
  const [templates, ovr] = await Promise.all([
    goalTemplatesFor(contactId),
    goalOverridesFor(contactId),
  ]);
  const ev = latestTerminalEvent(contactId, now, agentEpoch(contactId), undefined, templates);
  if (ev && ovr.abandoned?.[ev.cycle] != null) return null;
  return ev;
}

/** Rename the goal she is on right now. Empty title = no-op. */
export async function renameCurrentGoal(
  contactId: string,
  now: number,
  title: string,
): Promise<void> {
  const t = title.trim().slice(0, GOAL_TEMPLATE_BOUNDS.titleChars[1]);
  if (!t) return;
  const state = await goalStateFor(contactId, now);
  const ovr = await goalOverridesFor(contactId);
  await repo.putSetting(ovrKey(contactId), {
    ...ovr,
    titles: { ...ovr.titles, [state.cycle]: t },
  } satisfies GoalOverrides);
}

/** She drops the current goal, now. Idempotent; a finished cycle is a no-op. */
export async function abandonCurrentGoal(contactId: string, now: number): Promise<void> {
  const state = await goalStateFor(contactId, now);
  if (state.status !== 'active') return;
  const ovr = await goalOverridesFor(contactId);
  await repo.putSetting(ovrKey(contactId), {
    ...ovr,
    abandoned: { ...ovr.abandoned, [state.cycle]: now },
  } satisfies GoalOverrides);
}

/* ==================================================================== */
/* Generation                                                            */
/* ==================================================================== */

const GOALS_JSON_SYSTEM = `你为一个虚构人物设计 4~6 个「生活尺寸」的长期目标模板，供轮换使用。
要求：
- 每个目标要贴合这个人设的生活，但必须是普通人会有的目标（考证/攒钱/减肥这个量级），
  说出来不违和；禁止宏大叙事（"成为歌手""改变世界"这类一律不要）。
- title 是她自己口中对这件事的叫法，2~24 字。
- milestones 是 3~5 条阶段性状态，用她的第一人称口吻描述"走到哪了"，每条 2~40 字。
- setbacks 是 1~4 条中途受挫的描述，每条 2~40 字。
- typicalDays 是完成这件事的典型天数（20~180 的整数）。
- abandonRate 是她中途放弃的概率（0~0.6 的小数）。
- domain 只能取：study | money | romance | health | career | skill。
只输出 JSON 数组：[{"domain":"study","title":"...","milestones":["..."],"setbacks":["..."],"typicalDays":75,"abandonRate":0.25}]`;

/** In-flight dedupe so a double-mounted page never pays two calls. */
const generating = new Map<string, Promise<boolean>>();

/**
 * Generate-and-store this persona's template set, once ever. Returns whether a
 * generated set is now stored (false = fallback templates stay in force).
 * `deps` is injectable for tests; the default routes through the ordinary
 * router at role `reasoning`, tier off — goal templates are all-ages material.
 */
export async function ensureGoalTemplates(
  contactId: string,
  persona: Pick<PersonaVM, 'core' | 'speechStyle'>,
  deps?: ChainDeps,
): Promise<boolean> {
  try {
    if (sanitizeGoalTemplates(await repo.getSetting(tplKey(contactId)))) return true;
  } catch {
    /* unreadable row → treat as absent */
  }
  const inFlight = generating.get(contactId);
  if (inFlight) return inFlight;

  const run = (async () => {
    const chainDeps: ChainDeps =
      deps ??
      ({
        complete: async (messages, opts) => {
          const router = await getRouter();
          const r = await router.complete(
            { role: 'reasoning', nsfwTier: 'off' },
            { messages, json: opts.json, maxTokens: opts.maxTokens },
            {},
            `goals:${contactId}`,
          );
          return r.text;
        },
      } satisfies ChainDeps);
    const result = await runChain<GoalTemplate[]>(
      {
        sections: [
          { label: '人设', value: persona.core?.slice(0, 400) },
          { label: '说话风格', value: persona.speechStyle?.slice(0, 120) },
          { label: '可用 domain', value: GOAL_DOMAINS.join(' | ') },
        ],
      },
      {
        jsonSystem: GOALS_JSON_SYSTEM,
        label: '目标模板',
        jsonTokens: 1600,
        validate: (raw) => {
          const value = sanitizeGoalTemplates(raw);
          return value
            ? { ok: true, value, issues: [] }
            : {
                ok: false,
                issues: [
                  {
                    code: 'range',
                    message:
                      '模板未通过值域校验：需要 3~8 个目标，每个含 domain/title(2~24字)/' +
                      'milestones(3~5条)/setbacks(1~4条)/typicalDays(20~180)/abandonRate(0~0.6)',
                  },
                ],
              };
        },
      },
      chainDeps,
    );
    if (!result.ok || !result.value) return false;
    await repo.putSetting(tplKey(contactId), result.value);
    return true;
  })().catch((e) => {
    logError('goals.generate', e);
    return false;
  });
  generating.set(contactId, run);
  try {
    return await run;
  } finally {
    generating.delete(contactId);
  }
}
