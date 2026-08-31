/**
 * "帮我建一个 12 人的大学同学群" (M-H2).
 *
 * Two stages, because one call cannot do this well and one call that tries
 * produces twelve variations of the same person:
 *
 *   1. the BLUEPRINT — group name, announcement, the roster with one line
 *      each, and the pairwise relations. This is where a group becomes a
 *      group rather than a list: who is close to whom, who cannot stand whom,
 *      who is the loud one. It is one call, and it is cheap.
 *   2. the CARDS — one full persona per member, generated separately and
 *      resumably. Twelve members is twelve calls, which is the most expensive
 *      single operation in this app, so a failure on member 7 must not throw
 *      away members 1-6.
 *
 * This module owns stage 1 and the validation both stages need. The
 * orchestration (creating contacts, seeding history, resuming) is
 * `group-build.ts`.
 *
 * THE VALIDATION THAT MATTERS is the relation matrix. A model asked for
 * mutual enmity will happily write "阿哲和老王是死对头" on one side and
 * "老王觉得阿哲人挺好" on the other, and that inconsistency does not fail
 * anywhere — it just produces a group where two members are having different
 * conversations about each other forever.
 */
import { z } from 'zod';
import { runChain, type ChainDeps, type ChainResult, type GenIssue } from './generate-chain';

export const MIN_MEMBERS = 4;
export const MAX_MEMBERS = 20;

export type RelTone = 'warm' | 'cool' | 'neutral';

export interface BlueprintMember {
  /** Stable key within the blueprint, used by the relation matrix. */
  key: string;
  name: string;
  /** One line: who they are in this group. Becomes the card's brief. */
  brief: string;
}

export interface BlueprintRelation {
  from: string;
  to: string;
  tone: RelTone;
  /** In their own words, from `from`'s side. */
  text: string;
}

export interface GroupBlueprint {
  title: string;
  announcement?: string;
  /** What this group talks about — seeds the first topic. */
  topics: string[];
  members: BlueprintMember[];
  relations: BlueprintRelation[];
}

const RawSchema = z.object({
  title: z.string().min(1),
  announcement: z.string().optional(),
  topics: z.array(z.string()).optional(),
  members: z.array(
    z.object({
      key: z.string().min(1),
      name: z.string().min(1),
      brief: z.string().min(4),
    }),
  ),
  relations: z
    .array(
      z.object({
        from: z.string(),
        to: z.string(),
        tone: z.enum(['warm', 'cool', 'neutral']).optional(),
        text: z.string().optional(),
      }),
    )
    .optional(),
});

export function blueprintSystem(size: number): string {
  return `你在为一个微信 App 生成一个「群聊蓝图」。群里有 ${size} 个人（不含用户本人）。
只输出 JSON，不要解释、不要代码块标记。

{
  "title": "群名（像真人建的群，别叫「XX交流群」）",
  "announcement": "群公告，一句话（可省略）",
  "topics": ["这个群平时聊什么，3-5 个短语"],
  "members": [
    {"key": "英文小写id", "name": "中文名字（2-3 字，互不相同）", "brief": "一句话说清这个人：职业/性格/在群里是什么角色"}
  ],
  "relations": [
    {"from": "成员key", "to": "另一个成员key", "tone": "warm|cool|neutral", "text": "from 眼里的 to，一句话"}
  ]
}

关于 relations（会被本地校验，写错会被打回）：
- 至少写 ${Math.max(4, size)} 条，覆盖尽量多的人，不要所有人都是 neutral。
- **敌意必须是相互的**：如果 A 对 B 是 cool，那必须也有一条 B 对 A、且 tone 也是 cool。
  真人关系可以不对等（A 拿 B 当好朋友、B 只当普通同事），但「死对头」不可能只有一方知道。
- from / to 必须是上面 members 里出现过的 key，且不能自己指向自己。
- 一个群里最多两三对不对付的人。全员互相看不顺眼的不是群，是修罗场。`;
}

/**
 * Check a blueprint. Issues are things the model can fix; everything else is
 * repaired silently (a self-referencing relation is dropped, not argued about).
 */
