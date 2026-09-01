/**
 * 微信「状态」 (M-J7)。
 *
 * me 页那个「＋ 状态」按钮自 M1 起就在，点了弹 toast「暂未开放」——和 J7a 之前
 * 的麦克风按钮是同一类死入口：界面上有，按下去告诉你没有。
 *
 * 状态与朋友圈的区别是**它会过期**。一条动态永远留在时间线上；一个状态是
 * 「我现在正在干嘛」，24 小时后自己消失。所以过期在**读侧**算（`liveStatus`），
 * 不靠定时任务去清——一个定时清理任务意味着 App 没打开的那 24 小时里状态还
 * 挂着，而且给铁律 5 添一条与 `scheduled_actions` 并行的时间演化路径。
 *
 * 纯函数：不碰存储、不读时钟（时间一律外部注入）。
 */

/** 一条状态。`at` 是设置的时刻，过期与否由读侧按它算。 */
export interface StatusVM {
  /** 目录里的 key，决定颜色与图标。 */
  optionId: string;
  /** 用户自己敲的一句话；空表示只用目录里的标签。 */
  text?: string;
  at: number;
}

export type StatusMap = Readonly<Record<string, StatusVM>>;
export const NO_STATUS: StatusMap = Object.freeze({});

/** 状态的寿命。微信是 24 小时。 */
export const STATUS_TTL_MS = 24 * 60 * 60 * 1000;

/** 自定义那句话的长度上限——状态圈旁边那行放不下更多。 */
export const STATUS_TEXT_MAX = 20;

export interface StatusOption {
  id: string;
  label: string;
  emoji: string;
  /**
   * 状态圈与胶囊的颜色 token 名（不是色值——铁律 1）。
   * 存 token **名**而不是 `var(...)` 整串，是为了让消费方自己决定用在哪个
   * CSS 属性上，也让硬编码颜色检查看得懂这里没有色值。
   */
  tint: string;
}

/**
 * 状态目录，按微信的分组顺序。
 *
 * 这是一份**数据**而不是一堆 if：AI 挑状态时要从同一份表里随机取（种子化），
 * 用户挑状态时要照它画格子，两边共用一份表才不会出现「她发了一个用户选不到的
 * 状态」这种一眼假的东西。
 */
export const STATUS_OPTIONS: readonly StatusOption[] = [
  { id: 'chill', label: '摸鱼', emoji: '🐟', tint: '--color-wxstatus-blue' },
  { id: 'busy', label: '忙', emoji: '💼', tint: '--color-wxstatus-amber' },
  { id: 'sleepy', label: '困', emoji: '😴', tint: '--color-wxstatus-violet' },
  { id: 'happy', label: '开心', emoji: '😄', tint: '--color-wxstatus-amber' },
  { id: 'emo', label: 'emo', emoji: '🌧️', tint: '--color-wxstatus-violet' },
  { id: 'eating', label: '干饭', emoji: '🍜', tint: '--color-wxstatus-amber' },
  { id: 'coffee', label: '喝咖啡', emoji: '☕', tint: '--color-wxstatus-amber' },
  { id: 'gaming', label: '打游戏', emoji: '🎮', tint: '--color-wxstatus-blue' },
  { id: 'music', label: '听歌', emoji: '🎧', tint: '--color-wxstatus-violet' },
  { id: 'movie', label: '看剧', emoji: '🍿', tint: '--color-wxstatus-violet' },
  { id: 'reading', label: '在看书', emoji: '📖', tint: '--color-wxstatus-green' },
  { id: 'sports', label: '运动', emoji: '🏃', tint: '--color-wxstatus-green' },
  { id: 'travel', label: '在路上', emoji: '✈️', tint: '--color-wxstatus-blue' },
  { id: 'study', label: '学习', emoji: '📚', tint: '--color-wxstatus-green' },
  { id: 'sick', label: '不舒服', emoji: '🤒', tint: '--color-wxstatus-violet' },
  { id: 'love', label: '恋爱中', emoji: '💗', tint: '--color-wxstatus-pink' },
];

export function statusOption(id: string): StatusOption | undefined {
  return STATUS_OPTIONS.find((o) => o.id === id);
}

