/**
 * Story script schema + validator (M-L1, split out of story-script.ts).
 *
 * The zod half of the story layer: the schemas, the types inferred from them,
 * and `validateScript`. It is the load-bearing gate for anything that ENTERS
 * storage (a hand-written import, an LLM-generated graph) — and it is the only
 * part of the story layer that needs zod. story-script.ts (pure helpers, type
 * re-exports) sits on the runtime path the chat page uses; keeping zod over
 * here is what keeps it out of the cold-start bundle. Load it with a dynamic
 * import on that path (story-gm.ts does); static imports are for code that is
 * already lazy (the generator, tests).
 */
import { z } from 'zod';
import {
  reachableFrom,
  strandedNodes,
  type ValidationIssue,
  type ValidationResult,
} from './story-script';

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

/**
 * One option of a choice node (V4). `goto` is a graph edge exactly like a
 * trigger's `to` — reachability and escape analysis walk it — and `setVars`
 * lands before the move, so the destination's `expr:` triggers can read it.
 */
export const ChoiceOptionSchema = z.object({
  /** Button text. Short — it renders as a chip on the chat page. */
  label: z.string().min(1).max(20),
  /** Variable assignments applied when this option is picked. */
  setVars: z.record(z.union([z.number(), z.string(), z.boolean()])).optional(),
  /** Destination node id. Validated to exist. */
  goto: z.string().min(1),
});

/**
 * A player decision point (V4). The GM reaching a node that carries one PAUSES
 * the run — the tick chain stops, the prompt lands as a grey system line, the
 * chat page shows the options — and only the user's tap moves the story again.
 * 1–4 options: one is a legitimate "press on" beat, five don't fit a phone row.
 */
export const ChoiceSchema = z.object({
  /** The question put to the player, shown as grey narration. */
  prompt: z.string().min(1).max(200),
  options: z.array(ChoiceOptionSchema).min(1).max(4),
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
  /**
   * Player decision point (V4). The run pauses here until the user picks; the
   * options are this node's ONLY exits that matter (triggers never evaluate
   * while a choice waits), so a choice node needs neither triggers nor timeout.
   */
  choice: ChoiceSchema.optional(),
  /**
   * Beat cadence hint (V4): 'fast' halves the tick gap, 'slow' doubles it.
   * Purely a fireAt multiplier — there is no second clock (constitution §5).
   */
  pace: z.enum(['fast', 'slow']).optional(),
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
  /**
   * NG+ (V4): which vars a new run may inherit from a FINISHED run of this
   * script. A whitelist by design — carrying everything would let 第 2 周目
   * open with every secret already exposed; the author names what persists
   * ("彼此认识了" yes, "这一轮的信任值" no). Bounded so the row stays small.
   */
  legacy: z.object({ carry: z.array(z.string().min(1)).max(8) }).optional(),
});

export type Cast = z.infer<typeof CastSchema>;
export type ChoiceOption = z.infer<typeof ChoiceOptionSchema>;
export type Choice = z.infer<typeof ChoiceSchema>;
export type Directive = z.infer<typeof DirectiveSchema>;
export type Effects = z.infer<typeof EffectsSchema>;
export type Trigger = z.infer<typeof TriggerSchema>;
export type StoryNode = z.infer<typeof NodeSchema>;
export type Script = z.infer<typeof ScriptSchema>;

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
    // Choice edges are graph edges (V4): a goto to an invented id strands the
    // run at the exact moment the user commits to a decision — worse than any
    // trigger typo, because the pause makes the freeze look intentional.
    for (const opt of n.choice?.options ?? []) {
      if (!ids.has(opt.goto)) {
        issues.push({
          code: 'dangling_edge',
          message: `节点 ${n.id} 的选项「${opt.label}」指向不存在的节点「${opt.goto}」`,
          nodeId: n.id,
        });
      }
    }
    // An ending never plays another beat, so a choice on it can never be shown
    // — its gotos would be authored edges nobody can take.
    if (n.ending && n.choice) {
      issues.push({
        code: 'choice_conflict',
        message: `节点 ${n.id} 既是结局又带选项——结局不再推进，选项永远不会出现`,
        nodeId: n.id,
      });
    }
    // A non-ending node with no way out is where a run dies quietly. A choice
    // IS a way out — the user's tap is the trigger.
    if (!n.ending && n.triggers.length === 0 && !n.timeout && !n.choice) {
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
