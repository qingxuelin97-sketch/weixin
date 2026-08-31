/**
 * 提示词工作台的纯解析层 (M-I11).
 *
 * The workbench shows what was ACTUALLY sent, not a re-simulation: the engines
 * append a dozen conditional layers (lifeline, goals, conv-state, threads,
 * occasions, style notes…) after `assembleSystemPrompt` returns, and any
 * second implementation of that stack would drift within a milestone. So the
 * source of truth is the llm-recorder's captured request, and this module only
 * PARSES — it never assembles.
 *
 * Parsing leans on a structural invariant both engines already keep for
 * prefix-cache reasons: every layer is one `\n\n`-separated block, and the
 * constitutional six start with a `# ` heading. That makes "split on blank
 * line, title from the first line" faithful rather than heuristic.
 */
import type { LlmExchange } from '../lib/llm-recorder';

export interface PromptSection {
  /** Human label: the `# ` heading, the 【…】 tag, or a clipped first line. */
  title: string;
  text: string;
  chars: number;
}

/** The assembler's first block has no heading; name it what it is. */
const BASE_TITLE = '基底规则';

export function splitPromptSections(system: string): PromptSection[] {
  const blocks = system.split('\n\n').filter((b) => b.trim().length > 0);
  return blocks.map((block, i) => {
    const firstLine = block.split('\n', 1)[0].trim();
    let title: string;
    if (firstLine.startsWith('# ')) {
      title = firstLine.slice(2).trim();
    } else if (firstLine.startsWith('【')) {
      const close = firstLine.indexOf('】');
      title = close > 0 ? firstLine.slice(1, close) : firstLine.slice(0, 12);
    } else if (i === 0) {
      title = BASE_TITLE;
    } else {
      title = firstLine.length > 14 ? `${firstLine.slice(0, 14)}…` : firstLine;
    }
    return { title, text: block, chars: block.length };
  });
}

/** The system message of a recorded exchange, or undefined when absent. */
export function systemOf(entry: LlmExchange): string | undefined {
  return entry.request.find((m) => m.role === 'system')?.content;
}

/** Non-system turns — the conversation window the model saw. */
export function turnsOf(entry: LlmExchange): Array<{ role: string; content: string }> {
  return entry.request.filter((m) => m.role !== 'system');
}
