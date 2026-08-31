/**
 * Ask → check → hand back the specific failures (M-H2).
 *
 * `story-generate` established this chain and it is the reason story mode
 * works at all: a model asked for structured content reliably produces JSON
 * that reads beautifully and does not RUN — an edge to a node it renamed, a
 * field it decided to omit, a reference to something that does not exist.
 * None of that is visible until the user is three scenes in.
 *
 * The chain is therefore: outline (optional, prose — models plan better in
 * prose than in JSON), then JSON, then LOCAL validation, then at most two
 * repairs that quote the model its own specific failures. Two, because a model
 * that cannot produce a valid object in three attempts will not produce one in
 * ten, and the honest outcome then is a clear error rather than a broken
 * artifact stored as if it were fine.
 *
 * Extracted here because M-H2 adds two more consumers — AI-written persona
 * cards and AI-written群聊 — and three copies of a self-repair loop is three
 * places for the repair budget, the JSON extraction and the failure reporting
 * to drift apart.
 *
 * Routing (and therefore constitution rule #6) stays with the CALLER: only the
 * call site knows the real tier of what is being generated.
 */

export const MAX_REPAIRS = 2;

/** Machine-readable so a repair prompt can target a fix, not just complain. */
export interface GenIssue {
  code: string;
  message: string;
}

export interface ChainDeps {
  complete: (
    messages: Array<{ role: 'system' | 'user'; content: string }>,
    opts: { json?: boolean; maxTokens?: number },
  ) => Promise<string>;
  /** Progress for long chains ("正在生成第 3/12 个成员"). Optional. */
  onProgress?: (note: string) => void;
}

export interface ChainSpec<T> {
  /**
   * Prose planning step. Omit for small artifacts: an outline doubles the cost
   * and only pays off when the structure is big enough to need planning.
   */
  outlineSystem?: string;
  jsonSystem: string;
  /** Last-chance mutation before validation — e.g. stamping a unique id. */
  prepare?: (parsed: unknown) => unknown;
  validate: (raw: unknown) => { ok: boolean; value?: T; issues: GenIssue[] };
  outlineTokens?: number;
  jsonTokens?: number;
  /** Label used in error text ("剧本" / "角色卡" / "群蓝图"). */
  label: string;
}

export interface ChainResult<T> {
  ok: boolean;
  value?: T;
  /** Every attempt's issues, oldest first — shown when all attempts fail. */
  attempts: GenIssue[][];
  error?: string;
}

/**
 * Structured chain input (M-I2, wired in I18).
 *
 * `runChain` only ever took a string, so every caller that had FIELDS rather
 * than a sentence — a persona card, a room's roster — wrote its own hand-rolled
 * serializer (`describePersona` assembled its lines one template literal at a
 * time). Three of those and the prompts drift: one uses `：`, one uses `: `, one
 * forgets the placeholder for an empty field and sends the model a dangling
 * label.
 *
 * Order is the CALLER'S and is never touched: sections serialize in array
 * order, which is why this is an array and not a record — object key order is
 * an implementation detail of how the object happened to be built, and a prompt
 * whose field order depends on that is a prompt that changes when someone
 * reorders an unrelated assignment. Same input, same bytes, every time.
 */
export interface ChainInputSection {
  label: string;
  /** A string renders inline (`label：value`); an array renders as bullets. */
  value?: string | string[];
  /** Printed when the value is empty — a bare label reads as a bug. */
  fallback?: string;
}

export interface ChainInput {
  /** Serialized in this exact order. */
  sections: ChainInputSection[];
  /** Free text appended after the sections (e.g. the brief the user typed). */
  notes?: string;
}

const EMPTY_FALLBACK = '（空）';

