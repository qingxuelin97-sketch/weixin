# spec: 群聊导演调度（M3）

**文件**：`src/ai/director.ts`（决策）、`src/ai/group-engine.ts`（执行）。

## 两层设计（为什么不是一层）
1. **`prefilter`——纯代码，<1ms**。处理显而易见的情况，**约半数轮次直接跳过导演 LLM**，
   这是"跳导演首响 ≤3s"的来源。
   - 被 @ 的成员必回 → `mode:'direct'`，直接命中演员
   - 剔除：不在 `activeHours` / 冷却期内（默认 45s）/ 连续发言达上限（默认 3）
   - 候选 0 → `silence`；候选 1 → 按 `proactivity` 种子掷骰；候选 ≥2 → `director`
   - **无人设卡的成员被跳过而非崩**（种子里可能有没配人设的群友）
2. **`callDirector`——一次轻量 LLM**，只在真正歧义时调用，输出调度 JSON。

## 硬规则
- **演员并发生成、按 priority 顺序播放**。串行会把 3 个演员叠成 20s+ 才出第一条；
  并发后首条 = 最快的那个演员返回即可上屏，其余被打字延迟吸收。
- 导演解析失败（坏 JSON / 网络 / 拒答）→ **降级为"选最相关 1 人"**，绝不因此让群哑掉。
- 导演可能幻觉出不存在的 agentId → 一律按候选名单过滤；cast 上限 3 人。
- 演员生成失败 → **静默**（该成员这轮不说话），不把报错甩进群里。
- 用户再次发送 = `AbortController` 硬中断，丢弃未播队列后重排。
- 导演提示注入 system prompt **末尾**（吃 recency），内容是方向而非台词。

## 数据依赖
`ConversationVM.memberIds`（V1 上限 4 个 AI）、每个成员的 `PersonaVM`。
`assembleSystemPrompt` 的 `scene.kind='group'` + `groupRoster` 已支持。

## 验收
- [x] 决策表单测 19 例（@必回 / 冷却 / 连发 / 非活跃 / 0候选 / 单候选确定性 / 无人设跳过 /
      坏 JSON 降级 / 幻觉成员过滤 / cast 上限）。
- [ ] 有 key 后真机验：跳导演首响 ≤3s、全量 ≤6s；群聊涌现自然、无刷屏；插话即重排。

## 已知坑
- `prefilter` 的种子含时间戳，同一轮内确定性、跨轮次不同——这是有意的（否则每轮同一人发言）。
- 群聊目前不注入 `relations`（`assembleSystemPrompt` 支持但未接），成员间关系感待 M4 补。
