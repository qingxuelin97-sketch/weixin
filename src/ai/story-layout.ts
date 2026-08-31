/**
 * Script graph layout (M-I7) — pure geometry for the SVG branch view.
 *
 * Turns a validated script into node positions and edge routes. Kept out of
 * the component because layout is the part with actual invariants worth
 * testing (every node placed exactly once, determinism, cycle tolerance),
 * and none of them need a DOM to verify.
 *
 * The algorithm is deliberately small — layered BFS from the entry:
 *
 *   - column = BFS depth (shortest distance from the entry). Story graphs are
 *     authored 3–12 nodes long; a Sugiyama pass would be more code than the
 *     rest of the feature and the difference is invisible at this size.
 *   - row = arrival order within the column, so siblings stack in the order
 *     the author's triggers introduce them — the top branch of a fork is the
 *     script's FIRST trigger, which usually reads as the "main" path.
 *   - back edges (cycles) and skip edges are routed as curves by the renderer;
 *     the layout only classifies them so the curve can bend the right way.
 *
 * Deterministic by construction: iteration order comes from the script's own
 * node/trigger arrays, no randomness, no clock (constitution rule 4 — the
 * graph a user stares at must not reshuffle between two renders).
 */
import { outEdgesOf, type Script } from './story-script';

/** Abstract layout units. The renderer multiplies into pixels. */
export const NODE_W = 92;
export const NODE_H = 40;
export const GAP_X = 44;
export const GAP_Y = 22;
export const PAD = 16;

export interface LaidNode {
  id: string;
  /** Grid position. */
  col: number;
  row: number;
  /** Top-left corner in layout units (PAD included). */
  x: number;
  y: number;
  goal: string;
  ending: boolean;
  /** 0 none | 1 suggestive | 2 explicit — the renderer badges >0. */
  nsfwLevel: number;
  hasTimeout: boolean;
}

export interface LaidEdge {
  from: string;
  to: string;
  kind: 'trigger' | 'timeout' | 'choice';
  /**
   * forward: to a later column (the normal flow). back: to an earlier-or-same
   * column (a cycle — legal when it has an exit). self: a node looping to
   * itself. The renderer draws back/self edges as arcs so they never lie
   * under the forward ones.
   */
  direction: 'forward' | 'back' | 'self';
}

export interface ScriptLayout {
  nodes: LaidNode[];
  edges: LaidEdge[];
  /** Canvas size in layout units, padding included. */
  width: number;
  height: number;
  /** Column count — the graph's depth, shown as "共 N 层". */
  cols: number;
}

/**
 * Lay out a script's graph.
 *
 * Tolerates anything `validateScript` would reject — the preview renders while
 * the user is still looking at an invalid import, so a dangling edge is
 * dropped and an unreachable node parks in a trailing column rather than
 * crashing the page that would explain the problem.
 */
export function layoutScript(script: Script): ScriptLayout {
  const byId = new Map(script.nodes.map((n) => [n.id, n]));

  // --- BFS layering from the entry -----------------------------------
  const colOf = new Map<string, number>();
  if (byId.has(script.entry)) {
    colOf.set(script.entry, 0);
    const queue = [script.entry];
    while (queue.length) {
      const id = queue.shift()!;
      const node = byId.get(id)!;
      const depth = colOf.get(id)!;
      // The same edge list the validator walks — choice edges (V4) included,
      // or a fork behind a decision would park its branches as "unreachable".
      for (const to of outEdgesOf(node)) {
        if (!byId.has(to) || colOf.has(to)) continue;
        colOf.set(to, depth + 1);
        queue.push(to);
      }
    }
  }

  // Unreachable nodes (invalid drafts only) park one column past the deepest,
  // in authoring order — visible, clearly detached, never overlapping.
  const deepest = Math.max(0, ...colOf.values());
  for (const n of script.nodes) {
    if (!colOf.has(n.id)) colOf.set(n.id, deepest + 1);
  }

  // --- rows: arrival order within each column ------------------------
  const rowsUsed = new Map<number, number>();
  const rowOf = new Map<string, number>();
  for (const n of script.nodes) {
    const col = colOf.get(n.id)!;
    const row = rowsUsed.get(col) ?? 0;
    rowOf.set(n.id, row);
    rowsUsed.set(col, row + 1);
  }

  const nodes: LaidNode[] = script.nodes.map((n) => {
    const col = colOf.get(n.id)!;
    const row = rowOf.get(n.id)!;
    return {
      id: n.id,
      col,
      row,
      x: PAD + col * (NODE_W + GAP_X),
      y: PAD + row * (NODE_H + GAP_Y),
      goal: n.goal,
      ending: n.ending === true,
      nsfwLevel: n.nsfwLevel ?? 0,
      hasTimeout: n.timeout != null,
    };
  });

  // --- edges ----------------------------------------------------------
  const edges: LaidEdge[] = [];
  for (const n of script.nodes) {
    const fromCol = colOf.get(n.id)!;
    const push = (to: string, kind: LaidEdge['kind']) => {
      if (!byId.has(to)) return; // dangling: validator's problem, not ours
      const direction: LaidEdge['direction'] =
        to === n.id ? 'self' : colOf.get(to)! > fromCol ? 'forward' : 'back';
      edges.push({ from: n.id, to, kind, direction });
    };
    for (const t of n.triggers) push(t.to, 'trigger');
    if (n.timeout) push(n.timeout.to, 'timeout');
    for (const o of n.choice?.options ?? []) push(o.goto, 'choice');
  }

  const cols = Math.max(0, ...[...colOf.values()].map((c) => c + 1));
  const maxRows = Math.max(1, ...rowsUsed.values());
  return {
    nodes,
    edges,
    cols,
    width: PAD * 2 + Math.max(0, cols * NODE_W + (cols - 1) * GAP_X),
    height: PAD * 2 + maxRows * NODE_H + (maxRows - 1) * GAP_Y,
  };
}

/**
 * The node ids a run has walked: every snapshot's node plus where it stands
 * now. Feeds the "path taken" highlight — the story you actually played, drawn
 * over the graph of the story you could have.
 */
export function visitedNodeIds(save: {
  nodeId: string;
  history: Array<{ nodeId: string }>;
}): Set<string> {
  const ids = new Set<string>();
  for (const h of save.history) ids.add(h.nodeId);
  ids.add(save.nodeId);
  return ids;
}
