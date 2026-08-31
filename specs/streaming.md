# specs/streaming.md — Web 流式（SSE）与降级链的交界

M-I5 交付。签名从 V1 起就是流式（`ChatProvider.generate(): AsyncIterable<Bubble>`），
所以"上流式"没有改任何调用方——只是让 Web 路径真的逐气泡产出、并且**逐气泡上屏**。

## 契约

- `ChatProvider.canStream?(): boolean`——**平台闸门**。浏览器 fetch 路径 true；
  原生 CapacitorHttp **不支持** SSE（桥无法中断、无增量体），永远 false，
  原生继续一次性 `generate()`。transport 检测复用现有开关，调用方零分支。
- `generateStream?(opts): AsyncIterable<Bubble>`——按 **NDJSON 气泡边界**逐个 yield
  **完整气泡**，绝不吐半句。anti-AI scrub、zod 校验都按完整气泡跑。
  - **首气泡之前**失败 → 抛各自的 kind（auth/network/…），router 落到一次性降级链；
  - **首气泡之后**中断 → 抛 `LlmError('truncated')`。已 yield 的气泡照样作数（它们
    已经在屏幕上，收不回），但"这轮没说完"必须让上层知道——吞掉它就是用户看到的
    「说到一半突然没下文」。判定源有两个：读流抛错，以及 `finish_reason` 不是
    `stop`（`length` / `content_filter`，即模型自己承认被截断）。
  - **用户主动中断（abort）不是截断**：signal 已 aborted 时安静收场，不会给一条
    用户已经走开的回复补上"先不说了"。
- Router：只在**主 rung**上流式。首气泡产出前的拒答/失败仍走完整三级降级链
  （软化重试 → 宽松链 → 人设化拒绝）；**首气泡一旦上屏，降级链关闭**——已说出的话收不回，
  流中断走**人设化截断**，不重试、不换链。拒答检测在首气泡上做。
- `GenerateContext.personaTruncation?()`——被打断时的收尾台词，与 `personaRefusal`
  **同源但不同语气**：拒答是「我现在不想聊这个」，截断是「……先不说了，这边有点事」。
  两者混用会读成「说到一半突然翻脸」，比没有还糟。单聊引擎提供它（种子化选句，
  铁律 4）；群聊**故意不提供**——群里一个人说一句就没声了本来就正常，三个人各自
  补一句"先不说了"反而更假。

## 渐进上屏（engine + group-engine）

传输层真流式只是一半。引擎侧原本是 drain-then-play（把整个 AsyncIterable 收完再
按节奏播），所以**用户感知与上流式之前完全一样**。现在两个引擎都边收边播：

- `src/ai/bubble-feed.ts` 的 `playbackFeed()` 是唯一的那份缓冲：生产侧按网络速度
  把气泡抽进队列，播放侧按打字节奏一条条取。
- **可打断**不变：`signal` 一 abort，未播队列直接作废（`next()` 立刻返回 null），
  中断后不再上屏任何后续气泡。
- **打字指示器**语义从「数组下标 == 最后一条」改成「feed 排空了」：还在流的时候
  指示器亮着不是残留，是事实。
- **anti-AI scrub 仍按完整气泡跑**：`makeScrubber()` 是 `scrubBubbles()` 的增量形式
  （到达顺序 == 播放顺序，判定逐条等价），`keepLast` 复刻它的「永不清空」不变量。
  两者共用同一份实现，不会分叉成两套"重复"的定义。
- **非流式 Provider 行为不变**：一次性 yield 全部气泡时，队列在第一条打字延迟走完
  之前就已经满了，节奏与旧循环逐字重合。
- 群聊：演员**仍然全部并发生成**（那是群聊一轮能在几秒内出声的原因），只是排序
  提前到生成之前，播放按导演优先级逐个消费各自的 feed——最高优先级的演员边写边说，
  后面的继续在后台写。

## 转红测试

- SSE fixture 流出 ≥2 个独立气泡（`tests/unit/sse-stream.test.ts`）
- 原生 transport 路径不引用 SSE reader（源码级断言）
- 首气泡后不得触发重试链（fixture：首气泡后断流 → 断言无第二次请求）
- 首气泡后断流 → `LlmError('truncated')`；abort → 不是截断；`finish_reason=length`
  → 是截断（`tests/unit/sse-stream.test.ts`）
- **渐进**（`tests/unit/i5-progressive.test.ts`，单聊 + 群聊各一条）：fixture 逐个
  yield 3 个气泡、每个之间有间隔 → 断言**第一个气泡上屏早于最后一个气泡产出**。
  这条直接锁死 drain-then-play：那种写法下所有 produce 都排在所有 append 之前。
- 截断台词已追加且降级链没被触发；abort 后不再上屏；非流式路径节奏不变

## 陷阱（已录 CLAUDE.md 的沿用）

- 原生桥的"超时"必须是真拒绝（`Promise.race` 一个会 reject 的定时器）——SSE 不适用于
  原生正是因为桥挂起不可中断。
- 半个 JSON 行绝不能进 `parseBubbles`：reader 按行缓冲，未闭合的行留在缓冲区等下一个 chunk。
- `finish_reason` 要在「delta 为空就 continue」**之前**读：带 finish_reason 的那一帧
  通常根本没有 content，先跳过就等于永远看不见"被截断"。
- 渐进上屏之后，引擎的兜底 catch 必须先看「这轮已经上屏了几条」：已经播出三条再补一句
  「信号不太好」不是兜底，是穿帮。
- 群聊里那几个还没被 await 的 actor promise 必须在**创建处**就 `.catch()`：它们要在
  前面的演员播完之前一直挂着，这个窗口里的 unhandled rejection 会直接掀掉进程。