/** Deterministic text for a structured input. Pure: no clock, no randomness. */
export function serializeChainInput(input: ChainInput): string {
  const blocks: string[] = [];
  for (const s of input.sections) {
    const fallback = s.fallback ?? EMPTY_FALLBACK;
    if (Array.isArray(s.value)) {
      const items = s.value.map((v) => v.trim()).filter(Boolean);
      blocks.push(
        items.length
          ? [`${s.label}：`, ...items.map((v) => `  - ${v}`)].join('\n')
          : `${s.label}：\n  ${fallback}`,
      );
    } else {
      blocks.push(`${s.label}：${s.value?.trim() || fallback}`);
    }
  }
  if (input.notes?.trim()) blocks.push(input.notes.trim());
  return blocks.join('\n');
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
    // Second chance: the outermost balanced braces or brackets. Models like to
    // add a sentence of introduction no matter how firmly they are told not to.
    const objStart = body.indexOf('{');
    const arrStart = body.indexOf('[');
    const useArray = arrStart >= 0 && (objStart < 0 || arrStart < objStart);
    const start = useArray ? arrStart : objStart;
    const end = useArray ? body.lastIndexOf(']') : body.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(body.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

/** Turn validation issues into a repair instruction the model can act on. */
export function repairPrompt(issues: GenIssue[]): string {
  const lines = issues.slice(0, 8).map((i) => `- ${i.message}`);
  return [
    '上面这份 JSON 没有通过本地校验，问题如下：',
    ...lines,
    '',
    '请只修这些问题，保持其余内容不变，重新输出完整 JSON。不要解释。',
  ].join('\n');
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** One sentence in. */
export async function runChain<T>(
  input: string,
  spec: ChainSpec<T>,
  deps: ChainDeps,
): Promise<ChainResult<T>>;
/** Fields in — serialized here, deterministically, instead of by the caller. */
export async function runChain<T>(
  input: ChainInput,
  spec: ChainSpec<T>,
  deps: ChainDeps,
): Promise<ChainResult<T>>;
export async function runChain<T>(
  input: string | ChainInput,
  spec: ChainSpec<T>,
  deps: ChainDeps,
): Promise<ChainResult<T>> {
  const attempts: GenIssue[][] = [];
  const text = typeof input === 'string' ? input : serializeChainInput(input);
  let planned = text.slice(0, 600);

  if (spec.outlineSystem) {
    deps.onProgress?.(`正在构思${spec.label}`);
    try {
      planned = await deps.complete(
        [
          { role: 'system', content: spec.outlineSystem },
          { role: 'user', content: text.slice(0, 600) },
        ],
        { maxTokens: spec.outlineTokens ?? 900 },
      );
    } catch (e) {
      return { ok: false, attempts, error: `构思${spec.label}失败：${errText(e)}` };
    }
    if (!planned.trim()) return { ok: false, attempts, error: `模型没有返回${spec.label}大纲` };
  }

  const history: Array<{ role: 'system' | 'user'; content: string }> = [
    { role: 'system', content: spec.jsonSystem },
    { role: 'user', content: planned },
  ];

  for (let attempt = 0; attempt <= MAX_REPAIRS; attempt++) {
    deps.onProgress?.(attempt === 0 ? `正在生成${spec.label}` : `正在修正${spec.label}（第 ${attempt} 次）`);
    let raw: string;
    try {
      raw = await deps.complete(history, { json: true, maxTokens: spec.jsonTokens ?? 3000 });
    } catch (e) {
      return { ok: false, attempts, error: `生成${spec.label}失败：${errText(e)}` };
    }

    const parsed = extractJson(raw);
    if (parsed === null) {
      const issue: GenIssue = { code: 'schema', message: '返回的不是合法 JSON' };
      attempts.push([issue]);
      history.push({ role: 'user', content: repairPrompt([issue]) });
      continue;
    }

    const prepared = spec.prepare ? spec.prepare(parsed) : parsed;
    const result = spec.validate(prepared);
    if (result.ok && result.value !== undefined) {
      return { ok: true, value: result.value, attempts };
    }

    attempts.push(result.issues);
    // The model needs to see what it produced to repair it — but bounded, or a
    // long artifact re-enters the context on every round and the last repair
    // costs more than the original generation.
    history.push({ role: 'user', content: raw.slice(0, 6000) });
    history.push({ role: 'user', content: repairPrompt(result.issues) });
  }

  return {
    ok: false,
    attempts,
    error: `模型连续 ${MAX_REPAIRS + 1} 次没能生成可用的${spec.label}。最后一次的问题：${
      attempts
        .at(-1)
        ?.map((i) => i.message)
        .join('；') ?? '未知'
    }`,
  };
}
