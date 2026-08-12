/**
 * "写一个爱吃辣的川妹子，做插画，嘴硬心软" → a complete persona card (M-H2).
 *
 * A `PersonaVM` has two dozen fields and only two of them (name, core) are
 * things a person wants to type. Everything else — active hours, proactivity,
 * typing speed, posting rate, like/comment rates, grab speed, generosity,
 * catchphrases, sample lines — is behaviour, and behaviour is exactly what the
 * user has no way to guess at before meeting the character. Which is why the
 * hand-written flow (`NewContactPage`) sets a name and a core and leaves every
 * other knob at its default, so every hand-made agent behaves identically.
 *
 * This module fills all of them from one sentence, and then CHECKS the result.
 * The checks are the part that matters, because the failure mode is silent:
 *
 *   - a number out of range (proactivity 5) makes the pacing math nonsense;
 *   - `imageTags` the media library has never heard of means she can never
 *     find a photo — which surfaces as "she never sends pictures", not as an
 *     error;
 *   - an activeHours window like [22, 8] never matches an hour, so the agent
 *     is asleep forever and never speaks again;
 *   - a missing field read back as `undefined` is silently interpreted as
 *     "never posts" / "never likes" (the trap in CLAUDE.md §3.5).
 *
 * So nothing here is trusted: every value is validated, clamped, and finally
 * passed through `makePersona()` — the one constructor that guarantees a
 * complete card.
 */
import { z } from 'zod';
import { makePersona, PERSONA_LIMITS } from '../data/persona-defaults';
import type { PersonaVM } from '../data/types';
import { runChain, type ChainDeps, type ChainResult, type GenIssue } from './generate-chain';

export const PERSONA_JSON_SYSTEM = `你在为一个微信聊天 App 生成「AI 好友」的人设卡。
根据用户一句话描述，输出一个完整 JSON。只输出 JSON，不要解释、不要代码块标记。

{
  "name": "中文名字（2-4 字，像真人微信昵称，不要「小助手」这类）",
  "signature": "个性签名，20 字内（可省略）",
  "gender": "male|female|other",
  "core": "人设简介，100-250 字。写清楚：职业/日常、性格、在意什么、有什么小毛病。写成介绍一个人，不要写成标签罗列。",
  "speechStyle": "说话风格，40 字内。例：短句、爱用语气词、偶尔阴阳怪气",
  "fewShots": ["4 到 5 条她平时会发的微信原话，每条 20 字内，口语，不要书面语"],
  "catchphrases": ["2 到 4 个口头禅，每个 6 字内"],
  "greeting": "她主动找你时的第一句话，15 字内",
  "relationUser": "她和用户是什么关系，一句话",
  "activeHours": [[9, 23]],
  "proactivity": 0.4,
  "typingCpm": 300,
  "heartbeatBaseMin": 240,
  "momentsPerDay": 0.3,
  "likeRate": 0.5,
  "commentRate": 0.25,
  "affinityInit": 20,
  "generosity": 0.35,
  "grabSpeed": "fast|mid|slow",
  "temperature": 0.8,
  "imageTags": []
}

数值的含义（按人设选，不要全用默认值——一个高冷的人和一个话痨的人这些数字应该差很多）：
- activeHours：她醒着的时段，[[起,止]]，止可以超过 24 表示跨夜（[14,26] = 14:00-次日 2:00）。起必须小于止。
- proactivity 0..1：主动找人的意愿。heartbeatBaseMin：主动消息的基础间隔分钟（60 很粘人，1440 很高冷）。
- typingCpm：打字速度，150（慢）到 600（快）。
- momentsPerDay：发朋友圈频率（0 = 从不发，0.3 = 每周两三条，1 = 每天）。
- likeRate / commentRate 0..1：给别人朋友圈点赞、评论的倾向。
- affinityInit 0..100：一开始跟用户有多熟。generosity 0..1：多大方（会不会主动发红包）。
- grabSpeed：抢红包的手速。temperature 0.6..1.1：说话的发散程度。
- imageTags：她发照片时从素材库里挑哪些标签（没有合适的就留空数组）。`;

/** The extra identity bits the card needs but `PersonaVM` does not hold. */
export interface GeneratedPersona {
  name: string;
  signature?: string;
  gender: 'male' | 'female' | 'other';
  persona: PersonaVM;
}

const HourPair = z.tuple([z.number(), z.number()]);

const RawSchema = z.object({
  name: z.string().min(1),
  signature: z.string().optional(),
  gender: z.enum(['male', 'female', 'other']).optional(),
  core: z.string().min(10),
  speechStyle: z.string().optional(),
  fewShots: z.array(z.string()).optional(),
  catchphrases: z.array(z.string()).optional(),
  greeting: z.string().optional(),
  relationUser: z.string().optional(),
  activeHours: z.array(HourPair).optional(),
  proactivity: z.number().optional(),
  typingCpm: z.number().optional(),
  heartbeatBaseMin: z.number().optional(),
  momentsPerDay: z.number().optional(),
  likeRate: z.number().optional(),
  commentRate: z.number().optional(),
  affinityInit: z.number().optional(),
  generosity: z.number().optional(),
  grabSpeed: z.enum(['fast', 'mid', 'slow']).optional(),
  temperature: z.number().optional(),
  imageTags: z.array(z.string()).optional(),
});

