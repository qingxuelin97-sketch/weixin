/**
 * 一键提示词拟人化 (M-I2).
 *
 * Takes an existing persona and asks the model to give it texture — lived-in
 * details, flaws, a linguistic fingerprint — at one of three intensities:
 *
 *   light  只调语言质感（speechStyle/口头禅/示例消息）；core 一个字不动。
 *   medium + 缺陷与习惯，core 与 greeting 可重写。
 *   heavy  两步链：先抽取硬事实不变量，再整体重写并逐条兑现。
 *
 * THE OUTPUT IS A PATCH, NEVER A PERSONA. It flows through
 * `applyPersonaPatch` (src/data/persona-patch.ts), which is what protects the
 * locked fields (relations, nsfwStyleSamples, model/voice/image config) from
 * a model that decides to "improve" them. This module must never import
 * makePersona or validateGeneratedPersona — the first backfills defaults over
 * everything the patch omits, the second rebuilds relations from scratch;
 * both are silent data loss. A source-grep test enforces this.
 */
import type { PersonaVM } from '../data/types';
import { PERSONA_LIMITS } from '../data/persona-defaults';
import {
  runChain,
  serializeChainInput,
  type ChainDeps,
  type ChainResult,
  type GenIssue,
} from './generate-chain';
import {
  personaCardInput,
  humanizeSystem,
  fieldsFor,
  EXTRACT_SYSTEM,
  type HumanizeLevel,
} from './humanize-prompt';

export type { HumanizeLevel } from './humanize-prompt';

export const HUMANIZE_LEVEL_LABELS: Record<HumanizeLevel, string> = {
  light: '轻 · 只调语言质感',
  medium: '中 · 加缺陷与习惯',
  heavy: '重 · 按硬事实整体重写',
};

export interface HumanizeOpts {
  /** Same-group members' catchphrases — the batch distinctiveness constraint. */
  siblingCatchphrases?: string[];
}

const asTrimmed = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;

const asList = (v: unknown, max: number, chars: number): string[] | null => {
  if (!Array.isArray(v)) return null;
  const out = v
    .filter((x): x is string => typeof x === 'string' && Boolean(x.trim()))
    .map((s) => s.trim().slice(0, chars))
    .slice(0, max);
  return out.length ? out : null;
};

/**
 * Validate a humanize patch — ONLY the keys that are present, only the keys
 * the level allows. Anything else (locked fields included) is dropped, not
 * argued about; structural problems become repairable issues.
 */
export function validateHumanizePatch(
  raw: unknown,
  level: HumanizeLevel,
  opts: HumanizeOpts = {},
): { ok: boolean; value?: Partial<PersonaVM>; issues: GenIssue[] } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, issues: [{ code: 'schema', message: '要输出一个 JSON 对象' }] };
  }
  const allowed = new Set(fieldsFor(level));
  const obj = raw as Record<string, unknown>;
  const issues: GenIssue[] = [];
  const patch: Partial<PersonaVM> = {};

  if (allowed.has('core') && 'core' in obj) {
    const core = asTrimmed(obj.core);
    if (core) patch.core = core.slice(0, PERSONA_LIMITS.core);
    else issues.push({ code: 'core', message: 'core 要是一段非空文字' });
  }
  if (allowed.has('speechStyle') && 'speechStyle' in obj) {
    const s = asTrimmed(obj.speechStyle);
    if (s) patch.speechStyle = s.slice(0, PERSONA_LIMITS.speechStyle);
  }
  if (allowed.has('greeting') && 'greeting' in obj) {
    const g = asTrimmed(obj.greeting);
    if (g) patch.greeting = g.slice(0, 60);
  }
  if (allowed.has('catchphrases') && 'catchphrases' in obj) {
    const c = asList(obj.catchphrases, PERSONA_LIMITS.catchphrases, PERSONA_LIMITS.catchphraseChars);
    if (c) patch.catchphrases = c;
    else issues.push({ code: 'catchphrases', message: 'catchphrases 要是非空字符串数组' });
  }
  if (allowed.has('fewShots') && 'fewShots' in obj) {
    const f = asList(obj.fewShots, PERSONA_LIMITS.fewShots, PERSONA_LIMITS.fewShotChars);
    if (f && f.length >= 2) patch.fewShots = f;
    else issues.push({ code: 'fewShots', message: 'fewShots 要有 3-5 条示例消息' });
  }

  if (Object.keys(patch).length === 0 && issues.length === 0) {
    issues.push({ code: 'empty', message: '一个可用字段都没有——至少要改写语言质感的字段' });
  }

  // Distinctiveness gate for batch runs: two members sharing catchphrases is
  // the fastest way to make a whole generated group sound like one person.
  const taken = new Set((opts.siblingCatchphrases ?? []).map((s) => s.trim()));
  if (patch.catchphrases && taken.size) {
    const clash = patch.catchphrases.filter((c) => taken.has(c.trim()));
    if (clash.length >= 1) {
      issues.push({
        code: 'dup_voice',
        message: `口头禅「${clash.join('、')}」已经被群里别人用了，换成 TA 自己的`,
      });
    }
  }

  if (issues.length) return { ok: false, issues };
  return { ok: true, value: patch, issues: [] };
}

/**
 * Run the humanize chain. Returns a PATCH — apply with `applyPersonaPatch`.
 *
 * Routing stays with the caller (constitution rule #6): `deps.complete` is
 * expected to already carry the derived tier.
 */
export async function humanizePersona(
  persona: PersonaVM,
  name: string,
  level: HumanizeLevel,
  deps: ChainDeps,
  opts: HumanizeOpts = {},
): Promise<ChainResult<Partial<PersonaVM>>> {
  // Structured in, serialized once: the rewrite hands the card to runChain as
  // fields (it serializes them itself), and the extract step — a plain
  // completion, not a chain — takes the same bytes.
  const card = personaCardInput(persona, name);

  // Heavy: extract the hard facts FIRST, in prose, then rewrite against them.
  // One extra cheap call buys the only guarantee that matters in a full
  // rewrite — that she is still the same person afterwards.
  let invariants: string | undefined;
  if (level === 'heavy') {
    deps.onProgress?.('正在抽取硬事实');
    try {
      invariants = (
        await deps.complete(
          [
            { role: 'system', content: EXTRACT_SYSTEM },
            { role: 'user', content: serializeChainInput(card) },
          ],
          { maxTokens: 500 },
        )
      ).trim();
    } catch {
      invariants = undefined; // fall back to a normal medium-strength rewrite
    }
  }

  return runChain<Partial<PersonaVM>>(
    card,
    {
      label: '拟人化改写',
      jsonSystem: humanizeSystem(level, {
        invariants,
        siblings: opts.siblingCatchphrases,
      }),
      jsonTokens: 1600,
      validate: (raw) => validateHumanizePatch(raw, level, opts),
    },
    deps,
  );
}
