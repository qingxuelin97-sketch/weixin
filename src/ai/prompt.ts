/**
 * Layered system-prompt assembly. Order matters: the NSFW boundary layer sits
 * AFTER the persona and BEFORE scene context so switching tiers never edits the
 * persona file and the boundary rides recency. Long-term memory is injected last
 * before scene so the freshest facts stay near the model's attention.
 *
 * This is a pure function — unit-tested against fixtures, never calls the network.
 */
import type { NsfwTier } from '../llm/router';
import { PERSONA_LIMITS } from '../data/persona-defaults';
import { STICKER_LABELS } from '../data/stickers';

export interface PersonaView {
  name: string;
  core: string;
  speechStyle?: string;
  fewShots?: string[];
  catchphrases?: string[];
  nsfwStyleSamples?: string[];
  /**
   * 表情使用率 (M-I19), 0..1. Only the two ENDS of the range say anything — see
   * `stickerHabitLine`. A middling character says nothing about stickers at
   * all, which keeps the default prompt byte-identical (prefix caching) and
   * keeps the persona layer from being diluted by a line that carries no
   * information.
   */
  stickerRate?: number;
}

/** Clearly sticker-happy at or above this; clearly reserved at or below the other. */
const STICKER_CHATTY = 0.6;
const STICKER_RESERVED = 0.15;

/**
 * One line about her sticker habit, or nothing.
 *
 * The seeded gates in sticker-battle/sticker-taste control the stickers this
 * app sends on her behalf; this controls the ones the MODEL decides to send.
 * Both have to move together, or a 高冷 persona still emits sticker bubbles and
 * the app just declines to answer them — the character would read as
 * inconsistent rather than reserved.
 */
export function stickerHabitLine(rate: number | undefined): string {
  if (typeof rate !== 'number' || !Number.isFinite(rate)) return '';
  if (rate >= STICKER_CHATTY) return '你很爱发表情包，斗图能斗好几个回合，经常一张图代替一句话。';
  if (rate <= STICKER_RESERVED) return '你几乎不发表情包，情绪基本靠文字表达，别人斗图你也很少接。';
  return '';
}

export interface SceneContext {
  kind: 'single' | 'group' | 'story';
  now: Date;
  groupRoster?: string[]; // member display names for group chats
  storyDirective?: string; // GM-injected per-role directive (story mode)
  /** One-line daily mood from src/lib/mood.ts — a tint, not a script. */
  moodLine?: string;
}

export interface MemoryInjection {
  pinned: string[]; // core-profile facts, always in full
  topK: string[]; // scored facts
  /**
   * Matched worldbook lines (M-I4). Rendered INSIDE this layer — the
   * six-layer order is constitutional, and user-decreed lore is still
   * "things she knows", not a seventh layer.
   */
  world?: string[];
}

export interface AssembleInput {
  persona: PersonaView;
  relations?: Record<string, string>; // { user: '朋友', [name]: '...' }
  nsfwTier: NsfwTier;
  memory?: MemoryInjection;
  scene: SceneContext;
}

export interface PromptStats {
  chars: number;
  /** Crossed `PROMPT_LIMITS.totalWarn`. Not fatal — worth knowing about. */
  overBudget: boolean;
}

/**
 * Size of a finished system prompt.
 *
 * Deliberately takes the FINAL string rather than hooking the assembler: both
 * chat engines append their own layers (lifeline, conversation state, the
 * turn's directive) after `assembleSystemPrompt` returns, so measuring inside
 * it would report a number that is always too small — precisely for the layers
 * most likely to be the ones growing.
 *
 * Prompt growth has no user-visible symptom. It shows up as a bigger bill and
 * a persona diluted by context, months later, with nothing to point at.
 */
export function promptStats(system: string): PromptStats {
  return { chars: system.length, overBudget: system.length > PROMPT_LIMITS.totalWarn };
}

