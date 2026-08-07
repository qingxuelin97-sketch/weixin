/**
 * Layered system-prompt assembly. Order matters: the NSFW boundary layer sits
 * AFTER the persona and BEFORE scene context so switching tiers never edits the
 * persona file and the boundary rides recency. Long-term memory is injected last
 * before scene so the freshest facts stay near the model's attention.
 *
 * This is a pure function — unit-tested against fixtures, never calls the network.
 */
import type { NsfwTier } from '../llm/router';

export interface PersonaView {
  name: string;
  core: string;
  speechStyle?: string;
  fewShots?: string[];
  catchphrases?: string[];
  nsfwStyleSamples?: string[];
}

export interface SceneContext {
  kind: 'single' | 'group' | 'story';
  now: Date;
  groupRoster?: string[]; // member display names for group chats
  storyDirective?: string; // GM-injected per-role directive (story mode)
}

export interface MemoryInjection {
  pinned: string[]; // core-profile facts, always in full
  topK: string[]; // scored facts
}

export interface AssembleInput {
  persona: PersonaView;
  relations?: Record<string, string>; // { user: '朋友', [name]: '...' }
  nsfwTier: NsfwTier;
  memory?: MemoryInjection;
  scene: SceneContext;
}

const BASE_REALISM = `你在一个微信聊天里，扮演一个真实的人。铁律：
- 像真人发微信那样说话：短句、口语、可以分成多条发。
- 绝不暴露你是 AI、模型或程序；绝不说教、不谈规则与政策。
- 不用书面语和排比句，不写小作文；符合你的人设语气。
- 需要发多条消息时，输出 NDJSON，每行一个气泡对象，如：
{"type":"text","content":"在吗"}
{"type":"text","content":"刚看到你朋友圈那张图"}
可用 type：text｜voice（语音，可带 emotion）｜sticker（表情，content 为语义标签）。`;

function nsfwLayer(tier: NsfwTier, samples?: string[]): string {
  switch (tier) {
    case 'off':
      return '遇到越界或露骨的话题，像真实好友一样自然岔开或转移，不要说教、不要提及任何规则。';
    case 'ambiguous':
      return '允许调情、暧昧与亲密张力，可以描写到接吻及以下的亲密；更进一步的内容用留白与切镜头处理（例如"……第二天早上"）。保持你的人设语气，不要突然变文风。';
    case 'full': {
      const style = samples?.length
        ? `\n你在亲密场景下的说话样例（严格模仿其语域，不要滑向网文腔）：\n${samples.map((s) => `- ${s}`).join('\n')}`
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
  const parts = [`# 你的人设\n你叫${p.name}。${p.core}`];
  if (p.speechStyle) parts.push(`说话风格：${p.speechStyle}`);
  if (p.catchphrases?.length) parts.push(`口头禅：${p.catchphrases.join('、')}`);
  if (p.fewShots?.length)
    parts.push(`你平时会这样说话：\n${p.fewShots.map((s) => `- ${s}`).join('\n')}`);
  return parts.join('\n');
}

function sceneBlock(scene: SceneContext): string {
  const time = scene.now.toLocaleString('zh-CN', { hour12: false });
  const lines = [`# 当前场景\n现在时间：${time}`];
  if (scene.kind === 'group' && scene.groupRoster?.length)
    lines.push(`这是一个群聊，群成员：${scene.groupRoster.join('、')}。`);
  if (scene.kind === 'story' && scene.storyDirective) lines.push(`【剧情指示】${scene.storyDirective}`);
  return lines.join('\n');
}

/** Build the full system prompt. Returns a single string for the `system` message. */
export function assembleSystemPrompt(input: AssembleInput): string {
  const { persona, relations, nsfwTier, memory, scene } = input;
  const blocks: string[] = [BASE_REALISM, personaBlock(persona)];

  if (relations && Object.keys(relations).length) {
    const rel = Object.entries(relations)
      .map(([k, v]) => `${k === 'user' ? '用户' : k}：${v}`)
      .join('；');
    blocks.push(`# 关系\n${rel}`);
  }

  // Boundary layer — after persona, before scene.
  blocks.push(`# 边界\n${nsfwLayer(nsfwTier, persona.nsfwStyleSamples)}`);

  if (memory && (memory.pinned.length || memory.topK.length)) {
    const facts = [...memory.pinned, ...memory.topK].map((f) => `- ${f}`).join('\n');
    blocks.push(`# 你记得的事\n${facts}`);
  }

  blocks.push(sceneBlock(scene));
  return blocks.join('\n\n');
}
