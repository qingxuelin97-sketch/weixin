/**
 * 「对方正在输入」的抖动节奏（M-I16 在线感）。
 *
 * 真人打字不是一根匀速进度条：敲一阵、停下想想、又敲。原来的指示器在整个
 * 生成期间常亮，一眼就是机器。这里产出一段 seeded 的「输入中/停顿」节拍序列，
 * UI 层循环播放——纯函数 + seededRng（铁律 4：无 Math.random/Date.now），
 * 同一种子永远同一节奏，截图与回放确定。
 */
import { seededRng } from './money';

export interface TypingBeat {
  /** true = 显示「正在输入…」；false = 短暂停顿（指示器隐去）。 */
  on: boolean;
  /** 该状态持续的毫秒数。 */
  ms: number;
}

/** 输入段 1.2–3.5s，停顿段 0.5–1.6s——按住手机打字的真实呼吸感。 */
const ON_MIN = 1200;
const ON_SPAN = 2300;
const OFF_MIN = 500;
const OFF_SPAN = 1100;

/**
 * 生成一段节拍序列（UI 循环使用）。恒以「输入中」开头——指示器亮起的第一眼
 * 必须是正在输入，抖动只发生在其后。
 */
export function typingRhythm(seed: string, pairs = 6): TypingBeat[] {
  const rng = seededRng(`typing:${seed}`);
  const out: TypingBeat[] = [];
  for (let i = 0; i < pairs; i++) {
    out.push({ on: true, ms: Math.round(ON_MIN + rng() * ON_SPAN) });
    out.push({ on: false, ms: Math.round(OFF_MIN + rng() * OFF_SPAN) });
  }
  return out;
}