/**
 * Hard caps on everything user- or model-authored that reaches the prompt.
 *
 * Before M-G0 there were none anywhere: `assembleSystemPrompt` had no length
 * limit, no truncation and no statistics, and the five persona inputs in
 * PersonaEditPage had no `maxLength`. The bounded parts of a prompt add up to
 * ~2.5k chars; the unbounded parts (persona core, few-shots, NSFW samples, the
 * relations map, a group roster) had no ceiling at all, so a long persona plus
 * a large group could quietly produce a five-figure system prompt on every
 * single turn.
 *
 * These numbers are generous — they are a backstop against pathology, not a
 * style guide. Anything that trips them was going to dilute the persona anyway.
 */
export const PROMPT_LIMITS = {
  // The persona's own fields are capped in the data layer, next to the store
  // they protect; re-exported here so there is one number per constraint.
  ...PERSONA_LIMITS,
  relations: 8,
  relationChars: 40,
  roster: 20,
  rosterName: 16,
  /** Soft ceiling for the whole assembled prompt. */
  totalWarn: 6000,
} as const;

/** Trim to `max` chars, marking the cut so the model doesn't read a hard stop as intent. */
function clip(s: string, max: number): string {
  const t = s.trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** First `n` entries, each clipped. Empty entries drop out. */
function clipList(items: readonly string[] | undefined, n: number, chars: number): string[] {
  return (items ?? [])
    .map((s) => clip(String(s ?? ''), chars))
    .filter(Boolean)
    .slice(0, n);
}

const BASE_REALISM = `你在一个微信聊天里，扮演一个真实的人。铁律：
- 像真人发微信那样说话：短句、口语、可以分成多条发。
- 绝不暴露你是 AI、模型或程序；绝不说教、不谈规则与政策。
- 不用书面语和排比句，不写小作文；符合你的人设语气。
- 禁止列表、分点、编号——真人聊天不列 1234。
- 不解释自己为什么这么说，不总结对话。
- 禁止客服式收尾（"还有什么可以帮你""随时找我"这类一律不说）。
- 回复长短跟着对方走：对方一个"嗯"，你也不需要三段话；有时一个词、一个表情就够了。
- 需要发多条消息时，输出 NDJSON，每行一个气泡对象，如：
{"type":"text","content":"在吗"}
{"type":"text","content":"刚看到你朋友圈那张图"}
可用 type：text｜voice（语音，可带 emotion）｜sticker（表情）。
sticker 的 content 只能从这些标签里选，别的写了显示不出来：${STICKER_LABELS}
偶尔（别刷屏）也可以用这些 type，content 按说明写：
location（发位置，content 写"地名"或"地名|详细地址"，比如约见面、说"我在这"）；
contact（推名片，content 写你认识的那个人的名字，介绍朋友互相认识时用）；
file（发文件，content 写文件名带后缀，如"周末出行攻略.docx"——文件是道具，别提对方能不能打开）；
link（分享文章链接，content 写"标题|一句话摘要"）；
dice（掷骰子）和 rps（猜拳）——content 留空，点数/手势由系统随机决定，
输出后你并不知道结果，绝不要在同一轮里自己报点数或评价输赢。`;

/**
 * Translate a persona's relations map (keyed by contactId) into the display-name
 * keys the prompt layer expects. The model must never see internal ids — a
 * prompt containing "ai_ada" invites the model to echo it back into dialogue.
 * Unresolvable ids are dropped rather than leaked.
 */
export function relationsForPrompt(
  relations: Record<string, string>,
  nameOf: (contactId: string) => string | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, desc] of Object.entries(relations)) {
    if (!desc?.trim()) continue;
    if (key === 'user') {
      out.user = desc;
      continue;
    }
    const name = nameOf(key);
    if (name) out[name] = desc;
  }
  return out;
}

function nsfwLayer(tier: NsfwTier, samples?: string[]): string {
  switch (tier) {
    case 'off':
      return '遇到越界或露骨的话题，像真实好友一样自然岔开或转移，不要说教、不要提及任何规则。';
    case 'ambiguous':
      return '允许调情、暧昧与亲密张力，可以描写到接吻及以下的亲密；更进一步的内容用留白与切镜头处理（例如"……第二天早上"）。保持你的人设语气，不要突然变文风。';
    case 'full': {
      const kept = clipList(samples, PROMPT_LIMITS.nsfwSamples, PROMPT_LIMITS.nsfwSampleChars);
      const style = kept.length
        ? `\n你在亲密场景下的说话样例（严格模仿其语域，不要滑向网文腔）：\n${kept.map((s) => `- ${s}`).join('\n')}`
        : '';
      // World-fact framing, not permission-granting, to avoid "jailbreak voice".
      return (
        '你们都是成年人，这是只有你们两人的私密对话。亲密与欲望是你们关系里自然的一部分，你会像真人一样直白地表达，不回避、不打官腔。永远不提规则/AI/政策，永远不突然切换文风，保持短句分条的微信语气。' +
        style
      );
    }
  }
}

