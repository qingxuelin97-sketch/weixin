/**
 * The thing you see while pulling (M-I8).
 *
 * WeChat's indicator is deliberately tiny: a thin ring that fills as you pull
 * and spins while it works. No text, no logo, no bounce — it lives ABOVE the
 * list's top edge and is only visible because the list has been dragged away
 * from it, which is why it needs no dismissal of its own.
 *
 * Hand-drawn SVG, zero PNG (repo rule). The arc is one `stroke-dasharray`
 * expression driven by `progress`, so the ring fills exactly in step with the
 * finger rather than on a threshold.
 */
import { PULL_THRESHOLD, type PullPhase } from './usePullRefresh';
import './pull-refresh.css';

interface Props {
  phase: PullPhase;
  /** 0..1 toward the commit point. */
  progress: number;
}

/** Ring geometry. r is chosen so the whole glyph fits the 20px box with stroke. */
const R = 8;
const CIRC = 2 * Math.PI * R;

export function PullRefresh({ phase, progress }: Props) {
  // Idle costs nothing to render but also shows nothing: the indicator sits in
  // the strip above the list, which is off-screen until the list is dragged.
  const spinning = phase === 'refreshing';
  return (
    <div
      className={`pull-refresh${spinning ? ' pull-refresh--busy' : ''}`}
      style={{ height: PULL_THRESHOLD }}
      aria-hidden={phase === 'idle' || undefined}
    >
      <svg
        className={`pull-refresh__ring${spinning ? ' pull-refresh__ring--spin' : ''}`}
        width="20"
        height="20"
        viewBox="0 0 20 20"
        role="img"
        aria-label={spinning ? '正在刷新' : '下拉刷新'}
      >
        {/* Track: always there, so the ring reads as filling rather than growing. */}
        <circle cx="10" cy="10" r={R} fill="none" stroke="currentColor" strokeWidth="1.6" opacity="0.18" />
        <circle
          cx="10"
          cy="10"
          r={R}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          // While spinning the arc is a fixed quarter that the CSS rotation
          // carries around; while pulling it is the progress itself.
          strokeDasharray={spinning ? `${CIRC * 0.25} ${CIRC}` : `${CIRC * clamp01(progress)} ${CIRC}`}
          transform="rotate(-90 10 10)"
        />
      </svg>
    </div>
  );
}

function clamp01(n: number): number {
  return n < 0 ? 0 : n > 1 ? 1 : n;
}
