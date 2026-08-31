import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * 隐藏会话（AI↔AI 私信）读取面台账 (M-J0)。
 *
 * 宪法陷阱原文：「新增用户可见面（如导出预览、通知）时想一下：隐藏会话进去了
 * 吗？泄漏即穿帮且不可逆。」——"想一下"不是机制。这份台账与 SETTINGS_KEY_CASCADE
 * 同构：扫出 src/ 里**每一个**读会话数据的文件（store 全量读 / repo 读 / 按 id
 * 查），每个文件必须在台账里表态它为什么不会把 isHidden 行漏到用户眼前。
 * 新文件读了会话不表态 → 本文件转红，逼出一次显式决定。
 *
 * 三种表态（via）：
 *   - 'filters'  文件自己带 isHidden 检查（机器复核：源码里必须真出现 isHidden）
 *   - 'helper'   委托给带过滤的具名 helper（机器复核：helper 名必须真出现）
 *   - 'not-ui'   压根不是用户可见面（引擎/数据层），或可见但结构上无泄漏
 *                （只渲染聚合数、隐藏行按构造到不了这里）——理由必须讲全，
 *                这一类没有机器复核，合流时人工过一遍 why。
 */

const SRC = join(__dirname, '..', '..', 'src');

/**
 * 会话数据的三类读取口。加第四类读取方式（新的 store 字段名、新的 repo 方法）
 * 时要把模式补进来——模式集本身也有下方的「自检」兜底。
 */
const READ_PATTERNS = [
  /\bs\.conversations\b/,
  /\bstate\.conversations\b/,
  /\bs0\.conversations\b/,
  /\bst\.conversations\b/,
  /\.getConversations\(/,
  /\bconversationById\(/,
];

type Entry = { via: 'filters' | 'helper' | 'not-ui'; helper?: string; why: string };

const HIDDEN_CONV_LEDGER: Record<string, Entry> = {
  'ai/bill-service.ts': {
    via: 'not-ui',
    why:
      'J8 群收款编排，不渲染任何 UI；startAiBill 显式拒绝 isHidden 与非 group 会话' +
      '（隐藏 DM 都是 single 型，双保险），账单卡片只会落进可见群聊。',
  },
  'ai/handlers.ts': {
    via: 'not-ui',
    why:
      '计划动作执行器，不渲染任何 UI；往隐藏会话里写正是 agent_dm 的本职。' +
      '会外溢到可见群的路径（agent_forward / group_event）自带 isHidden 检查。',
  },
  'app/TabScaffold.tsx': {
    via: 'helper',
    helper: 'totalUnread',
    why: '未读徽标走 lib/unread.totalUnread，isHidden 行在 helper 内部被排除（M-I18 收拢的那条不变量）。',
  },
  'app/useSchedulerRuntime.ts': {
    via: 'not-ui',
    why:
      '引擎接线，不渲染。单聊循环以 conv.peerId 为键——隐藏 DM 行没有 peerId，' +
      '天然出局；群规划处显式 filter !isHidden。',
  },
  'db/repo.ts': {
    via: 'not-ui',
    why:
      '数据层按设计返回全量（store 水合需要隐藏行才能驱动 agent_dm 引擎）；' +
      '用户可见的查询口 search() 在层内自滤（宪法陷阱条目的原话：过滤做在 search() 内部，不是 UI 层）。',
  },
  'db/sqlite.ts': {
    via: 'not-ui',
    why: 'repo 的 SQLite 驱动孪生，契约同 db/repo.ts：全量归引擎，search() 层内自滤。',
  },
  'features/call/CallPage.tsx': {
    via: 'not-ui',
    why:
      '可见面，但显示只从 conv.peerId 派生（对端名/头像），隐藏 DM 行没有 peerId，' +
      '渲染不出内容；入口两条（聊天页按钮、来电通知）都在隐藏侧被拦——' +
      'background-notify 对 isHidden 的通知分级是 none。',
  },
  'features/chat-list/ChatListPage.tsx': {
    via: 'filters',
    why: '会话列表，全量读后 filter !isHidden。',
  },
  'features/chat/ChatInfoPage.tsx': {
    via: 'filters',
    why: '按 id 直达面（URL 可伪造），isHidden 行渲染「不存在」兜底。',
  },
  'features/chat/ChatPage.tsx': {
    via: 'filters',
    why: '按 id 直达面（URL 可伪造），isHidden 行渲染兜底；转发选择器另有 !isHidden 过滤。',
  },
  'features/contacts/ContactListPages.tsx': {
    via: 'filters',
    why: '群聊列表 filter type===group && !isHidden。',
  },
  'features/contacts/ContactProfilePage.tsx': {
    via: 'filters',
    why: '找单聊入口时 find 条件带 !isHidden（隐藏 DM 行不能当作「和 TA 的聊天」入口）。',
  },
  'features/contacts/GroupGeneratePage.tsx': {
    via: 'filters',
    why:
      '?rebuild= 是用户可伪造的查询参数；selector 只放行 type===group && !isHidden' +
      '（M-J0 补的——此前伪造 id 能把隐藏会话标题渲染进重配横幅）。',
  },
  'features/me/YearReportPage.tsx': {
    via: 'filters',
    why: '年度报告聚合前 filter !c.isHidden——隐藏会话的活动不进任何统计。',
  },
  'features/money/RedPacketSendPage.tsx': {
    via: 'not-ui',
    why:
      '可见面，但不渲染任何会话派生文本：conv 只用来定 isGroup（表单形态）和' +
      'memberIds（领包人集合）；入口是可见聊天的组合器面板。伪造 URL 只会把钱发进' +
      '看不见的会话，不读出内容。J8 的专属红包领取人选择器只在 type===group 时渲染，' +
      '而隐藏行都是 single 型——成员名到不了屏幕。',
  },
  'features/chat/BillSheet.tsx': {
    via: 'not-ui',
    why:
      'J8 发起群收款面板：conv 只用来定 type===group 与 memberIds（平摊人集合），' +
      '不渲染标题/内容；只能从可见群聊的组合器面板打开，且隐藏行都是 single 型，' +
      '成员名列表在 group 之外根本不渲染（同 RedPacketSendPage 的论证）。',
  },
  'features/money/TransferSendPage.tsx': {
    via: 'not-ui',
    why: '同 RedPacketSendPage：conv 只定表单形态，不渲染标题/内容。',
  },
  'features/search/SearchPage.tsx': {
    via: 'filters',
    why: '正文命中过滤在 search() 内部（数据层）；本页只对「会话内搜索」的 scope 头部再验一次 !isHidden。',
  },
  'features/settings/EnvDiagPage.tsx': {
    via: 'not-ui',
    why:
      '诊断页只渲染聚合计数（「N 个会话」）验证 IndexedDB 可读，无标题/内容/id。' +
      '计数含隐藏行，与聊天列表可见数不一致理论上可观察——保留现状是有意的：' +
      '这是唯一能看出「库里真有多少行」的排障口。',
  },
  'features/settings/NativePage.tsx': {
    via: 'filters',
    why: '挑演示会话（通知/气泡测试的目标）时 find 条件带 !isHidden——测试通知绝不能替隐藏会话发出去。',
  },
  'features/story/CastingSheet.tsx': {
    via: 'filters',
    why:
      '可开演的舞台列表首条即 isHidden 出局（V4 起单聊也可开演，而隐藏 DM 行' +
      '正是 single 型——这条过滤从双保险变成了唯一防线，eligibleStages 单测钉死它）。',
  },
  'features/story/StoryRunPage.tsx': {
    via: 'not-ui',
    why:
      '可见面，但 stage 的 convId 只能来自存档，而存档只能由 CastingSheet 开演创建' +
      '——那里对 group 和（V4 起的）single 舞台一律先过滤 isHidden，构造上到不了这里。',
  },
  'native/background-notify.ts': {
    via: 'filters',
    why: '通知分级的第一条就是 isHidden → none（隐藏会话永不通知），后续路径再验一次。',
  },
  'native/reply-drain.ts': {
    via: 'not-ui',
    why:
      '后台把通知回复排回正常发送路径，不渲染；隐藏会话从不产生通知' +
      '（background-notify 分级 none），也就不会有回复可排。',
  },
  'native/widget-sync.ts': {
    via: 'filters',
    why: '桌面小组件摘要在本文件的 buildWidgetSummary 里 filter !isHidden（外加免打扰）。',
  },
  'store/appStore.ts': {
    via: 'not-ui',
    why:
      '状态层按设计持有全量（引擎要驱动隐藏会话）；它自己那条通知入队路径检查' +
      '!conv.isHidden，删联系人级联对隐藏 DM 行做逐条手术而不是整行删。',
  },
};

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(ts|tsx)$/.test(name)) yield p;
  }
}