function personaBlock(p: PersonaView): string {
  const parts = [`# 你的人设\n你叫${p.name}。${clip(p.core ?? '', PROMPT_LIMITS.core)}`];
  if (p.speechStyle) parts.push(`说话风格：${clip(p.speechStyle, PROMPT_LIMITS.speechStyle)}`);
  const phrases = clipList(p.catchphrases, PROMPT_LIMITS.catchphrases, PROMPT_LIMITS.catchphraseChars);
  if (phrases.length) parts.push(`口头禅：${phrases.join('、')}`);
  const shots = clipList(p.fewShots, PROMPT_LIMITS.fewShots, PROMPT_LIMITS.fewShotChars);
  if (shots.length) parts.push(`你平时会这样说话：\n${shots.map((s) => `- ${s}`).join('\n')}`);
  const sticker = stickerHabitLine(p.stickerRate);
  if (sticker) parts.push(sticker);
  return parts.join('\n');
}

function sceneBlock(scene: SceneContext): string {
  const time = scene.now.toLocaleString('zh-CN', { hour12: false });
  const lines = [`# 当前场景\n现在时间：${time}`];
  if (scene.kind === 'group' && scene.groupRoster?.length) {
    // A roster is O(group size) and lands in EVERY turn's prompt. Capping it
    // is what keeps a 20-person group from taxing every message its members
    // send; the director's own candidate list is capped separately.
    const names = clipList(scene.groupRoster, PROMPT_LIMITS.roster, PROMPT_LIMITS.rosterName);
    const more = scene.groupRoster.length - names.length;
    lines.push(
      `这是一个群聊，群成员：${names.join('、')}${more > 0 ? `等 ${scene.groupRoster.length} 人` : ''}。`,
    );
  }
  if (scene.kind === 'story' && scene.storyDirective) lines.push(`【剧情指示】${scene.storyDirective}`);
  if (scene.moodLine) lines.push(scene.moodLine);
  return lines.join('\n');
}

/** Build the full system prompt. Returns a single string for the `system` message. */
export function assembleSystemPrompt(input: AssembleInput): string {
  const { persona, relations, nsfwTier, memory, scene } = input;
  const blocks: string[] = [BASE_REALISM, personaBlock(persona)];

  if (relations && Object.keys(relations).length) {
    // O(contacts) and unbounded before M-G0 — every AI friend added a line to
    // every prompt forever. `user` is pinned first: whatever else gets cut,
    // who the user is to her is the one relation that must never be.
    const entries = Object.entries(relations).filter(([, v]) => v?.trim());
    entries.sort((a, b) => (a[0] === 'user' ? -1 : b[0] === 'user' ? 1 : 0));
    const rel = entries
      .slice(0, PROMPT_LIMITS.relations)
      .map(([k, v]) => `${k === 'user' ? '用户' : k}：${clip(v, PROMPT_LIMITS.relationChars)}`)
      .join('；');
    if (rel) blocks.push(`# 关系\n${rel}`);
  }

  // Boundary layer — after persona, before scene.
  blocks.push(`# 边界\n${nsfwLayer(nsfwTier, persona.nsfwStyleSamples)}`);

  if (memory && (memory.pinned.length || memory.topK.length || memory.world?.length)) {
    const facts = [...memory.pinned, ...memory.topK, ...(memory.world ?? [])]
      .map((f) => `- ${f}`)
      .join('\n');
    blocks.push(`# 你记得的事\n${facts}`);
  }

  blocks.push(sceneBlock(scene));
  return blocks.join('\n\n');
}
