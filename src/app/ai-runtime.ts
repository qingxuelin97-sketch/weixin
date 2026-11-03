/**
 * AI 运行时的唯一懒加载入口 (M-K11)。
 *
 * 调度运行时（25 个 handler，K10 起懒加载）与聊天页的发送管线（K11）用的是**同一棵
 * 引擎树**。两边各自 `import()` 的时候，Rollup 按「谁能到达它」切块：运行时独有的、
 * 管线独有的、两边共享的引擎——三个小块各自 gzip，失去共享字典，K11 实测开销 41%
 * （主包 −6.60KB，懒包 +9.33KB），超过宪法 3.5 的三分之一线。
 *
 * 两边改从这一个文件进来，就只有一个动态入口、一个块。它本来就在每次启动 hydrate
 * 之后由 useSchedulerBoot 加载；聊天页拿到的是已经在内存里的同一个模块。
 */
export * from './useSchedulerRuntime';
export * as chat from '../features/chat/send-pipeline';
