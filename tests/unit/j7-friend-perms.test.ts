/**
 * 朋友权限与标签 (M-J7).
 *
 * 这一份守的不是「开关能不能存下来」——那种测试通过与否都说明不了什么。它守的是
 * **开关真的改变了她的行为**：不让她看我的朋友圈之后，排期规划器一条赞评都不该
 * 给她排；不看她的朋友圈之后，她的动态不该出现在我的信息流里。
 *
 * 之所以值得用一整份文件写：本 App 里泄漏面最狠的一处就是朋友圈的赞评。
 * 消息可以撤回，赞不能——「她给一条我设成不给她看的动态点了赞」是一次性的、
 * 不可逆的穿帮。所以 `canSeeMoment` 的权限参数是**必填**的，而下面第一组
 * 测试就是在钉死这个收口：任何一条读路径绕过它，这里都会红。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  NO_FRIEND_PERMS,
  NO_TAGS,
  canSeeMyMoments,
  chatOnlyIds,
  groupByTag,
  isRestricted,
  parseTags,
  permLabel,
  setPerm,
  setTags,
  showsInMyFeed,
  TAG_MAX_LEN,
  type FriendPermMap,
} from '../../src/lib/friend-perms';
import { canSeeMoment, visibleMoments } from '../../src/lib/moment-visibility';
import { planReactions, type ReactorInfo } from '../../src/ai/moments-engine';
import type { MomentVM } from '../../src/data/types';

const ROOT = resolve(__dirname, '../../');
const T0 = 1_754_600_000_000;

const post = (authorId: string, id = 'm1'): Pick<MomentVM, 'id' | 'authorId' | 'createdAt' | 'visibility'> => ({
  id,
  authorId,
  createdAt: T0,
});

const reactor = (contactId: string): ReactorInfo => ({
  contactId,
  // Rates pinned at 1 so a missing reaction can only mean "the rule dropped
  // her", never "the dice went the other way".
  likeRate: 1,
  commentRate: 1,
  affinity: 80,
  activeHours: [[0, 24]],
});

describe('朋友权限：两个方向各自独立', () => {
  it('不让他看 = 他看不到我的，但我照样看得到他的', () => {
    const perms: FriendPermMap = { ai_a: { hideMine: true } };
    expect(canSeeMyMoments(perms, 'ai_a')).toBe(false);
    expect(showsInMyFeed(perms, 'ai_a')).toBe(true);
    expect(canSeeMoment(post('self'), 'ai_a', perms)).toBe(false);
    expect(canSeeMoment(post('ai_a'), 'self', perms)).toBe(true);
  });

  it('不看他 = 我看不到他的，但他照样看得到我的', () => {
    const perms: FriendPermMap = { ai_a: { hideTheirs: true } };
    expect(canSeeMyMoments(perms, 'ai_a')).toBe(true);
    expect(showsInMyFeed(perms, 'ai_a')).toBe(false);
    expect(canSeeMoment(post('self'), 'ai_a', perms)).toBe(true);
    expect(canSeeMoment(post('ai_a'), 'self', perms)).toBe(false);
  });

  it('仅聊天 一个开关顶两个方向', () => {
    const perms: FriendPermMap = { ai_a: { chatOnly: true } };
    expect(canSeeMoment(post('self'), 'ai_a', perms)).toBe(false);
    expect(canSeeMoment(post('ai_a'), 'self', perms)).toBe(false);
  });

  it('权限只管我和她之间——两个 AI 互相之间没有权限，只有关系', () => {
    // ai_a 被我设成仅聊天，但 ai_b 看 ai_a 的动态不受影响：这条规则的主语
    // 始终是 'self'，不是「任何人」。写反了会让她们在私信里突然互相看不见。
    const perms: FriendPermMap = { ai_a: { chatOnly: true } };
    expect(canSeeMoment(post('ai_a'), 'ai_b', perms)).toBe(true);
  });

  it('作者永远看得到自己的（权限不该把她自己的动态藏起来）', () => {
    const perms: FriendPermMap = { ai_a: { chatOnly: true } };
    expect(canSeeMoment(post('ai_a'), 'ai_a', perms)).toBe(true);
  });

  it('与可见范围叠加时取交集：任一条拒绝就是拒绝', () => {
    const perms: FriendPermMap = { ai_a: { hideMine: true } };
    const open = { ...post('self'), visibility: undefined };
    // 公开 + 不让他看 → 拒绝（权限先判，可见范围管不着）
    expect(canSeeMoment(open, 'ai_a', perms)).toBe(false);
    // 部分可见白名单里有她 + 不让他看 → 仍然拒绝
    const included = { ...post('self'), visibility: { mode: 'include' as const, ids: ['ai_a'] } };
    expect(canSeeMoment(included, 'ai_a', perms)).toBe(false);
    // 没有权限限制时，可见范围照旧说了算
    expect(canSeeMoment(included, 'ai_a', NO_FRIEND_PERMS)).toBe(true);
    expect(canSeeMoment(included, 'ai_b', NO_FRIEND_PERMS)).toBe(false);
  });
});

describe('朋友权限真的改变行为，不只是存了个开关', () => {
  /**
   * 这一条是整个功能的意义所在。开关存下来而排期照排，用户看到的就是
   * 「设置了没用」——而且是以最坏的方式看到：她点了赞。
   */
  it('不让他看 → 排期规划器一条赞评都不给她排', () => {
    const crowd = [reactor('ai_a'), reactor('ai_b')];
    const all = planReactions(post('self'), crowd, 'seed', NO_FRIEND_PERMS);
    expect(all.some((r) => r.contactId === 'ai_a')).toBe(true);

    const blocked = planReactions(post('self'), crowd, 'seed', { ai_a: { hideMine: true } });
    expect(blocked.some((r) => r.contactId === 'ai_a')).toBe(false);
    // 别人不受牵连——一个开关只该影响一个人。
    expect(blocked.some((r) => r.contactId === 'ai_b')).toBe(true);
  });

  it('不看他 → 她的动态不进我的信息流，别人的照旧', () => {
    const feed = [post('ai_a', 'm_a'), post('ai_b', 'm_b'), post('self', 'm_self')];
    const kept = visibleMoments(feed, 'self', { ai_a: { hideTheirs: true } });
    expect(kept.map((m) => m.id)).toEqual(['m_b', 'm_self']);
  });

  /**
   * 追溯生效是这个功能与「可见范围」最大的区别：可见范围是发帖那一刻定的，
   * 权限是对**已经存在的一切**生效的。所以它只能做在读侧——写侧折叠进旧行
   * 的做法看着更省事，但改开关时改不动昨天的帖子。
   */
  it('对已经发过的旧动态同样生效（追溯，不是只管新帖）', () => {
    const old = { ...post('self', 'm_old'), createdAt: T0 - 30 * 86_400_000 };
    expect(canSeeMoment(old, 'ai_a', NO_FRIEND_PERMS)).toBe(true);
    expect(canSeeMoment(old, 'ai_a', { ai_a: { hideMine: true } })).toBe(false);
  });
});

