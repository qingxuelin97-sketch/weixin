/**
 * 测试革命 (M-J11)：调度运行时第一次被**执行**。
 *
 * `useSchedulerRuntime.ts` 是全部 25 个 handler 的注册地，也是五个守卫的断言
 * 对象——而在这份文件之前它一次都没有被运行过。那五个守卫全是对着源码做正则：
 * 它们看得见 `registerHandler('pat_back'` 这行文本，看不见它是不是在一个
 * `if (false)` 里、看不见 25 个里有没有哪个在运行时抛了、更看不见某一个是不是
 * 被后面的注册覆盖掉了。
 *
 * 「注册了 25 个 kind」这句话，到今天为止是一句**没验证过的断言**。
 *
 * 抽出 `registerAllHandlers(deps)` 之后，这里直接调它，然后检查真实的注册结果。
 * 源码字符串守卫保留为第二道保险，没有删——两道一起，一道看形状一道看行为。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SCHEDULED_ACTION_KINDS, type ScheduledActionKind } from '../../src/db/schema';

/* 捕获注册调用。mock 掉整个 scheduler 模块，其余照旧真跑。 */
const plain: string[] = [];
const chained: string[] = [];

vi.mock('../../src/ai/scheduler', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/ai/scheduler')>();
  return {
    ...orig,
    registerHandler: (kind: string) => {
      plain.push(kind);
    },
    registerChainedHandler: (kind: string) => {
      chained.push(kind);
    },
    startScheduler: () => {},
    setHandlerErrorSink: () => {},
    setBudgetGate: () => {},
  };
});

/**
 * 自续链的清单。
 *
 * 这不是「哪些恰好是链式的」，是**哪些必须是**：这几种动作各自排下一次自己，
 * 用普通 `registerHandler` 注册就意味着一次 LLM 超时会让这条线永久停止。
 * `story_tick` 正是这么死过一次（M-G0：注释白纸黑字写着 chained，代码调的是
 * 普通版，一次超时后剧情永远停在那一幕）。
 */
const MUST_CHAIN: ScheduledActionKind[] = [
  'heartbeat',
  'agent_dm',
  'moment_post',
  'story_tick',
  'group_event',
  'group_chatter',
  'auto_backup',
];

describe('调度运行时：注册真的发生了', () => {
  // 每条用例前重新注册一遍。第一版只在头一条里调 registerAllHandlers，其余几条
  // 靠它留下的数组——而 beforeEach 会把数组清空，于是后面几条断言的是一组空
  // 数据。它们**看起来在检查链式注册，实际在检查一个空数组**，这正是这一轮
  // 反复撞见的那类假测试。
  beforeEach(async () => {
    plain.length = 0;
    chained.length = 0;
    const { registerAllHandlers } = await import('../../src/app/useSchedulerRuntime');
    registerAllHandlers({} as never);
  });

  it('每一个 SCHEDULED_ACTION_KINDS 都拿到了 handler，一个不漏', () => {
    const got = new Set([...plain, ...chained]);
    const missing = SCHEDULED_ACTION_KINDS.filter((k) => !got.has(k));
    expect(
      missing,
      '这些 kind 进了真源列表却没人注册——排期会准时到期，然后什么都不发生',
    ).toEqual([]);
  });

  it('没有注册真源之外的 kind（拼错一个字就是个永不触发的 handler）', () => {
    const known = new Set<string>(SCHEDULED_ACTION_KINDS);
    expect([...plain, ...chained].filter((k) => !known.has(k))).toEqual([]);
  });

  it('没有一个 kind 被注册两次（第二次会静默覆盖第一次）', () => {
    const all = [...plain, ...chained];
    const dupes = all.filter((k, i) => all.indexOf(k) !== i);
    expect(dupes).toEqual([]);
  });

  /**
   * 这一条是这份文件存在的最硬理由。字符串守卫可以断言源码里有
   * `registerChainedHandler('heartbeat'`，但它无法区分「调了链式版」和
   * 「在一段被注释掉的代码里写着链式版」。
   */
  it('自续链的那几种走的是 registerChainedHandler，不是普通版', () => {
    for (const kind of MUST_CHAIN) {
      expect(chained, `${kind} 必须链式注册——普通注册意味着一次失败就永久断链`).toContain(kind);
      expect(plain, `${kind} 被普通注册了`).not.toContain(kind);
    }
  });

  it('不该链式的那些也确实没链式（链式不是越多越好，它改变失败语义）', () => {
    const mustNot = SCHEDULED_ACTION_KINDS.filter((k) => !MUST_CHAIN.includes(k));
    for (const kind of mustNot) {
      expect(chained, `${kind} 不是自续链动作，却按链式注册了`).not.toContain(kind);
    }
  });

  it('清单本身覆盖了真源（MUST_CHAIN 里不许有幽灵 kind）', () => {
    const known = new Set<string>(SCHEDULED_ACTION_KINDS);
    expect(MUST_CHAIN.filter((k) => !known.has(k))).toEqual([]);
  });

  /**
   * 幂等：`useSchedulerRuntime` 的 effect 在开发模式的 StrictMode 下会跑两遍，
   * 而热重载会跑更多遍。注册两次必须仍然是「每个 kind 一个 handler」，不能因为
   * 第二遍就抛或者把状态搞坏。
   */
  it('注册两遍不炸（StrictMode / 热重载会真的这么干）', async () => {
    const { registerAllHandlers } = await import('../../src/app/useSchedulerRuntime');
    // beforeEach 已经注册过一遍，这里是第二遍。
    expect(() => registerAllHandlers({} as never)).not.toThrow();
    // 两遍下来每种恰好各出现两次——说明第二遍走的是同一条路径，没有分支漂移。
    const counts = new Map<string, number>();
    for (const k of [...plain, ...chained]) counts.set(k, (counts.get(k) ?? 0) + 1);
    expect([...new Set(counts.values())]).toEqual([2]);
  });
});
