/**
 * 调度运行时的薄壳 (M-K10)。
 *
 * 铁律 5 的唯一时间演化路径一点没变——变的只是**它什么时候被解析**。
 * `./useSchedulerRuntime` 带着全部 25 个 handler 与它们背后的子系统（AI 私信、
 * 礼物、群事件、离线回填规划器、通知编排…），此前静态挂在 App 上，于是每一次
 * 冷启动都要先解析完这约 200KB 源码才能画出会话列表——而它们最早也要等
 * hydrate 之后才可能干活。现在 App 只挂这个壳：hydrate 完成后 `import()`
 * 核心模块、调 `startSchedulerRuntime()`，首屏不再为它付费。
 *
 * 守卫们照旧读 useSchedulerRuntime.ts 的源码（注册、链式、通知表态都在那里），
 * 这个文件只负责「何时加载」与「卸载时停干净」。
 */
import { useEffect } from 'react';
import { useForegroundLifecycle } from './useForegroundLifecycle';

type RuntimeCore = typeof import('./ai-runtime');
let corePromise: Promise<RuntimeCore> | null = null;
/**
 * 同一个 promise 复用：StrictMode 的双跑、前后台回调都只触发一次加载。
 * 经 ./ai-runtime 进来（M-K11）：聊天页的发送管线走同一个动态入口，同一个块。
 */
const loadCore = (): Promise<RuntimeCore> => (corePromise ??= import('./ai-runtime'));

export function useSchedulerBoot(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void loadCore().then((core) => {
      // 加载回来时组件可能已经卸载（StrictMode 的第一跑就是这样）：
      // 那就不启动——否则会留下一个没有人负责停掉的调度器。
      if (!disposed) stop = core.startSchedulerRuntime();
    });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [enabled]);

  // 回调先拿到核心再转交：首帧之后核心早已在内存里，这一跳只是一次已决议的 promise。
  useForegroundLifecycle(enabled, {
    onForeground: () => loadCore().then((c) => c.lifecycleHooks.onForeground()),
    onBackground: () => loadCore().then((c) => c.lifecycleHooks.onBackground()),
  });
}
