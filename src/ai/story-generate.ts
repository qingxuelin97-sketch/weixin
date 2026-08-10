/**
 * "Write me a story about…" → a playable script (M-E5).
 *
 * The three-step chain from specs/story-gm.md: outline → structured JSON →
 * local validation with bounded self-repair. The third step is the one that
 * matters. A model asked for a story graph reliably produces JSON that reads
 * beautifully and does not run: an entry pointing at a node it renamed, edges
 * to beats it decided against, an ending nothing reaches. None of that is
 * visible until the user is three scenes in and the story quietly stops.
 *
 * So generation is not "ask and store". It is ask, CHECK, and hand the model
 * back its own specific failures — at most twice, because a model that cannot
 * produce a valid graph in three attempts will not produce one in ten, and the
 * honest outcome then is a clear error rather than a broken script.
 */
import type { LlmRouter, NsfwTier } from '../llm/router';
import { validateScript, type Script, type ValidationIssue } from './story-script';

export const MAX_REPAIRS = 2;

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
  "entry": "起始节点id",
  "nodes": [{
    "id": "节点id",
    "goal": "这一幕要达成什么（一句话）",
    "onEnter": {"narrate":"进入这一幕时的旁白（可省略）"},
    "directives": [{"charId":"角色id","instruction":"这一幕他要做什么","reveal":"可以透露什么","forbid":"暂时不能说什么"}],
    "triggers": [{"when":"expr:vars.trust >= 2","to":"下一个节点id","effects":{"vars":{"trust":3}}}],
    "timeout": {"turns":8,"to":"兜底去的节点id"},
    "ending": false
  }]
}

硬性规则（违反会被本地校验打回）：
- 每个 trigger 的 when 必须以 "expr:" 或 "llm:" 开头。expr 只能用 vars.xxx 和 >= <= == != > < && || ! 与字面量。
- 每个 trigger 的 to、每个 timeout 的 to，都必须是真实存在的节点 id。
- 每个非结局节点必须至少有一个 trigger 或一个 timeout，否则剧情会卡死。
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

/** Strip fences and any prose the model wrapped its JSON in. */
export function extractJson(text: string): unknown {
  const body = text
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  try {
    return JSON.parse(body);
  } catch {
    // Second chance: the outermost balanced braces. Models like to add a
    // sentence of introduction no matter how firmly they are told not to.
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

/** Turn validation issues into a repair instruction the model can act on. */
export function repairPrompt(issues: ValidationIssue[]): string {
  const lines = issues.slice(0, 8).map((i) => `- ${i.message}`);
  return [
    '上面这份 JSON 没有通过本地校验，问题如下：',
    ...lines,
    '',
    '请只修这些问题，保持其余内容不变，重新输出完整 JSON。不要解释。',
  ].join('\n');
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
  const attempts: ValidationIssue[][] = [];

  let outline: string;
  try {
    outline = await deps.complete(
      [
        { role: 'system', content: OUTLINE_SYSTEM },
        { role: 'user', content: premise.slice(0, 300) },
      ],
      { maxTokens: 900 },
    );
  } catch (e) {
    return { ok: false, attempts, error: `写大纲失败：${errText(e)}` };
  }
  if (!outline.trim()) return { ok: false, attempts, error: '模型没有返回大纲' };

  const history: Array<{ role: 'system' | 'user'; content: string }> = [
    { role: 'system', content: JSON_SYSTEM },
    { role: 'user', content: outline },
  ];

  for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
    let raw: string;
    try {
      raw = await deps.complete(history, { json: true, maxTokens: 3000 });
    } catch (e) {
      return { ok: false, attempts, error: `生成剧本失败：${errText(e)}` };
    }

    const parsed = extractJson(raw);
    if (parsed === null) {
      const issue: ValidationIssue = { code: 'schema', message: '返回的不是合法 JSON' };
      attempts.push([issue]);
      history.push({ role: 'user', content: repairPrompt([issue]) });
      continue;
    }

    // Give the script a stable, unique id regardless of what the model chose:
    // two generated scripts both calling themselves "story_1" would overwrite
    // each other in a store keyed by id.
    const withId =
      typeof parsed === 'object' && parsed !== null
        ? { ...(parsed as Record<string, unknown>), scriptId: `gen_${now}` }
        : parsed;

    const result = validateScript(withId);
    if (result.ok && result.script) return { ok: true, script: result.script, attempts };

    attempts.push(result.issues);
    history.push({ role: 'user', content: raw.slice(0, 6000) });
    history.push({ role: 'user', content: repairPrompt(result.issues) });
  }

  return {
    ok: false,
    attempts,
    // Named plainly: a story that cannot run is not a story, and pretending
    // otherwise strands the user mid-play instead of here.
    error: `模型连续 ${MAX_REPAIRS + 1} 次没能生成可运行的剧本。最后一次的问题：${
      attempts.at(-1)?.map((i) => i.message).join('；') ?? '未知'
    }`,
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

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
