/**
 * 拟人化的提示词工艺 (M-I2) — the craft layer.
 *
 * What makes a generated persona read as GENERATED is never one bad sentence;
 * it is the absence of texture: no lived-in details, no flaws, no linguistic
 * fingerprint, and a smooth agreeable surface no real person has. So the
 * rewrite instructions target exactly those four absences, and the negative
 * list bans the failure modes models reach for first (泛泛而谈、列表式美德).
 *
 * Pure string builders — no LLM calls, no storage, deterministic for a given
 * input. `humanize.ts` owns the chain; this file owns the words.
 */
import type { PersonaVM } from '../data/types';

export type HumanizeLevel = 'light' | 'medium' | 'heavy';

/**
 * Deterministic prose snapshot of the rewritable text fields. Serialized by
 * hand (not JSON.stringify) so field order is fixed and the model reads a
 * card, not a data structure.
 */
export function describePersona(p: PersonaVM, name: string): string {
  const lines = [
    `名字：${name}`,
    `核心人设：${p.core || '（空）'}`,
    `说话风格：${p.speechStyle || '（未写）'}`,
    `口头禅：${p.catchphrases.length ? p.catchphrases.join('、') : '（没有）'}`,
    `示例消息：`,
    ...(p.fewShots.length ? p.fewShots.map((s) => `  - ${s}`) : ['  （没有）']),
    `开场白：${p.greeting || '（未写）'}`,
  ];
  return lines.join('\n');
}

/** The texture instructions shared by every level. */
const TEXTURE = `语言肌理（必须落到具体）：
- 口头禅要像真人：来自 TA 的圈子、职业或家乡，不要「哈哈」「好呀」这种人均词。
- 定一个标点/打字习惯：比如从不打句号、爱用省略号、偶尔打错字懒得改、突然发一长串。
- 消息节奏：TA 是一句话拆三条发的人，还是憋半天发一大段的人？示例消息要体现。
- 有 TA 不愿聊的话题，被问到会岔开——写进人设，不要写成「拒绝回答」。`;

const FLAWS = `缺陷与自相矛盾（中/重档必须有）：
- 一个嘴上信奉、行为上明显做不到的价值观（比如天天说要早睡，凌晨两点还在发消息）。
- 工作或生活里的一桩具体怨气，提到相关话题会带出来。
- 一个没完成、也可能永远不会完成的野心，偶尔自嘲。
- 家乡或过去的一件小事，成为 TA 某个习惯的来历。`;

const NEGATIVE = `禁止（写了会被打回）：
- 禁止泛泛而谈：「温柔善良」「幽默风趣」「乐观开朗」这类词一个都不要出现。
- 禁止列表式美德：不要罗列优点，人设要从具体行为里读出来。
- 禁止 AI 腔：不要「作为朋友我会…」「我理解你的感受」这种客服话术。
- 不要改变 TA 是谁：名字、职业、和别人的关系都不许动。`;

/** Which JSON keys each level may output. Mirrors humanize.ts's PATCHABLE. */
export function fieldsFor(level: HumanizeLevel): string[] {
  return level === 'light'
    ? ['speechStyle', 'catchphrases', 'fewShots']
    : ['speechStyle', 'catchphrases', 'fewShots', 'core', 'greeting'];
}

const FIELD_DOC: Record<string, string> = {
  core: '"core": "重写后的核心人设，一段话，具体、有来历、有缺陷"',
  speechStyle: '"speechStyle": "一句话说清 TA 的说话质感（长短、标点、语气）"',
  catchphrases: '"catchphrases": ["2-5 个真口头禅"]',
  fewShots: '"fewShots": ["3-5 条 TA 真的会发出来的消息，体现节奏与习惯"]',
  greeting: '"greeting": "TA 主动打招呼会说的一句话（可省略）"',
};

/**
 * The rewrite system prompt for a level.
 *
 * @param invariants heavy-level hard facts the rewrite must preserve verbatim
 * @param siblings   catchphrases already taken by same-group members — the
 *                   distinctiveness constraint for batch runs
 */
export function humanizeSystem(
  level: HumanizeLevel,
  opts: { invariants?: string; siblings?: string[] } = {},
): string {
  const fields = fieldsFor(level);
  const parts = [
    `你在给一个微信 AI 好友的人设卡做「拟人化」润色。只输出 JSON，不要解释、不要代码块。`,
    `只输出这些字段（可以少写，不许多写）：\n{\n  ${fields
      .map((f) => FIELD_DOC[f])
      .join(',\n  ')}\n}`,
    TEXTURE,
  ];
  if (level !== 'light') parts.push(FLAWS);
  if (level === 'heavy' && opts.invariants) {
    parts.push(
      `硬事实不变量（重写时必须逐条保留，一条都不能丢或改）：\n${opts.invariants}`,
    );
  }
  if (opts.siblings?.length) {
    parts.push(
      `同一个群里其他人的口头禅已经有：${opts.siblings.join('、')}。` +
        `你写的必须和他们明显区分开——重复即打回。`,
    );
  }
  parts.push(NEGATIVE);
  return parts.join('\n\n');
}

/** Heavy level step 1: pull out the facts the rewrite must not lose. */
export const EXTRACT_SYSTEM = `从下面这张人设卡里抽出「硬事实」——名字、职业、年龄线索、
家庭/家乡、明确提到的经历、和别人的具体关系。一行一条，只要事实，不要形容词。
不超过 10 条。只输出这个清单。`;