export function validateBlueprint(
  raw: unknown,
  size: number,
): { ok: boolean; value?: GroupBlueprint; issues: GenIssue[] } {
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
  const b = parsed.data;
  const issues: GenIssue[] = [];

  const members = b.members.filter((m) => m.key.trim() && m.name.trim());
  if (members.length !== size) {
    issues.push({
      code: 'size',
      message: `members 要正好 ${size} 个，现在是 ${members.length} 个`,
    });
  }
  const keys = new Set(members.map((m) => m.key));
  if (keys.size !== members.length) {
    issues.push({ code: 'dup_key', message: 'members 的 key 有重复' });
  }
  const names = new Set(members.map((m) => m.name.trim()));
  if (names.size !== members.length) {
    // Two people with the same name in one group makes every mention
    // ambiguous — for the director, for the transcript, and for the user.
    issues.push({ code: 'dup_name', message: '群成员的名字有重复，每个人要有自己的名字' });
  }

  const rels = (b.relations ?? []).filter(
    (r) => r.from !== r.to && keys.has(r.from) && keys.has(r.to),
  );
  if (rels.length < Math.max(3, Math.floor(size / 2))) {
    issues.push({
      code: 'rel_thin',
      message: `relations 太少了，至少写 ${Math.max(4, size)} 条，覆盖尽量多的人`,
    });
  }

  // The one that actually matters: mutual enmity has to be mutual.
  const toneOf = new Map<string, RelTone>();
  for (const r of rels) toneOf.set(`${r.from}>${r.to}`, r.tone ?? 'neutral');
  for (const r of rels) {
    if ((r.tone ?? 'neutral') !== 'cool') continue;
    const back = toneOf.get(`${r.to}>${r.from}`);
    if (back !== 'cool') {
      const a = members.find((m) => m.key === r.from)?.name ?? r.from;
      const c = members.find((m) => m.key === r.to)?.name ?? r.to;
      issues.push({
        code: 'rel_asymmetric',
        message: `${a} 对 ${c} 是 cool，但 ${c} 对 ${a} 不是——死对头不可能只有一方知道，补一条反向的 cool`,
      });
    }
  }
  const coolPairs = rels.filter((r) => (r.tone ?? 'neutral') === 'cool').length / 2;
  if (coolPairs > 3) {
    issues.push({ code: 'too_hostile', message: '不对付的人太多了，一个群最多两三对' });
  }

  if (issues.length) return { ok: false, issues: issues.slice(0, 6) };

  return {
    ok: true,
    issues: [],
    value: {
      title: b.title.trim().slice(0, 20),
      announcement: b.announcement?.trim().slice(0, 60) || undefined,
      topics: (b.topics ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 5),
      members: members.map((m) => ({
        key: m.key.trim(),
        name: m.name.trim().slice(0, 10),
        brief: m.brief.trim().slice(0, 80),
      })),
      relations: rels.map((r) => ({
        from: r.from,
        to: r.to,
        tone: r.tone ?? 'neutral',
        text: (r.text ?? '').trim().slice(0, 40),
      })),
    },
  };
}

export async function generateBlueprint(
  brief: string,
  size: number,
  deps: ChainDeps,
): Promise<ChainResult<GroupBlueprint>> {
  const n = Math.min(Math.max(Math.round(size), MIN_MEMBERS), MAX_MEMBERS);
  return runChain<GroupBlueprint>(
    brief,
    {
      label: '群蓝图',
      jsonSystem: blueprintSystem(n),
      jsonTokens: 2600,
      validate: (parsed) => validateBlueprint(parsed, n),
    },
    deps,
  );
}

/**
 * The relations map for ONE member's persona card, in the shape the prompt
 * layer wants (contactId → description).
 *
 * Built from the blueprint's own keys and then remapped to real contact ids by
 * the caller: the blueprint has no idea what ids the app will assign.
 */
export function relationsFor(
  blueprint: GroupBlueprint,
  memberKey: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of blueprint.relations) {
    if (r.from !== memberKey) continue;
    if (r.text) out[r.to] = r.text;
  }
  return out;
}

/**
 * Seed history validation: the fabricated backlog must not predate what is
 * already in the conversation.
 *
 * A row inserted now with a timestamp older than the newest existing message
 * breaks `rowid order == time order`, and the cursor pagination that depends
 * on it starts returning pages out of order (CLAUDE.md §3.5).
 */
export function stampHistory(
  lines: Array<{ speaker: string; text: string }>,
  now: number,
  floorAt: number | undefined,
  gapMs = 90_000,
): Array<{ speaker: string; text: string; at: number }> {
  const span = gapMs * lines.length;
  // Start far enough back that the backlog reads as history, but never before
  // the conversation's own newest message.
  let t = Math.max(now - span, (floorAt ?? 0) + 1_000);
  const out: Array<{ speaker: string; text: string; at: number }> = [];
  for (const l of lines) {
    out.push({ ...l, at: Math.min(t, now - 1_000) });
    t += gapMs;
  }
  return out;
}