function readers(): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of walk(SRC)) {
    const src = readFileSync(p, 'utf8');
    if (READ_PATTERNS.some((re) => re.test(src))) out.set(relative(SRC, p), src);
  }
  return out;
}

describe('隐藏会话读取面台账（新面不表态即转红）', () => {
  const found = readers();

  it('扫描器还活着（防模式集改坏后 vacuous 全绿）', () => {
    // 定义 conversationById 的 store 与读它的 ChatPage 永远在集合里。
    expect(found.has('store/appStore.ts')).toBe(true);
    expect(found.has('features/chat/ChatPage.tsx')).toBe(true);
    expect(found.size).toBeGreaterThan(15);
  });

  it('每个读会话的文件都在台账上表了态', () => {
    const missing = [...found.keys()].filter((f) => !(f in HIDDEN_CONV_LEDGER));
    expect(
      missing,
      '新增了读会话数据的面却没在 HIDDEN_CONV_LEDGER 表态——先回答「隐藏会话进去了吗」',
    ).toEqual([]);
  });

  it('台账没有幽灵行（不再读会话的文件要摘掉）', () => {
    const stale = Object.keys(HIDDEN_CONV_LEDGER).filter((f) => !found.has(f));
    expect(stale).toEqual([]);
  });

  it("表态 'filters' 的文件源码里必须真有 isHidden 检查", () => {
    for (const [f, e] of Object.entries(HIDDEN_CONV_LEDGER)) {
      if (e.via !== 'filters') continue;
      expect(found.get(f), `${f} 声称自带过滤，但源码里已无 isHidden`).toMatch(/isHidden/);
    }
  });

  it("表态 'helper' 的文件必须真调用了声明的 helper", () => {
    for (const [f, e] of Object.entries(HIDDEN_CONV_LEDGER)) {
      if (e.via !== 'helper') continue;
      expect(e.helper, `${f} 声明 via helper 却没写 helper 名`).toBeTruthy();
      expect(found.get(f), `${f} 声称委托 ${e.helper}，但源码里没调它`).toContain(e.helper!);
    }
  });

  it("每条 'not-ui' 都写了像样的理由（合流时人工复核这一类）", () => {
    for (const [f, e] of Object.entries(HIDDEN_CONV_LEDGER)) {
      if (e.via !== 'not-ui') continue;
      expect(e.why.length, `${f} 的 not-ui 理由太薄`).toBeGreaterThan(20);
    }
  });
});
