# specs/streaming.md — Web 流式（SSE）与降级链的交界

M-I5 交付。签名从 V1 起就是流式（`ChatProvider.generate(): AsyncIterable<Bubble>`），
所以"上流式"没有改任何调用方——只是让 Web 路径真的逐气泡产出。

## 契约

- `ChatProvider.canStream?(): boolean`——**平台闸门**。浏览器 fetch 路径 true；
  原生 CapacitorHttp **不支持** SSE（桥无法中断、无增量体），永远 false，
  原生继续一次性 `generate()`。transport 检测复用现有开关，调用方零分支。
- `generateStream?(opts): AsyncIterable<Bubble>`——按 **NDJSON 气泡边界**逐个 yield
  **完整气泡**，绝不吐半句。anti-AI scrub、zod 校验都按完整气泡跑。
- Router：只在**主 rung**上流式。首气泡产出前的拒答/失败仍走完整三级降级链
  （软化重试 → 宽松链 → 人设化拒绝）；**首气泡一旦上屏，降级链关闭**——已说出的话收不回，
  流中断走人设化截断，不重试、不换链。拒答检测在首气泡上做。
- 引擎侧目前仍 drain-then-play（把流收完再按节奏播）——渐进上屏是 I8 的活，
  流式先保证"传输层真流式、行为与非流式等价"。

## 转红测试

- SSE fixture 流出 ≥2 个独立气泡（`tests/unit/sse-stream.test.ts`）
- 原生 transport 路径不引用 SSE reader（源码级断言）
- 首气泡后不得触发重试链（fixture：首气泡后断流 → 断言无第二次请求）

## 陷阱（已录 CLAUDE.md 的沿用）

- 原生桥的"超时"必须是真拒绝（`Promise.race` 一个会 reject 的定时器）——SSE 不适用于
  原生正是因为桥挂起不可中断。
- 半个 JSON 行绝不能进 `parseBubbles`：reader 按行缓冲，未闭合的行留在缓冲区等下一个 chunk。
