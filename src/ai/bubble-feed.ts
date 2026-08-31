/**
 * 渐进上屏的缓冲（M-I5 的另一半）。
 *
 * I5 让传输层真流式了（SSE 按 NDJSON 气泡边界逐个 yield），但引擎仍然是
 * drain-then-play——把整个 AsyncIterable 收完再按节奏播。于是用户感知与上流式
 * 之前**完全一样**：第一条气泡还是要等整轮生成结束才出现。
 *
 * 这个模块就是那半步：一个生产/消费解耦的气泡缓冲。生产侧按网络的速度把气泡
 * 抽进队列，播放侧按打字节奏一条条取——第一条到了就能上屏，后面的边收边播。
 *
 * 三条必须保住的性质写在这里，而不是散在两个引擎里：
 *  1. **可打断**：signal 一 abort，队列里没播的气泡直接作废（`next()` 立刻返回
 *     null），中断后不得再上屏任何后续气泡；
 *  2. **anti-AI scrub 按完整气泡跑**：`accept` 在气泡**到达**时判定（到达顺序
 *     == 播放顺序，所以判定结果与整轮收完再 scrub 完全一致），绝不切半句；
 *  3. **永不清空**：`keepLast` 复刻 `scrubBubbles` 的不变量——全被刷掉时最后一条
 *     照样放行（沉默比重复更像 App 坏了）。
 *
 * 非流式 Provider（原生 CapacitorHttp、`canStream()` 为 false）走同一条路：
 * 一次性 yield 全部气泡时，队列在播第一条之前就已经满了，`finished` 的时机与
 * 原来的 `i === bubbles.length - 1` 逐字重合——行为不变。
 */
import type { Bubble } from '../llm/types';

export interface BubbleFeed {
  /**
   * 下一个可播的气泡；源已排空（或已中断）时返回 null。
   * 源抛错时，先把缓冲里的气泡交完，再把错误抛给调用方。
   */
  next(): Promise<Bubble | null>;
  /** 源已结束且缓冲为空——即「刚才那条就是最后一条」。 */
  readonly finished: boolean;
  /** 还没被取走的气泡数（用于判断「后面还有没有」）。 */
  readonly buffered: number;
}

export interface FeedOptions {
  /** 中断信号：abort 后停止收，且丢弃未播队列。 */
  signal?: AbortSignal;
  /** 到达即判定是否可播；返回 false = 丢弃（scrub）。同步，且必须无副作用地可重入。 */
  accept?: (b: Bubble) => boolean;
  /** accept 全否时放行最后一条（`scrubBubbles` 的「永不清空」不变量）。 */
  keepLast?: boolean;
}

/**
 * 把一个气泡流抽进队列，交给播放侧按自己的节奏取。
 *
 * 单消费者：`next()` 不支持并发调用（两个播放循环抢同一个流本身就是 bug）。
 */
export function playbackFeed(src: AsyncIterable<Bubble>, opts: FeedOptions = {}): BubbleFeed {
  const queue: Bubble[] = [];
  let done = false;
  let failure: { err: unknown } | null = null;
  let wake: (() => void) | null = null;
  const bump = () => {
    const w = wake;
    wake = null;
    w?.();
  };

  // 中断时立刻叫醒消费者：源未必会自己结束（provider 的 fetch 通常会被
  // signal 打断，但没有任何东西保证这一点），消费者不该为此永远挂在 await 上。
  opts.signal?.addEventListener(
    'abort',
    () => {
      done = true;
      bump();
    },
    { once: true },
  );

  void (async () => {
    let accepted = 0;
    let last: Bubble | null = null;
    try {
      for await (const b of src) {
        if (opts.signal?.aborted) break;
        last = b;
        if (opts.accept && !opts.accept(b)) continue;
        accepted++;
        queue.push(b);
        bump();
      }
    } catch (e) {
      failure = { err: e };
    } finally {
      // 「永不清空」：全被刷掉时最后一条照样发——它最新鲜。放在收尾处而不是
      // 到达处，是因为只有源结束时才知道「一条都没留下」。
      if (opts.keepLast && accepted === 0 && last && !opts.signal?.aborted) queue.push(last);
      done = true;
      bump();
    }
  })();

  return {
    get buffered() {
      return queue.length;
    },
    get finished() {
      return done && queue.length === 0;
    },
    async next(): Promise<Bubble | null> {
      for (;;) {
        // 中断优先于队列：未播的气泡是要丢弃的，不是要补播的。
        if (opts.signal?.aborted) return null;
        const b = queue.shift();
        if (b) return b;
        if (done) {
          if (failure) {
            const { err } = failure;
            failure = null; // 只抛一次，之后这个 feed 就是排空状态
            throw err;
          }
          return null;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
}
