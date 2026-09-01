/**
 * 朋友权限与标签 (M-J7) — 仅聊天 / 不让他看 / 不看他，以及联系人标签。
 *
 * 这两件事在微信里都长在「联系人资料页 → 朋友权限 / 设置标签」，在本仓里它们
 * 也共用一个存储形状：**一整行 KV，值是 contactId → 值 的 map**。理由与
 * `rel_edges` 相同——每人一行意味着「列出所有标签」要读 N 行，而这两份数据
 * 都小到一行装得下。代价是删联系人时不能删整行（那一行里还有活人的数据），
 * 所以两个键都在 `SETTINGS_KEY_CASCADE` 里登记为 `entries: 'id'` 逐条手术。
 *
 * 纯函数：不碰存储、不读时钟、不掷骰子。
 */

/** 一个联系人的朋友圈权限。三个开关都是「限制」，缺省即无限制。 */
export interface FriendPerm {
  /**
   * 仅聊天的朋友。微信里这一个开关顶两个：他看不到我的朋友圈，我也看不到他的。
   * 存成独立字段而不是「把两个都打开」，是因为用户关掉它时要能回到关掉前的状态
   * ——两个细粒度开关是各自独立的意图，不该被一个粗开关吃掉。
   */
  chatOnly?: boolean;
  /** 不让他看我的朋友圈。 */
  hideMine?: boolean;
  /** 不看他的朋友圈。 */
  hideTheirs?: boolean;
}

/** contactId → 权限。缺席 = 完全权限的朋友。 */
export type FriendPermMap = Readonly<Record<string, FriendPerm>>;

/**
 * 「这里没有任何权限限制」。
 *
 * 存在的理由只有两个：单测夹具，以及本仓在该功能之前就写下的调用点。
 * 它**不是**默认值——`canSeeMoment` 的权限参数是必填的，正因为「忘了传」
 * 与「明确表示没有限制」必须长得不一样：前者会静默泄漏，后者是一句声明。
 */
export const NO_FRIEND_PERMS: FriendPermMap = Object.freeze({});

/** 他能看到我（'self'）的朋友圈吗？ */
export function canSeeMyMoments(perms: FriendPermMap, contactId: string): boolean {
  const p = perms[contactId];
  return !p || !(p.chatOnly || p.hideMine);
}

/** 他的朋友圈会出现在我的信息流里吗？ */
export function showsInMyFeed(perms: FriendPermMap, contactId: string): boolean {
  const p = perms[contactId];
  return !p || !(p.chatOnly || p.hideTheirs);
}

/** 这个人身上有没有任何限制（决定资料页那行显示「朋友权限」还是具体摘要）。 */
export function isRestricted(perms: FriendPermMap, contactId: string): boolean {
  return !canSeeMyMoments(perms, contactId) || !showsInMyFeed(perms, contactId);
}

/** 资料页那行右侧的摘要文案。 */
export function permLabel(perms: FriendPermMap, contactId: string): string {
  const p = perms[contactId];
  if (p?.chatOnly) return '仅聊天';
  const bits: string[] = [];
  if (p?.hideMine) bits.push('不让他看');
  if (p?.hideTheirs) bits.push('不看他');
  return bits.length ? bits.join('、') : '朋友圈';
}

/**
 * 写入一个人的权限，并把「全部关掉」折叠成删除该条目。
 *
 * 折叠不是洁癖：`isRestricted` 之外还有 `deleteContactCascade` 的逐条手术与
 * 备份的逐行哈希，留一行 `{}` 会让「这个人有设置过权限」这件事永远为真。
 */
export function setPerm(perms: FriendPermMap, contactId: string, patch: FriendPerm): FriendPermMap {
  const next: Record<string, FriendPerm> = { ...perms };
  const merged: FriendPerm = { ...next[contactId], ...patch };
  const cleaned: FriendPerm = {};
  if (merged.chatOnly) cleaned.chatOnly = true;
  if (merged.hideMine) cleaned.hideMine = true;
  if (merged.hideTheirs) cleaned.hideTheirs = true;
  if (Object.keys(cleaned).length === 0) delete next[contactId];
  else next[contactId] = cleaned;
  return next;
}

/** 仅聊天的朋友名单（通讯录那一页读它）。 */
export function chatOnlyIds(perms: FriendPermMap): string[] {
  return Object.keys(perms)
    .filter((id) => perms[id]?.chatOnly)
    .sort();
}

/* ------------------------------------------------------------------ */
/* 标签                                                                */
/* ------------------------------------------------------------------ */

/** contactId → 标签名数组。 */
export type ContactTagMap = Readonly<Record<string, string[]>>;

export const NO_TAGS: ContactTagMap = Object.freeze({});

/** 标签名上限，与备注名同量级：太长的标签在通讯录分组头上会撑破一行。 */
export const TAG_MAX_LEN = 12;

/**
 * 归一化用户输入的标签串（逗号/顿号/空格分隔皆可）。
 *
 * 去重、去空、截断、保序。保序是有意的：用户第一个想到的标签就是他心里的主标签，
 * 资料页只显示得下前几个。
 */
export function parseTags(input: string): string[] {
  const out: string[] = [];
  for (const raw of input.split(/[,，、\s]+/)) {
    const t = raw.trim().slice(0, TAG_MAX_LEN);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

export function setTags(tags: ContactTagMap, contactId: string, list: string[]): ContactTagMap {
  const next: Record<string, string[]> = { ...tags };
  if (list.length === 0) delete next[contactId];
  else next[contactId] = list;
  return next;
}

/** 一个标签 → 拥有它的联系人 id。用于标签页的分组列表。 */
export interface TagGroup {
  tag: string;
  contactIds: string[];
}

/**
 * 把 contactId→标签 倒排成 标签→contactId。
 *
 * 排序是**按成员数降序、同数按标签名**，而不是按插入顺序：标签页是个索引页，
 * 用得最多的标签排在最前面才是索引该有的样子。名字用 localeCompare('zh')
 * 排，否则中文标签会按码点乱序。
 */
export function groupByTag(tags: ContactTagMap): TagGroup[] {
  const index = new Map<string, string[]>();
  for (const id of Object.keys(tags).sort()) {
    for (const t of tags[id] ?? []) {
      const arr = index.get(t);
      if (arr) arr.push(id);
      else index.set(t, [id]);
    }
  }
  return [...index.entries()]
    .map(([tag, contactIds]) => ({ tag, contactIds }))
    .sort((a, b) => b.contactIds.length - a.contactIds.length || a.tag.localeCompare(b.tag, 'zh'));
}
