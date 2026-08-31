/**
 * "Write me a story about…" → a playable script (M-E5).
 *
 * The three-step chain from specs/story-gm.md — outline → structured JSON →
 * local validation with bounded self-repair — now lives in `generate-chain`
 * (M-H2), because M-H2 adds two more consumers (AI-written persona cards and
 * AI-written群聊) and three copies of a self-repair loop is three places for
 * the repair budget, the JSON extraction and the failure reporting to drift.
 *
 * What stays here is what is specific to a SCRIPT: the two prompts, and the
 * fact that a generated script gets a fresh unique id regardless of what the
 * model named it — two scripts both calling themselves "story_1" would
 * overwrite each other in a store keyed by id.
 */
import type { LlmRouter, NsfwTier } from '../llm/router';
import { validateScript, type Script, type ValidationIssue } from './story-script';
import { runChain, extractJson, repairPrompt, MAX_REPAIRS } from './generate-chain';

export { extractJson, repairPrompt, MAX_REPAIRS };

const OUTLINE_SYSTEM = `你是编剧。根据用户的一句话需求，写一个**两三个角色**的短篇互动剧本大纲。
要求：
- 一句话 logline。
- 每个角色一句人物设定，其中至少一个人有一个「秘密」（别人不知道的事）。
- 3 到 5 幕，每幕一句话说清楚这一幕要发生什么。
- 至少两个不同的结局，且说明分别在什么情况下走向哪个结局。
直接写，不要客套，不要输出 JSON。`;

const JSON_SYSTEM = `把下面的大纲转成剧本 JSON。只输出 JSON，不要任何解释或代码块标记。

结构：
{
  "scriptId": "英文小写下划线id",
  "title": "标题",
  "genre": "类型",
  "nsfwLevel": 0,
  "cast": [{"charId":"英文id","role":"角色名","secret":"只有他知道的事（可省略）"}],
  "vars": {"变量名": 初始值},
  "legacy": {"carry": ["通关后可以带进下一周目的变量名（可省略）"]},
  "entry": "起始节点id",
  "nodes": [{
    "id": "节点id",
    "goal": "这一幕要达成什么（一句话）",
    "onEnter": {"narrate":"进入这一幕时的旁白（可省略）"},
    "pace": "fast 或 slow（可省略：这一幕节奏快还是慢）",
    "directives": [{"charId":"角色id","instruction":"这一幕他要做什么","reveal":"可以透露什么","forbid":"暂时不能说什么"}],
    "triggers": [{"when":"expr:vars.trust >= 2","to":"下一个节点id","effects":{"vars":{"trust":3}}}],
    "timeout": {"turns":8,"to":"兜底去的节点id"},
    "choice": {"prompt":"抛给真人玩家的问题（可省略）","options":[{"label":"选项按钮文字","setVars":{"变量":1},"goto":"目标节点id"}]},
    "ending": false
  }]
}

choice 示例——在关键分岔让真人玩家亲手做决定（剧情会停下来等 TA 点按钮）：
  {"id":"fork","goal":"摊牌前的最后一刻","choice":{"prompt":"要不要把真相说出来？",
   "options":[{"label":"说出来","setVars":{"truth_out":true},"goto":"reveal"},{"label":"再瞒一天","goto":"hide"}]},
   "directives":[],"triggers":[]}

硬性规则（违反会被本地校验打回）：
- 每个 trigger 的 when 必须以 "expr:" 或 "llm:" 开头。expr 只能用 vars.xxx 和 >= <= == != > < && || ! 与字面量。
- 每个 trigger 的 to、每个 timeout 的 to、每个 choice 选项的 goto，都必须是真实存在的节点 id。
- 每个非结局节点必须至少有一个 trigger、一个 timeout 或一个 choice，否则剧情会卡死。
- choice 的 options 是 1-4 个；结局节点不允许带 choice。整个剧本最多放 1-2 个 choice 节点，放在真正的关键分岔上。
- 至少要有一个 "ending": true 的结局节点，且从 entry 出发能走到。
- 每个节点都要能从 entry 走到，不能有孤立节点。
- directives 里的 charId 必须出现在 cast 里。
- entry 节点的 nsfwLevel 必须是 0。`;

export interface GenerateDeps {
  /** Single completion. The caller owns routing (and therefore rule #6). */
  complete: (
    messages: Array<{ role: 'system' | 'user'; content: string }>,
    opts: { json?: boolean; maxTokens?: number },
  ) => Promise<string>;
}

export interface GenerateResult {
  ok: boolean;
  script?: Script;
  /** Every attempt's issues, oldest first — shown when all attempts fail. */
  attempts: ValidationIssue[][];
  error?: string;
}

/**
 * Generate a script from one line of user intent.
 *
 * `tier` is passed straight through to the caller's completion function and is
 * NOT decided here: an adult-themed generation must run on a permissive channel
 * end to end (constitution rule #6), and the call site is the only place that
 * knows the real tier.
 */
export async function generateScript(
  premise: string,
  deps: GenerateDeps,
  now: number,
): Promise<GenerateResult> {
  const out = await runChain<Script>(
    premise,
    {
      label: '剧本',
      outlineSystem: OUTLINE_SYSTEM,
      jsonSystem: JSON_SYSTEM,
      // A stable, unique id regardless of what the model chose.
      prepare: (parsed) =>
        typeof parsed === 'object' && parsed !== null
          ? { ...(parsed as Record<string, unknown>), scriptId: `gen_${now}` }
          : parsed,
      validate: (raw) => {
        const r = validateScript(raw);
        return { ok: r.ok, value: r.script, issues: r.issues };
      },
    },
    deps,
  );
  return {
    ok: out.ok,
    script: out.value,
    attempts: out.attempts as ValidationIssue[][],
    error: out.error,
  };
}

/** The tier an adult-themed generation must run at, end to end. */
export function tierForPremise(premise: string, globalTier: NsfwTier): NsfwTier {
  // Conservative: only an explicit adult ask escalates. Everything else stays
  // wherever the user's global setting already put it.
  const adult = /(成人|情色|色情|露骨|18禁|性(?:爱|描写))/.test(premise);
  return adult ? globalTier : 'off';
}

/** Convenience wrapper binding a router to `GenerateDeps`. */
export function routerDeps(router: LlmRouter, tier: NsfwTier, convKey: string): GenerateDeps {
  return {
    complete: async (messages, opts) =>
      (
        await router.complete(
          { role: 'reasoning', nsfwTier: tier },
          { messages, json: opts.json, maxTokens: opts.maxTokens, temperature: 0.8 },
          {},
          convKey,
        )
      ).text,
  };
}
