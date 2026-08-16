/**
 * 中文名 → A-Z 首字母（M-I18）。
 *
 * 通讯录右侧的 A-Z 索引栏自 M-I6 起是真的能用的（触摸滑动定位、分段锚点），
 * 但**数据侧一直是空的**：App 内三条创建联系人的路径（手动新建、AI 代写人设、
 * 群蓝图建人）全都写死 `pinyinInitial: '#'`，真字母只存在于 4 个种子联系人身上。
 * 于是用满一周之后，索引栏上只剩「↑ ☆ # 」加种子的那几个字母——一个看起来能用、
 * 实际永远把新人丢进 # 的装饰。
 *
 * 这里不引入拼音库（几百 KB 的字典进不了启动包预算，而这个 App 的联系人量是
 * 几十个人的量级）：用 **GB2312 收字区间**近似。GB2312 把常用汉字按拼音顺序
 * 排列，所以「某个字落在哪两个边界之间」就能定出首字母，对常用字准确率足够高。
 * 生僻字、多音字姓氏（如「解」「查」）会有偏差——那正是 `pinyinInitial` 可以被
 * 用户在资料页手改的原因，自动值只是省掉大多数情况下的手工。
 */

/**
 * 每个字母区间的**起始**汉字（按 GB2312 拼音序）。
 * 相邻两个边界之间的字归前一个字母；'I'/'U'/'V' 无对应汉字，故不在表内。
 */
const BOUNDARIES: Array<[letter: string, start: string]> = [
  ['A', '阿'],
  ['B', '芭'],
  ['C', '擦'],
  ['D', '搭'],
  ['E', '蛾'],
  ['F', '发'],
  ['G', '噶'],
  ['H', '哈'],
  ['J', '击'],
  ['K', '喀'],
  ['L', '垃'],
  ['M', '妈'],
  ['N', '拿'],
  ['O', '哦'],
  ['P', '啪'],
  ['Q', '期'],
  ['R', '然'],
  ['S', '撒'],
  ['T', '塌'],
  ['W', '挖'],
  ['X', '昔'],
  ['Y', '压'],
  ['Z', '匝'],
];

/** 索引栏里"其它"那一档。数字、符号、emoji、生僻字都落这里。 */
export const OTHER_INITIAL = '#';

/**
 * 取显示名的首字母，用于 A-Z 索引分组。
 *
 * - ASCII 字母 → 大写它本身（英文名、拼音昵称）
 * - 汉字 → GB2312 区间近似
 * - 其它（数字/符号/emoji/空名）→ `#`
 */
export function pinyinInitialOf(name: string): string {
  const ch = name.trim().charAt(0);
  if (!ch) return OTHER_INITIAL;

  if (/[a-zA-Z]/.test(ch)) return ch.toUpperCase();
  // 非汉字（数字、标点、emoji、日文假名…）一律归 #。
  if (!/[一-龥]/.test(ch)) return OTHER_INITIAL;

  // localeCompare 用中文排序规则做区间判定——它在现代引擎里就是按拼音排的，
  // 比手写码点区间更准，也不需要把整张码表搬进来。
  let found = OTHER_INITIAL;
  for (const [letter, start] of BOUNDARIES) {
    if (start.localeCompare(ch, 'zh-CN') <= 0) found = letter;
    else break;
  }
  return found;
}
