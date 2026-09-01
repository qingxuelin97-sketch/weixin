/**
 * 微信「状态」 (M-J7).
 *
 * 这个功能的**定义**就是「它会过期」。所以这份文件里分量最重的不是「能不能存
 * 下来」，而是过期规则：24 小时是边界还是端点、App 关着的那段时间算不算数、
 * 目录改名后残留的旧行会不会渲染成一个没有图标的空圈。
 *
 * 过期做在读侧（`liveStatus`）而不是定时清理，理由写在 src/lib/status.ts：
 * 定时清理在 App 没打开时不跑，而那正是状态最容易过期的那段时间；而且它会给
 * 铁律 5 添一条与 scheduled_actions 并行的时间演化路径。
 */
import { describe, it, expect } from 'vitest';
import {
  NO_STATUS,
  STATUS_OPTIONS,
  STATUS_POST_RATE,
  STATUS_TTL_MS,
  liveStatus,
  pickStatus,
  pruneStatuses,
  setStatus,
  statusLabel,
  statusOption,
  statusRemainMs,
  type StatusMap,
} from '../../src/lib/status';
import { seededRng } from '../../src/lib/money';

const T0 = 1_754_600_000_000;
const HOUR = 3_600_000;

describe('状态的过期', () => {
  const map: StatusMap = { ai_a: { optionId: 'coffee', at: T0 } };

  it('刚设的看得到', () => {
    expect(liveStatus(map, 'ai_a', T0 + HOUR)?.option.id).toBe('coffee');
  });

  it('满 24 小时那一刻就没了（边界是闭的，不是开的）', () => {
    expect(liveStatus(map, 'ai_a', T0 + STATUS_TTL_MS - 1)).toBeDefined();
    expect(liveStatus(map, 'ai_a', T0 + STATUS_TTL_MS)).toBeUndefined();
  });

  /**
   * 这条是「读侧过期」这个决定本身的测试：中间这 30 小时里 App 一次都没打开，
   * 没有任何定时任务跑过，状态照样必须是过期的。改成定时清理就会在这里红。
   */
  it('App 关着的那段时间照样在流逝', () => {
    expect(liveStatus(map, 'ai_a', T0 + 30 * HOUR)).toBeUndefined();
  });

  it('目录里没有的 optionId 当作没有状态（改名后的残留行不画空圈）', () => {
    const stale: StatusMap = { ai_a: { optionId: 'no_such_option', at: T0 } };
    expect(liveStatus(stale, 'ai_a', T0 + HOUR)).toBeUndefined();
  });

  it('没设过的人就是没有', () => {
    expect(liveStatus(map, 'ai_b', T0)).toBeUndefined();
    expect(liveStatus(NO_STATUS, 'ai_a', T0)).toBeUndefined();
  });

  it('剩余时间用于「x 小时后结束」，过期后是 0 而不是负数', () => {
    expect(statusRemainMs({ optionId: 'coffee', at: T0 }, T0 + HOUR)).toBe(STATUS_TTL_MS - HOUR);
    expect(statusRemainMs({ optionId: 'coffee', at: T0 }, T0 + 40 * HOUR)).toBe(0);
  });
});

describe('状态的写入', () => {
  it('清除 = 删掉条目', () => {
    let m = setStatus(NO_STATUS, 'ai_a', { optionId: 'busy', at: T0 });
    expect(m.ai_a).toBeDefined();
    m = setStatus(m, 'ai_a', null);
    expect('ai_a' in m).toBe(false);
  });

  /**
   * pruneStatuses 不是功能是卫生：读侧已经把过期的当没有了，但那些行会跟着
   * 每一次备份走，也让 deleteContactCascade 的逐条手术处理一堆看不见的数据。
   */
  it('prune 扫掉过期行，留下活的', () => {
    const m: StatusMap = {
      old: { optionId: 'busy', at: T0 - 30 * HOUR },
      fresh: { optionId: 'coffee', at: T0 - HOUR },
    };
    expect(Object.keys(pruneStatuses(m, T0))).toEqual(['fresh']);
  });

  it('自定义那句话优先于目录标签', () => {
    const s = liveStatus({ x: { optionId: 'coffee', text: '第三杯了', at: T0 } }, 'x', T0)!;
    expect(statusLabel(s)).toBe('第三杯了');
    const bare = liveStatus({ x: { optionId: 'coffee', at: T0 } }, 'x', T0)!;
    expect(statusLabel(bare)).toBe('喝咖啡');
    // 全空格的一句话回退到标签，而不是渲染成一个空胶囊。
    const blank = liveStatus({ x: { optionId: 'coffee', text: '   ', at: T0 } }, 'x', T0)!;
    expect(statusLabel(blank)).toBe('喝咖啡');
  });
});

