/**
 * The branch view (M-I7): a script's node graph as inline SVG.
 *
 * Renders `layoutScript`'s geometry — this component owns only pixels and
 * classes. Every stroke and fill goes through a CSS class bound to a token
 * variable (story.css); no color literal survives inside the SVG, because the
 * hardcoded-color gate reads TSX exactly as it reads CSS.
 *
 * Two audiences share the drawing:
 *  - the script DETAIL page shows the whole space of the story (what could
 *    happen), entry highlighted;
 *  - the RUN page overlays what DID happen — visited nodes and walked edges in
 *    brand green, the current beat filled solid — so "where am I, what did I
 *    miss" is answered by looking, not by replaying.
 *
 * Wide graphs scroll horizontally inside their own container (constitution:
 * the page body never scrolls sideways).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Script } from '../../ai/story-script';
import {
  layoutScript,
  NODE_W,
  NODE_H,
  type LaidEdge,
  type LaidNode,
} from '../../ai/story-layout';
import './story.css';

export interface StoryGraphProps {
  script: Script;
  /** The run's current node — filled solid. */
  currentId?: string;
  /** Nodes the run has walked — outlined in brand color. */
  visited?: Set<string>;
  /** Tap-to-inspect: show the node's goal under the graph. */
  inspectable?: boolean;
}

/** Center-right / center-left anchor points for an edge between two nodes. */
function edgePath(edge: LaidEdge, byId: Map<string, LaidNode>): string {
  const a = byId.get(edge.from);
  const b = byId.get(edge.to);
  if (!a || !b) return '';
  if (edge.direction === 'self') {
    // A small loop off the node's right shoulder.
    const x = a.x + NODE_W;
    const y = a.y + NODE_H / 3;
    return `M ${x} ${y} C ${x + 26} ${y - 20}, ${x + 26} ${y + 24}, ${x} ${y + NODE_H / 3}`;
  }
  if (edge.direction === 'back') {
    // Arc underneath the flow so the return edge never lies on a forward one.
    const x1 = a.x + NODE_W / 2;
    const y1 = a.y + NODE_H;
    const x2 = b.x + NODE_W / 2;
    const y2 = b.y + NODE_H;
    const dip = Math.max(y1, y2) + 26;
    return `M ${x1} ${y1} C ${x1} ${dip}, ${x2} ${dip}, ${x2} ${y2}`;
  }
  const x1 = a.x + NODE_W;
  const y1 = a.y + NODE_H / 2;
  const x2 = b.x;
  const y2 = b.y + NODE_H / 2;
  const mid = (x1 + x2) / 2;
  return `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`;
}

/** First few characters of a beat's goal — the label a 92-unit box can carry. */
function nodeLabel(goal: string): string {
  const trimmed = goal.trim();
  return trimmed.length > 6 ? `${trimmed.slice(0, 6)}…` : trimmed;
}

export function StoryGraph({ script, currentId, visited, inspectable = true }: StoryGraphProps) {
  const layout = useMemo(() => layoutScript(script), [script]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const byId = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout]);
  const selected = selectedId ? script.nodes.find((n) => n.id === selectedId) : undefined;
  const scrollRef = useRef<HTMLDivElement>(null);

  // A deep run's current beat sits off-screen to the right; bring it into
  // view once per mount so "where am I" never needs a manual scroll. Direct
  // scrollLeft (no smooth behavior) — this is initial positioning, and the
  // screenshot gate needs a settled first frame.
  useEffect(() => {
    const box = scrollRef.current;
    const node = currentId ? byId.get(currentId) : undefined;
    if (!box || !node) return;
    const target = node.x + NODE_W / 2 - box.clientWidth / 2;
    if (target > 0) box.scrollLeft = Math.min(target, box.scrollWidth);
  }, [currentId, byId]);

  // An edge "was walked" when both of its ends were visited — an approximation
  // (a diamond revisited both corners), but the honest signal (which trigger
  // fired) is not snapshotted, and over-highlighting a closed diamond is a
  // smaller lie than a walked path drawn grey.
  const walked = (e: LaidEdge) =>
    visited != null && visited.has(e.from) && (visited.has(e.to) || e.to === currentId);

  return (
    <div>
      <div ref={scrollRef} className="sgraph" role="img" aria-label={`剧情分支图：${script.title}`}>
        <svg
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
        >
          <defs>
            <marker
              id="sg-arrow"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 8 4 L 0 8 z" className="sgraph__arrow" />
            </marker>
            <marker
              id="sg-arrow-walked"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="7"
              markerHeight="7"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 8 4 L 0 8 z" className="sgraph__arrow sgraph__arrow--walked" />
            </marker>
          </defs>

          {layout.edges.map((e, i) => {
            const isWalked = walked(e);
            const cls = [
              'sgraph__edge',
              e.kind === 'timeout' ? 'sgraph__edge--timeout' : '',
              isWalked ? 'sgraph__edge--walked' : '',
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <path
                key={`${e.from}-${e.to}-${e.kind}-${i}`}
                d={edgePath(e, byId)}
                className={cls}
                markerEnd={isWalked ? 'url(#sg-arrow-walked)' : 'url(#sg-arrow)'}
              />
            );
          })}

          {layout.nodes.map((n) => {
            const cls = [
              'sgraph__node',
              n.ending ? 'sgraph__node--ending' : '',
              visited?.has(n.id) ? 'sgraph__node--visited' : '',
              n.id === currentId ? 'sgraph__node--current' : '',
              n.id === selectedId ? 'sgraph__node--selected' : '',
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <g
                key={n.id}
                className={cls}
                onClick={inspectable ? () => setSelectedId((s) => (s === n.id ? null : n.id)) : undefined}
              >
                <rect x={n.x} y={n.y} width={NODE_W} height={NODE_H} rx={6} />
                <text x={n.x + NODE_W / 2} y={n.y + NODE_H / 2 + 4} textAnchor="middle">
                  {nodeLabel(n.goal)}
                </text>
                {n.ending && (
                  <text className="sgraph__flag" x={n.x + NODE_W - 6} y={n.y + 11} textAnchor="end">
                    终
                  </text>
                )}
                {n.nsfwLevel > 0 && (
                  <text className="sgraph__adult" x={n.x + 6} y={n.y + 11}>
                    18+
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      <div className="sgraph__legend">
        <span>
          <i /> 分支
        </span>
        <span>
          <i className="dash" /> 超时兜底
        </span>
        {visited && (
          <span>
            <i className="walked" /> 已走过
          </span>
        )}
        <span>共 {layout.cols} 层 · {script.nodes.length} 幕</span>
      </div>

      {inspectable && selected && (
        <div className="sgraph-detail">
          <span className="sgraph-detail__tag">
            {selected.ending ? '结局' : '节点'} {selected.id}
          </span>
          {selected.goal}
          {selected.timeout && (
            <div className="sgraph-detail__tag" style={{ marginTop: 4 }}>
              {selected.timeout.turns} 轮没推进就走向「{nodeLabel(
                script.nodes.find((n) => n.id === selected.timeout!.to)?.goal ?? selected.timeout.to,
              )}」
            </div>
          )}
        </div>
      )}
    </div>
  );
}
