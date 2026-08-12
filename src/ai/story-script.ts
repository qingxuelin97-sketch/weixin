/**
 * Story scripts: the data, the validator, and the trigger evaluator (M-E5).
 *
 * Structure follows specs/story-gm.md field for field. Everything here is pure —
 * parsing, validation and expression evaluation have no clock, no storage and no
 * LLM, because they are the parts that MUST be right before anything runs. A
 * script arrives from three places (hand-written JSON, an import, or an LLM that
 * was asked for one) and exactly one of those three can be trusted, so the
 * validator is the actual load-bearing piece of this file.
 */
import { z } from 'zod';

/* ==================================================================== */
/* Schema                                                                */
/* ==================================================================== */

export const CastSchema = z.object({
  charId: z.string().min(1),
  /** The role's name inside the story ("侦探", "室友"). */
  role: z.string().min(1),
  /** What this character knows and the others do not. Never shown to the rest. */
  secret: z.string().optional(),
});

export const DirectiveSchema = z.object({
  charId: z.string().min(1),
  /** What this character is doing in this beat. Injected ONLY into their prompt. */
  instruction: z.string().min(1),
  /** What they may reveal here. */
  reveal: z.string().optional(),
  /** What they must not say or do yet. */
  forbid: z.string().optional(),
});

export const EffectsSchema = z.object({
  /** Variable assignments applied when the trigger fires. */
  vars: z.record(z.union([z.number(), z.string(), z.boolean()])).optional(),
  /** Facts written into a character's long-term memory. Undone on rollback. */
  memWrite: z
    .array(z.object({ charId: z.string(), fact: z.string().max(50) }))
    .optional(),
  /** A Moments post the story causes. Also undone on rollback. */
  moment: z.object({ authorId: z.string(), text: z.string().max(200) }).optional(),
});

export const TriggerSchema = z.object({
  /** `expr:<js-lite>` evaluated locally, or `llm:<soft condition>` judged by the GM. */
  when: z.string().min(1),
  /** Destination node id. */
  to: z.string().min(1),
  effects: EffectsSchema.optional(),
});

export const NodeSchema = z.object({
  id: z.string().min(1),
  /** One line for the director: what this beat is FOR. */
  goal: z.string().min(1),
  directives: z.array(DirectiveSchema).default([]),
  triggers: z.array(TriggerSchema).default([]),
  /** Forced exit after N turns, so a stuck beat cannot trap the story. */
  timeout: z.object({ turns: z.number().int().positive(), to: z.string() }).optional(),
  onEnter: z
    .object({
      /** Grey system-message narration shown on arrival. */
      narrate: z.string().max(200).optional(),
      scene: z.string().max(100).optional(),
    })
    .optional(),
  /** 0 none | 1 suggestive | 2 explicit. A node above the run's tier uses sfwAlt. */
  nsfwLevel: z.number().int().min(0).max(2).optional(),
  /** Replacement directive text when the node is above the effective tier. */
  sfwAlt: z.string().optional(),
  /** True for endings: no triggers required, the run finishes here. */
  ending: z.boolean().optional(),
});

export const ScriptSchema = z.object({
  scriptId: z.string().min(1),
  title: z.string().min(1).max(40),
  genre: z.string().max(20).optional(),
  /** Ceiling for the whole script. The RUN's tier is min(global, this). */
  nsfwLevel: z.number().int().min(0).max(2).default(0),
  cast: z.array(CastSchema).min(1),
  vars: z.record(z.union([z.number(), z.string(), z.boolean()])).default({}),
  entry: z.string().min(1),
  nodes: z.array(NodeSchema).min(1),
});

export type Cast = z.infer<typeof CastSchema>;
export type Directive = z.infer<typeof DirectiveSchema>;
export type Effects = z.infer<typeof EffectsSchema>;
export type Trigger = z.infer<typeof TriggerSchema>;
export type StoryNode = z.infer<typeof NodeSchema>;
export type Script = z.infer<typeof ScriptSchema>;

export type VarValue = number | string | boolean;
export type Vars = Record<string, VarValue>;

/* ==================================================================== */
/* Validation                                                            */
/* ==================================================================== */

export interface ValidationIssue {
  /** Machine-readable so the self-repair loop can target a fix. */
  code:
    | 'schema'
    | 'entry_missing'
    | 'duplicate_node'
    | 'dangling_edge'
    | 'unreachable'
    | 'cycle'
    | 'no_ending'
    | 'dead_end'
    | 'unknown_char'
    | 'nsfw_entry';
  message: string;
  nodeId?: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  script?: Script;
}