describe('权限表的写入语义', () => {
  it('全部关掉 = 删掉这个人的条目，而不是留一行空对象', () => {
    let perms = setPerm(NO_FRIEND_PERMS, 'ai_a', { hideMine: true });
    expect(perms.ai_a).toEqual({ hideMine: true });
    perms = setPerm(perms, 'ai_a', { hideMine: false });
    expect('ai_a' in perms).toBe(false);
    expect(isRestricted(perms, 'ai_a')).toBe(false);
  });

  it('写一个开关不动另一个（patch 不是覆盖）', () => {
    let perms = setPerm(NO_FRIEND_PERMS, 'ai_a', { hideMine: true });
    perms = setPerm(perms, 'ai_a', { hideTheirs: true });
    expect(perms.ai_a).toEqual({ hideMine: true, hideTheirs: true });
  });

  it('仅聊天不写坏细粒度开关——关掉它能回到原来的选择', () => {
    // 微信的粗开关会「顶替」细开关。实现成同时写两个细开关的话，用户关掉
    // 仅聊天时拿回来的是一个被改过的状态，而不是他自己设过的那个。
    let perms = setPerm(NO_FRIEND_PERMS, 'ai_a', { hideMine: true });
    perms = setPerm(perms, 'ai_a', { chatOnly: true });
    expect(canSeeMoment(post('ai_a'), 'self', perms)).toBe(false); // 顶替生效
    perms = setPerm(perms, 'ai_a', { chatOnly: false });
    expect(perms.ai_a).toEqual({ hideMine: true }); // 原来的选择还在
    expect(canSeeMoment(post('ai_a'), 'self', perms)).toBe(true);
  });

  it('不写入的人完全不占位（缺席即完整权限）', () => {
    const perms = setPerm(NO_FRIEND_PERMS, 'ai_a', { chatOnly: true });
    expect(Object.keys(perms)).toEqual(['ai_a']);
    expect(canSeeMyMoments(perms, 'ai_b')).toBe(true);
    expect(chatOnlyIds(perms)).toEqual(['ai_a']);
  });

  it('资料页那行的摘要文案', () => {
    expect(permLabel(NO_FRIEND_PERMS, 'ai_a')).toBe('朋友圈');
    expect(permLabel({ ai_a: { chatOnly: true } }, 'ai_a')).toBe('仅聊天');
    expect(permLabel({ ai_a: { hideMine: true, hideTheirs: true } }, 'ai_a')).toBe('不让他看、不看他');
  });
});

