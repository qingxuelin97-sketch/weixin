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
// The zod schemas and the types inferred from them live in ./story-schema (M-L1):
// type-only here, so this module — on the story runtime's path, which the chat
// page and the story library sit on — no longer puts zod in the cold-start bundle.
import type { Cast, ChoiceOption, Choice, Directive, Effects, Trigger, StoryNode, Script } from './story-schema';
export type { Cast, ChoiceOption, Choice, Directive, Effects, Trigger, StoryNode, Script };

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
    | 'nsfw_entry'
    | 'choice_conflict';
  message: string;
  nodeId?: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  script?: Script;
}

/* `validateScript` (zod + the graph checks below) lives in ./story-schema (M-L1).
   Callers on the story runtime path load it lazily — see story-gm.ts. */

/**
 * Every outgoing edge of a node: triggers, timeout, and (V4) choice options.
 * The ONE list both graph analyses walk — a new edge kind added here is
 * automatically part of reachability AND escape analysis, and a new edge kind
 * added elsewhere without touching this is the bug the V4 tests provoke.
 */
export function outEdgesOf(n: StoryNode): string[] {
  return [
    ...n.triggers.map((t) => t.to),
    ...(n.timeout ? [n.timeout.to] : []),
    ...(n.choice?.options ?? []).map((o) => o.goto),
  ];
}

/** Node ids reachable from the entry, following triggers, timeouts and choices. */
export function reachableFrom(script: Script): Set<string> {
  const byId = new Map(script.nodes.map((n) => [n.id, n]));
  const seen = new Set<string>();
  const stack = [script.entry];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id) || !byId.has(id)) continue;
    seen.add(id);
    for (const to of outEdgesOf(byId.get(id)!)) stack.push(to);
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
      // Choice edges count (V4): a beat whose only way to an ending runs
      // through the player's decision is escapable — the player IS the trigger.
      if (outEdgesOf(n).some((o) => canFinish.has(o) && byId.has(o))) {
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
 * A trigger condition in words a person can read (M-I7).
 *
 * The 分幕 browser and the graph inspector show a beat's exits; raw
 * `expr:vars.trust >= 2` reads like source code to the person deciding whether
 * to take a branch back. This strips the machinery without changing meaning:
 * `vars.` vanishes, `llm:` becomes "由 GM 判断", an unprefixed condition is
 * named as the authoring error it is (it will never fire — see
 * `evaluateTriggers`).
 */
export function describeWhen(when: string): string {
  const w = parseWhen(when);
  switch (w.kind) {
    case 'expr':
      return w.source
        .replace(/vars\./g, '')
        .replace(/==/g, '=')
        .replace(/\s*&&\s*/g, ' 且 ')
        .replace(/\s*\|\|\s*/g, ' 或 ');
    case 'llm':
      return `由 GM 判断：${w.prompt}`;
    default:
      return `（无效条件，永不触发：${w.source}）`;
  }
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