/**
 * Validate a candidate script.
 *
 * The generated case is why this is strict: an LLM asked for a story graph
 * produces plausible JSON with an entry node that does not exist, edges to
 * invented ids, and beats nothing reaches — none of which is visible until the
 * user is three scenes in and the story silently stops. Every check here
 * corresponds to a way a run can strand.
 */
export function validateScript(raw: unknown): ValidationResult {
  const parsed = ScriptSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.slice(0, 8).map((e) => ({
        code: 'schema' as const,
        message: `${e.path.join('.') || '(root)'}: ${e.message}`,
      })),
    };
  }
  const script = parsed.data;
  const issues: ValidationIssue[] = [];

  const ids = new Set<string>();
  for (const n of script.nodes) {
    if (ids.has(n.id)) {
      issues.push({ code: 'duplicate_node', message: `节点 id 重复：${n.id}`, nodeId: n.id });
    }
    ids.add(n.id);
  }

  if (!ids.has(script.entry)) {
    issues.push({ code: 'entry_missing', message: `entry「${script.entry}」不存在` });
  }

  const castIds = new Set(script.cast.map((c) => c.charId));
  for (const n of script.nodes) {
    for (const d of n.directives) {
      if (!castIds.has(d.charId)) {
        issues.push({
          code: 'unknown_char',
          message: `节点 ${n.id} 的指令指向不在 cast 里的角色：${d.charId}`,
          nodeId: n.id,
        });
      }
    }
    for (const t of n.triggers) {
      if (!ids.has(t.to)) {
        issues.push({
          code: 'dangling_edge',
          message: `节点 ${n.id} 有一条指向不存在节点「${t.to}」的分支`,
          nodeId: n.id,
        });
      }
    }
    if (n.timeout && !ids.has(n.timeout.to)) {
      issues.push({
        code: 'dangling_edge',
        message: `节点 ${n.id} 的超时出口「${n.timeout.to}」不存在`,
        nodeId: n.id,
      });
    }
    // A non-ending node with no way out is where a run dies quietly.
    if (!n.ending && n.triggers.length === 0 && !n.timeout) {
      issues.push({
        code: 'dead_end',
        message: `节点 ${n.id} 既不是结局，也没有任何出口`,
        nodeId: n.id,
      });
    }
  }

  // Reachability from the entry: an unreachable beat is wasted authoring at
  // best, and at worst the ending nobody can get to.
  const reachable = reachableFrom(script);
  for (const n of script.nodes) {
    if (!reachable.has(n.id)) {
      issues.push({ code: 'unreachable', message: `节点 ${n.id} 从 entry 走不到`, nodeId: n.id });
    }
  }

  if (!script.nodes.some((n) => n.ending)) {
    issues.push({ code: 'no_ending', message: '剧本没有任何结局节点' });
  }

  // Escapeless cycles. `strandedNodes` has existed since M-E5 with a `cycle`
  // issue code reserved for it — and was never called from here, so every
  // generated script with a two-node loop passed all eight other checks and
  // shipped a story the player could not get out of.
  for (const id of strandedNodes(script)) {
    issues.push({
      code: 'cycle',
      message: `节点 ${id} 走不到任何结局——它所在的环没有出口`,
      nodeId: id,
    });
  }

  // NSFW: an adult beat must be earned. Reaching it straight from the entry
  // makes the whole gating theatre (specs/nsfw.md) meaningless.
  const entryNode = script.nodes.find((n) => n.id === script.entry);
  if ((entryNode?.nsfwLevel ?? 0) > 0) {
    issues.push({ code: 'nsfw_entry', message: 'entry 节点不允许直接是成人节点' });
  }

  return { ok: issues.length === 0, issues, script };
}

/** Node ids reachable from the entry, following triggers and timeouts. */
export function reachableFrom(script: Script): Set<string> {
  const byId = new Map(script.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const stack = [script.entry];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id) || !byId.has(id)) continue;
    seen.add(id);
    const n = byId.get(id)!;
    for (const t of n.triggers) stack.push(t.to);
    if (n.timeout) stack.push(n.timeout.to);
  }
  return seen;
}

/**
 * Reachable nodes from which NO ending is reachable — i.e. the places a player
 * can walk into and never get out of.
 *
 * Cycles themselves are ALLOWED — "keep talking until the variable moves" is a
 * legitimate beat. What is not allowed is a cycle with no exit, which
 * `dead_end` cannot catch: a two-node loop whose triggers point only at each
 * other has outgoing edges from every node, so every local check passes.
 *
 * Returns the offending ids (sorted, so messages are stable) rather than a
 * boolean, because the generator's self-repair loop has to be told WHICH nodes
 * to give an exit — "there is a cycle somewhere" is not actionable.
 */