describe('标签', () => {
  it('多种分隔符都认，去重、去空、保序', () => {
    expect(parseTags('同事, 球友、同事  发小')).toEqual(['同事', '球友', '发小']);
    expect(parseTags('   ')).toEqual([]);
  });

  it('超长标签截断（通讯录分组头一行放不下）', () => {
    const long = '一'.repeat(TAG_MAX_LEN + 8);
    expect(parseTags(long)[0]).toHaveLength(TAG_MAX_LEN);
  });

  it('清空标签 = 删掉条目', () => {
    let tags = setTags(NO_TAGS, 'ai_a', ['同事']);
    expect(tags.ai_a).toEqual(['同事']);
    tags = setTags(tags, 'ai_a', []);
    expect('ai_a' in tags).toBe(false);
  });

  it('倒排成标签索引：按人数降序，同人数按名字', () => {
    const groups = groupByTag({
      ai_a: ['同事', '球友'],
      ai_b: ['同事'],
      ai_c: ['同事', '发小'],
    });
    expect(groups[0]).toEqual({ tag: '同事', contactIds: ['ai_a', 'ai_b', 'ai_c'] });
    // 球友 与 发小 各一人，按名字定序（而不是看谁先被遍历到）
    expect(groups.slice(1).map((g) => g.tag)).toEqual(['发小', '球友']);
  });

  it('空表倒排成空数组，不是 undefined', () => {
    expect(groupByTag(NO_TAGS)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 收口守卫                                                            */
/* ------------------------------------------------------------------ */

describe('权限参数必须留在收口处', () => {
  /**
   * `canSeeMoment(m, viewer)` 少传第三个参数在类型上就过不去，这是这个设计的
   * 全部意义。但「过不去」只有在**没人给它加默认值**时才成立——加一个
   * `perms = NO_FRIEND_PERMS` 的默认值会让所有调用点重新变成静默泄漏，而且
   * 所有测试照样绿。所以这条扫源码。
   */
  it('canSeeMoment / visibleMoments 的 perms 参数不许有默认值', () => {
    const src = readFileSync(resolve(ROOT, 'src/lib/moment-visibility.ts'), 'utf8');
    expect(src).toMatch(/canSeeMoment\([^)]*perms: FriendPermMap\s*\)/);
    expect(src).not.toMatch(/perms: FriendPermMap\s*=/);
  });

  /**
   * 两个驱动都必须在自己内部读权限。少一个，换存储驱动就等于把整张权限表
   * 静默关掉——而这正是 `visibleMoments` 当初被放进驱动的理由。
   */
  it('两个存储驱动都在内部应用权限', () => {
    for (const f of ['src/db/repo.ts', 'src/db/sqlite.ts']) {
      const src = readFileSync(resolve(ROOT, f), 'utf8');
      expect(src, `${f} 没有读权限表`).toContain('getFriendPerms');
      expect(src, `${f} 的可见性过滤没带上权限`).toMatch(
        /visibleMoments\([\s\S]{0,120}getFriendPerms\(\)/,
      );
    }
  });

  /**
   * 新增一个 moment 读路径而忘了权限，是这个功能最可能的失效方式。类型系统
   * 挡得住 `canSeeMoment`，挡不住「直接从 store 里 filter 一遍自己画列表」。
   */
  it('src/ai 里每个 canSeeMoment 调用都传了真权限，没有人偷懒传 NO_FRIEND_PERMS', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts')) {
          const src = readFileSync(resolve(ROOT, p), 'utf8');
          for (const m of src.matchAll(/canSeeMoment\(([^;]*?)\)[\s)]/g)) {
            // simulate.ts 是纯函数，权限由 SimInput 带进来，缺省才是 NO_*。
            if (m[1].includes('NO_FRIEND_PERMS') && !p.endsWith('simulate.ts')) {
              offenders.push(`${p}: ${m[0].trim()}`);
            }
          }
        }
      }
    };
    walk('src/ai');
    expect(offenders, 'AI 侧的可见性判断必须用真权限表，不能用空表糊弄过去').toEqual([]);
  });
});