const clamp = (n: number | undefined, lo: number, hi: number, fallback: number): number => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, lo), hi);
};

/**
 * Keep only windows that can actually match an hour.
 *
 * `isActiveAt` walks forward in hour steps looking for a match; a window that
 * matches nothing means the agent is asleep forever and simply never speaks
 * again. There is no error, no log — she is just gone.
 */
export function sanitizeHours(raw: Array<[number, number]> | undefined): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const pair of raw ?? []) {
    const [a, b] = pair;
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    const start = Math.floor(a);
    const end = Math.floor(b);
    if (start < 0 || start > 23) continue;
    if (end <= start || end > 30) continue; // end may pass 24 to wrap past midnight
    out.push([start, end]);
  }
  return out.length ? out.slice(0, 3) : [[9, 23]];
}

export interface PersonaValidateOptions {
  /** Tags the media library actually has. Empty = the pool has no tags yet. */
  knownTags?: string[];
  /** Existing display names, so a generated card cannot collide with one. */
  takenNames?: string[];
  contactId: string;
}

/**
 * Validate and normalise a generated card.
 *
 * Returns issues in `generate-chain`'s shape so the self-repair loop can quote
 * them back. Only the things the model can actually FIX are issues; everything
 * else (a number slightly out of range, an over-long catchphrase) is clamped
 * silently, because bouncing a whole card over a 0.05 is how a generation
 * burns its three attempts on nothing.
 */
export function validateGeneratedPersona(
  raw: unknown,
  opts: PersonaValidateOptions,
): { ok: boolean; value?: GeneratedPersona; issues: GenIssue[] } {
  const parsed = RawSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.slice(0, 6).map((i) => ({
        code: 'schema',
        message: `字段 ${i.path.join('.') || '(根)'} 有问题：${i.message}`,
      })),
    };
  }
  const p = parsed.data;
  const issues: GenIssue[] = [];

  const name = p.name.trim().slice(0, 12);
  if (!name) issues.push({ code: 'name', message: 'name 不能为空' });
  if (opts.takenNames?.includes(name)) {
    issues.push({ code: 'name_taken', message: `名字「${name}」已经有人用了，换一个` });
  }
  if (p.core.trim().length < 40) {
    // A two-line core produces a character with nothing to be: the prompt's
    // persona layer is most of what makes her someone in particular.
    issues.push({ code: 'core_thin', message: 'core 太短了，至少写 100 字，讲清楚职业、性格、在意的事' });
  }
  const fewShots = (p.fewShots ?? []).map((s) => s.trim()).filter(Boolean);
  if (fewShots.length < 3) {
    issues.push({ code: 'fewshots', message: 'fewShots 至少要 3 条她平时会发的原话' });
  }

  // Tags the library does not have are dropped, not rejected: an unknown tag
  // makes her silently unable to find a photo, but it is not something the
  // model can repair — it cannot see the user's media library.
  const known = new Set(opts.knownTags ?? []);
  const imageTags = (p.imageTags ?? []).filter((t) => known.has(t));

  if (issues.length) return { ok: false, issues };

  const persona = makePersona({
    contactId: opts.contactId,
    core: p.core.trim(),
    speechStyle: p.speechStyle?.trim(),
    fewShots,
    catchphrases: (p.catchphrases ?? []).map((s) => s.trim()).filter(Boolean),
    greeting: p.greeting?.trim() || undefined,
    relations: p.relationUser?.trim() ? { user: p.relationUser.trim().slice(0, 60) } : {},
    activeHours: sanitizeHours(p.activeHours),
    proactivity: clamp(p.proactivity, 0, 1, 0.4),
    typingCpm: Math.round(clamp(p.typingCpm, 80, 900, 300)),
    heartbeatBaseMin: Math.round(clamp(p.heartbeatBaseMin, 30, 4320, 240)),
    momentsPerDay: clamp(p.momentsPerDay, 0, 5, 0.3),
    likeRate: clamp(p.likeRate, 0, 1, 0.5),
    commentRate: clamp(p.commentRate, 0, 1, 0.25),
    affinityInit: Math.round(clamp(p.affinityInit, 0, 100, 20)),
    generosity: clamp(p.generosity, 0, 1, 0.35),
    grabSpeed: p.grabSpeed ?? 'mid',
    temperature: clamp(p.temperature, 0.3, 1.3, 0.8),
    imageTags,
  });

  return {
    ok: true,
    issues: [],
    // `makePersona` is the ONLY constructor: it fills anything the model
    // omitted and clamps the free text to what the prompt layer will use, so a
    // generated card can never be less complete than a hand-written one.
    value: {
      name,
      signature: p.signature?.trim().slice(0, PERSONA_LIMITS.speechStyle) || undefined,
      gender: p.gender ?? 'other',
      persona,
    },
  };
}

/** One sentence in, one complete card out. */
export async function generatePersona(
  brief: string,
  deps: ChainDeps,
  opts: PersonaValidateOptions,
): Promise<ChainResult<GeneratedPersona>> {
  return runChain<GeneratedPersona>(
    brief,
    {
      label: '角色卡',
      // No outline step: a card is small and structured, and a prose plan for
      // it would double the cost to rephrase the same sentence.
      jsonSystem: PERSONA_JSON_SYSTEM,
      jsonTokens: 1600,
      validate: (parsed) => validateGeneratedPersona(parsed, opts),
    },
    deps,
  );
}