export function strandedNodes(script: Script): string[] {
  const byId = new Map(script.nodes.map((n) => [n.id, n]));
  const endings = new Set(script.nodes.filter((n) => n.ending).map((n) => n.id));
  // No ending at all is reported by `no_ending`; every reachable node is
  // stranded by definition, and saying so twice helps nobody.
  if (endings.size === 0) return [];

  // Can each node reach SOME ending? Reverse-reachability from endings.
  const canFinish = new Set(endings);
  let changed = true;
  while (changed) {
    changed = false;
    for (const n of script.nodes) {
      if (canFinish.has(n.id)) continue;
      const outs = [...n.triggers.map((t) => t.to), ...(n.timeout ? [n.timeout.to] : [])];
      if (outs.some((o) => canFinish.has(o) && byId.has(o))) {
        canFinish.add(n.id);
        changed = true;
      }
    }
  }
  return [...reachableFrom(script)].filter((id) => !canFinish.has(id)).sort();
}

/**
 * Does the graph strand the player anywhere? Thin wrapper over
 * `strandedNodes`; kept because "is this script escapable" reads better than a
 * length check at call sites that don't need the ids.
 */
export function hasEscapelessCycle(script: Script): boolean {
  const endings = script.nodes.some((n) => n.ending);
  return !endings || strandedNodes(script).length > 0;
}

/* ==================================================================== */
/* Trigger expressions                                                   */
/* ==================================================================== */

export type When =
  | { kind: 'expr'; source: string }
  | { kind: 'llm'; prompt: string }
  | { kind: 'invalid'; source: string };

export function parseWhen(when: string): When {
  const s = when.trim();
  if (s.startsWith('expr:')) return { kind: 'expr', source: s.slice(5).trim() };
  if (s.startsWith('llm:')) return { kind: 'llm', prompt: s.slice(4).trim() };
  return { kind: 'invalid', source: s };
}

/**
 * Evaluate an `expr:` condition.
 *
 * A DELIBERATELY tiny language — comparisons and boolean combinations over
 * `vars.<name>` and literals — parsed and walked by hand. No `eval`, no `new
 * Function`: scripts arrive by import and by LLM generation, so the expression
 * language is an untrusted-input surface, and the only safe amount of code
 * execution to allow there is none.
 *
 *   vars.trust >= 3
 *   vars.knows_secret == true && vars.turns < 10
 *   vars.mood != "angry" || vars.trust > 5
 */
export function evalExpr(source: string, vars: Vars): boolean {
  try {
    const t = new Tokenizer(source);
    const value = evalOr(t, vars);
    // The whole expression must be consumed. Without this check `vars.x; 任何
    // 东西` parsed as just `vars.x` and fired on it, silently ignoring the rest —
    // the exact shape of "a malformed condition took a branch the author never
    // wrote", and a soft spot in what is an untrusted-input surface.
    if (!t.done()) return false;
    return value;
  } catch {
    // An unparseable condition never fires. Silently taking a branch on a
    // malformed expression would send the story somewhere the author never
    // wrote, which is worse than the beat simply not advancing.
    return false;
  }
}

class Tokenizer {
  private i = 0;
  constructor(private readonly src: string) {}
  peek(): string {
    while (this.i < this.src.length && /\s/.test(this.src[this.i])) this.i++;
    return this.src.slice(this.i);
  }
  eat(token: string): boolean {
    if (this.peek().startsWith(token)) {
      this.i += token.length;
      return true;
    }
    return false;
  }
  /** Read one operand: vars.x, a number, a quoted string, true/false. */
  operand(): VarValue | { ref: string } {
    const rest = this.peek();
    const varsM = /^vars\.([A-Za-z_$][\w$]*)/.exec(rest);
    if (varsM) {
      this.i += varsM[0].length;
      return { ref: varsM[1] };
    }
    const numM = /^-?\d+(\.\d+)?/.exec(rest);
    if (numM) {
      this.i += numM[0].length;
      return Number(numM[0]);
    }
    const strM = /^"([^"]*)"|^'([^']*)'/.exec(rest);
    if (strM) {
      this.i += strM[0].length;
      return strM[1] ?? strM[2] ?? '';
    }
    if (this.eat('true')) return true;
    if (this.eat('false')) return false;
    throw new Error('operand');
  }
  done(): boolean {
    return this.peek().length === 0;
  }
}