describe('状态目录', () => {
  it('每条都有 id/标签/emoji/色调 token 名，且 id 不重复', () => {
    const ids = STATUS_OPTIONS.map((o) => o.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const o of STATUS_OPTIONS) {
      expect(o.label.length, o.id).toBeGreaterThan(0);
      expect(o.emoji.length, o.id).toBeGreaterThan(0);
      // 存的是 token 名不是色值——铁律 1。硬编码颜色检查看的是 CSS，
      // 一个写死在 .ts 里的 #hex 它管不着，所以这里补一刀。
      expect(o.tint, o.id).toMatch(/^--color-wxstatus-/);
    }
  });

  it('statusOption 找得到 / 找不到时是 undefined 而不是兜底成第一个', () => {
    expect(statusOption('coffee')?.label).toBe('喝咖啡');
    expect(statusOption('nope')).toBeUndefined();
  });
});

describe('她挑状态：种子化、零 LLM', () => {
  const base = { contactId: 'ai_a', proactivity: 0.6, hour: 14, day: 20_400 };

  it('同一个人同一天算出同一个结果（回填重放要对得上）', () => {
    const a = pickStatus(base, seededRng);
    const b = pickStatus(base, seededRng);
    expect(a.id).toBe(b.id);
  });

  it('不同的人不会齐刷刷挂同一个状态', () => {
    const ids = new Set(
      ['ai_a', 'ai_b', 'ai_c', 'ai_d', 'ai_e', 'ai_f'].map(
        (contactId) => pickStatus({ ...base, contactId }, seededRng).id,
      ),
    );
    expect(ids.size).toBeGreaterThan(1);
  });

  it('深夜大概率是「困」，白天基本不是', () => {
    const night = ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8', 'n9', 'n10'].map(
      (contactId) => pickStatus({ ...base, contactId, hour: 3 }, seededRng).id,
    );
    expect(night.filter((id) => id === 'sleepy').length).toBeGreaterThanOrEqual(5);
  });

  it('结果一定来自目录（不会凭空造一个用户选不到的状态）', () => {
    const ids = new Set(STATUS_OPTIONS.map((o) => o.id));
    for (let i = 0; i < 60; i++) {
      const got = pickStatus({ ...base, contactId: `c${i}`, hour: i % 24 }, seededRng);
      expect(ids.has(got.id), got.id).toBe(true);
    }
  });

  it('换状态的比率比换头像高一个量级——状态本来就该常变，而且它零成本', async () => {
    const { AVATAR_SWAP_RATE } = await import('../../src/ai/moments-service');
    expect(STATUS_POST_RATE).toBeGreaterThan(AVATAR_SWAP_RATE * 5);
  });
});

describe('接线：状态挂在 moment_post 尾部，没有第 26 个 kind', () => {
  it('SCHEDULED_ACTION_KINDS 仍然是 25 种（状态不该新开一条时间演化路径）', async () => {
    const { SCHEDULED_ACTION_KINDS } = await import('../../src/db/schema');
    expect(SCHEDULED_ACTION_KINDS).toHaveLength(25);
    expect(SCHEDULED_ACTION_KINDS).not.toContain('status_post');
  });

  it('me 页那句「暂未开放」的状态 toast 没了（死入口不许回来）', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '../../src/features/me/MePage.tsx'), 'utf8');
    // 「状态」按钮现在导航到 /status-set。这个断言盯的是按钮**旁边**那句
    // toast——M-J7a 修麦克风按钮时踩过一模一样的形状：功能做完了，按钮上
    // 那句「暂未开放」还在原地。
    expect(src).toContain('/status-set');
    // 剥注释再扫（第三次踩这个了，已写进 CLAUDE.md）：解释「这里以前是
    // 暂未开放」的那句注释本身含有那四个字，源码文本扫描会把它判成违规，
    // 而它教给人的正好是反的——删掉解释就绿了。
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
    const pill = code.slice(code.indexOf('me__pills'), code.indexOf('me__right'));
    expect(pill, '状态胶囊里还留着 toast——功能已经做了').not.toContain('暂未开放');
  });
});