/**
 * 这个人**现在**的状态，过期的一律当没有。
 *
 * 过期在读侧算是这个模块的核心决定：定时清理会让 App 关着的那段时间里状态
 * 还挂着（而它恰恰是最容易过期的那段时间），并且要再开一条时间演化路径。
 * 另外，`optionId` 认不出来的行也当没有——目录改名后残留的旧 id 会渲染成
 * 一个没有图标没有颜色的空圈，那比不显示更难看懂。
 */
export function liveStatus(
  statuses: StatusMap,
  contactId: string,
  now: number,
): (StatusVM & { option: StatusOption }) | undefined {
  const s = statuses[contactId];
  if (!s) return undefined;
  if (now - s.at >= STATUS_TTL_MS) return undefined;
  const option = statusOption(s.optionId);
  return option ? { ...s, option } : undefined;
}

/** 状态圈旁边那行文案：自定义的一句话优先，否则用目录标签。 */
export function statusLabel(s: { text?: string; option: StatusOption }): string {
  return s.text?.trim() || s.option.label;
}

/** 还剩多久过期，用于「x 小时后消失」。已过期返回 0。 */
export function statusRemainMs(s: StatusVM, now: number): number {
  return Math.max(0, s.at + STATUS_TTL_MS - now);
}

/** 写入/清除一条状态。清除 = 删掉条目，理由同 friend-perms 的 setPerm。 */
export function setStatus(
  statuses: StatusMap,
  contactId: string,
  next: StatusVM | null,
): StatusMap {
  const out: Record<string, StatusVM> = { ...statuses };
  if (next) out[contactId] = next;
  else delete out[contactId];
  return out;
}

/**
 * 清掉所有已过期的行。
 *
 * 不是功能，是**卫生**：读侧已经把过期的当没有了，但那些行会一直躺在
 * settings 里，跟着每一次备份走，也让 `deleteContactCascade` 的逐条手术
 * 处理一堆没人看得见的数据。写状态时顺手带一次即可。
 */
export function pruneStatuses(statuses: StatusMap, now: number): StatusMap {
  const out: Record<string, StatusVM> = {};
  for (const [id, s] of Object.entries(statuses)) {
    if (now - s.at < STATUS_TTL_MS) out[id] = s;
  }
  return out;
}

/**
 * 她此刻会挂什么状态 (M-J7)。
 *
 * 纯函数 + 种子化（铁律 4），**零 LLM**：状态是一个 emoji 加一个词，花一次
 * 生成调用去产它是纯粹的浪费，而且回填重放时还得保证同一时刻算出同一个答案。
 *
 * 三个偏置让它不至于像掷骰子：
 *  - 深夜（0-6 点）大概率「困」；
 *  - `proactivity` 高的人更爱挂社交向的状态，低的人偏静态；
 *  - 同一个人同一天不会反复横跳——种子里带的是**天**，不是毫秒。
 */
export function pickStatus(
  opts: { contactId: string; proactivity: number; hour: number; day: number },
  rand: (seed: string) => () => number,
): StatusOption {
  const rng = rand(`status:${opts.contactId}:${opts.day}`);
  if (opts.hour >= 0 && opts.hour < 6 && rng() < 0.7) {
    return statusOption('sleepy') ?? STATUS_OPTIONS[0];
  }
  const social = new Set(['happy', 'eating', 'coffee', 'gaming', 'travel', 'love', 'music']);
  const pool = STATUS_OPTIONS.filter((o) =>
    // A withdrawn persona picking 「恋爱中」 reads as noise; an outgoing one
    // picking 「在看书」 every time reads as a different person than her card.
    opts.proactivity >= 0.5 ? social.has(o.id) || rng() < 0.4 : !social.has(o.id) || rng() < 0.4,
  );
  const list = pool.length ? pool : STATUS_OPTIONS;
  return list[Math.floor(rng() * list.length)];
}

/**
 * 一条到期的朋友圈是否**顺带**换个状态。
 *
 * 挂在 `moment_post` 尾部（与 M-J3 的换头像同一处），所以不新增第 26 个
 * kind：状态是最轻的那种「她有生活」的信号，为它单开一条时间演化路径既违背
 * 铁律 5 的精神，也让离线回填要多认一种事件。比率比换头像高得多——状态本来
 * 就该经常变，而且它零成本。
 */
export const STATUS_POST_RATE = 0.35;