function evalOr(t: Tokenizer, vars: Vars): boolean {
  let value = evalAnd(t, vars);
  while (t.eat('||')) {
    const rhs = evalAnd(t, vars);
    value = value || rhs;
  }
  return value;
}

function evalAnd(t: Tokenizer, vars: Vars): boolean {
  let value = evalComparison(t, vars);
  while (t.eat('&&')) {
    const rhs = evalComparison(t, vars);
    value = value && rhs;
  }
  return value;
}

const OPERATORS = ['>=', '<=', '==', '!=', '>', '<'] as const;

function evalComparison(t: Tokenizer, vars: Vars): boolean {
  if (t.eat('(')) {
    const inner = evalOr(t, vars);
    if (!t.eat(')')) throw new Error('unbalanced');
    return inner;
  }
  if (t.eat('!')) return !evalComparison(t, vars);

  const left = resolve(t.operand(), vars);
  for (const op of OPERATORS) {
    if (!t.eat(op)) continue;
    const right = resolve(t.operand(), vars);
    return compare(left, op, right);
  }
  // A bare operand is truthy-tested: `vars.knows_secret`.
  return Boolean(left);
}

function resolve(v: VarValue | { ref: string }, vars: Vars): VarValue {
  if (typeof v === 'object' && v !== null && 'ref' in v) {
    const found = vars[v.ref];
    // An unset variable reads as 0/false rather than throwing: authors add
    // variables as they go, and old saves must keep evaluating.
    return found ?? 0;
  }
  return v;
}

function compare(a: VarValue, op: (typeof OPERATORS)[number], b: VarValue): boolean {
  switch (op) {
    case '==':
      return a === b;
    case '!=':
      return a !== b;
    default: {
      // Ordered comparison only makes sense on numbers; a string comparison
      // here is almost always an authoring mistake, so it is false, not NaN.
      if (typeof a !== 'number' || typeof b !== 'number') return false;
      if (op === '>=') return a >= b;
      if (op === '<=') return a <= b;
      if (op === '>') return a > b;
      return a < b;
    }
  }
}

/* ==================================================================== */
/* Effects                                                               */
/* ==================================================================== */

/** Apply a trigger's variable assignments. Pure — returns a new object. */
export function applyVarEffects(vars: Vars, effects: Effects | undefined): Vars {
  if (!effects?.vars) return vars;
  return { ...vars, ...effects.vars };
}

/**
 * The first trigger whose local condition holds, plus the `llm:` ones that
 * still need judging.
 *
 * Local first, by design (specs/story-gm.md): a deterministic condition must
 * never be second-guessed by a model, and most beats advance on one, so the
 * common path costs no tokens at all.
 */
export function evaluateTriggers(
  node: StoryNode,
  vars: Vars,
): { fired?: Trigger; pending: Trigger[] } {
  const pending: Trigger[] = [];
  for (const t of node.triggers) {
    const when = parseWhen(t.when);
    if (when.kind === 'expr') {
      if (evalExpr(when.source, vars)) return { fired: t, pending: [] };
    } else if (when.kind === 'llm') {
      pending.push(t);
    }
    // 'invalid' is dropped: an unprefixed condition is an authoring error and
    // must not be guessed at in either direction.
  }
  return { pending };
}

/* ==================================================================== */
/* NSFW gating                                                           */
/* ==================================================================== */

/**
 * The directive text for a node under the run's effective tier.
 *
 * A node above the tier does not stop the story — it plays its `sfwAlt`. That
 * is what makes the same script usable at every setting instead of hard-failing
 * halfway through for a user who never opted in.
 */
export function directiveTextFor(node: StoryNode, effectiveLevel: number, d: Directive): string {
  const level = node.nsfwLevel ?? 0;
  if (level <= effectiveLevel) {
    return [d.instruction, d.reveal && `可以透露：${d.reveal}`, d.forbid && `暂时不要：${d.forbid}`]
      .filter(Boolean)
      .join('\n');
  }
  return node.sfwAlt ?? '这一段点到为止，用留白和转场带过，不要写露骨内容。';
}

/** Effective level for a run: min(global tier as 0/1/2, script ceiling). */
export function effectiveStoryLevel(globalTier: 'off' | 'ambiguous' | 'full', script: Script): number {
  const globalLevel = globalTier === 'full' ? 2 : globalTier === 'ambiguous' ? 1 : 0;
  return Math.min(globalLevel, script.nsfwLevel ?? 0);
}
