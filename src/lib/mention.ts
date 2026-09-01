/**
 * @ 提及的解析 (M-J7)。
 *
 * 群里的「@小雨」一直只是一串普通文字：导演侧读得懂（`mentionMe` 用它算未读
 * 角标），气泡侧完全不认识——点不动、也不高亮。这里把那串文字切成片段，
 * 让渲染层能把命中的那一段画成可点的。
 *
 * 匹配靠**名单**而不是靠正则猜边界，因为中文没有词边界：`@小雨我们走吧` 里
 * 正则版只能靠「@ 后面到空格为止」断句，于是把整句都吞成人名。拿真名单做
 * **最长优先**匹配才有正确答案——而且顺带保证了「@ 一个不在群里的名字」
 * 老老实实留成普通文字，不会变成一个点了没反应的假链接。
 *
 * 纯函数：不碰存储、不读时钟。
 */

/** 可被 @ 的人。`name` 用的是显示名（备注优先），因为用户 @ 的就是他看到的那个。 */
export interface Mentionable {
  id: string;
  name: string;
}

export type MentionSegment =
  | { kind: 'text'; text: string }
  | { kind: 'mention'; text: string; id: string };

/** 微信的「@所有人」——没有对应联系人，但要高亮。 */
export const MENTION_ALL = '所有人';

/**
 * 把一段文字切成 文本/提及 交替的片段。
 *
 * 保证：拼接所有片段的 `text` 一定等于原文。渲染层因此不可能因为这一层丢字
 * ——「高亮功能把消息吃掉了一半」是这类改造最典型的翻车方式。
 */
export function splitMentions(text: string, people: readonly Mentionable[]): MentionSegment[] {
  if (!text) return [];
  // 最长优先：名单里同时有「小雨」和「小雨儿」时，`@小雨儿` 必须整个命中长的
  // 那个，否则会切出「@小雨」+ 残字「儿」。
  const sorted = [...people].sort((a, b) => b.name.length - a.name.length);
  const out: MentionSegment[] = [];
  let buf = '';
  let i = 0;
  const flush = () => {
    if (buf) out.push({ kind: 'text', text: buf });
    buf = '';
  };
  while (i < text.length) {
    if (text[i] === '@') {
      const rest = text.slice(i + 1);
      const hit = sorted.find((p) => p.name && rest.startsWith(p.name));
      if (hit) {
        flush();
        out.push({ kind: 'mention', text: `@${hit.name}`, id: hit.id });
        i += 1 + hit.name.length;
        continue;
      }
      if (rest.startsWith(MENTION_ALL)) {
        flush();
        // id 为空字符串 = 没有可跳转的人。渲染层据此高亮但不给点击，
        // 而不是编一个假 id 让点击落到一个不存在的资料页。
        out.push({ kind: 'mention', text: `@${MENTION_ALL}`, id: '' });
        i += 1 + MENTION_ALL.length;
        continue;
      }
    }
    buf += text[i];
    i += 1;
  }
  flush();
  return out;
}

/** 这段文字里有没有 @ 到某个人（导演/未读角标用得上，也用于快速跳过渲染分支）。 */
export function hasMention(text: string, people: readonly Mentionable[]): boolean {
  return splitMentions(text, people).some((s) => s.kind === 'mention');
}
