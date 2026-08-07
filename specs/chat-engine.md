# spec: 单聊拟真引擎（M2）

**文件**：`src/ai/engine.ts`、`src/ai/memory.ts`、`src/ai/heartbeat.ts`、`src/llm/service.ts`。

## 一次发送的完整链路
1. 用户消息**立即入库上屏**（永不因为等 AI 而卡住输入）。
2. 组装上下文：`assembleSystemPrompt`（人设 + **记忆注入** + NSFW 边界层）+ 近 30 条消息窗口。
3. 标题切「对方正在输入…」→ `LlmRouter.generate`（role=chat，convKey=convId，带三级降级）。
4. 多气泡逐条播放：每条按 `typingDelay(bubble, persona.typingCpm)`（上限 6s）延迟后入库 + 播提示音；
   最后一条落地前先撤下「正在输入」。
5. `recall` 气泡 = 先发后撤（发出 → 1.5s → `is_recalled=true`）。

## 硬规则
- **可打断**：同会话再次发送 → `AbortController.abort()`，未播队列直接丢弃后重新生成。拟真核心。
- **原始报错永不上屏**：路由三级降级都失败 → 人设化兜底话术（带该人设口头禅）。
- **有效 NSFW 档** = `min(全局档, 人设许可位)`（`effectiveTier`）；全开档由 router 锁宽松通道。
- 时间由 `hooks.now()` 注入，不在引擎里调 `Date.now()`（可测试/可回放）。

## 记忆（`memory.ts`）
- 注入 = pinned 全量（≤10）+ 其余按 `importance × 0.5^(age/30天)` 取 Top20；archived 不注入；
  排序稳定（吃 DeepSeek 前缀缓存）。纯函数，已单测。
- 抽取：LLM 输出 JSON，**无 `evidence_msg_ids` 的事实直接丢弃**（灭幻觉的第一道闸）；
  fact ≤50 字，importance 1-5，落库 status=pending。

## 心跳（`heartbeat.ts`）
- 唯一时间演化路径 = `scheduled_actions` 队列（宪法铁律 5）。
- `nextHeartbeatAt` 用 `seededRng(personaId+dayBucket)` → **重开 App 不重摇**；
  间隔按 proactivity 缩放，向后推到落入 `activeHours` 才排（跨午夜窗口如 [14,26] 支持）。

## 验收
- [x] 无 key 时发送 → 人设化兜底上屏，无报错泄漏，无崩溃（已 E2E 验证）。
- [x] 刷新页面消息不丢（IndexedDB 持久化，已 E2E 验证）。
- [x] 记忆打分/注入、心跳排期确定性（单测覆盖）。
- [ ] 有 key 后真机验证：30 分钟对话无穿帮、断网走降级链、多气泡节奏自然。

## 语音（M3 补齐）
- `voiceMeta()` 在 voice 气泡入库前合成音频：`ensureVoiceAudio` → MiniMax t2a_v2，
  **时长取 API 返回的真实值**（按字数估算一播就穿帮）；内容寻址缓存，重发不重复计费。
- **NSFW 全开档硬跳过 TTS**（`tier === 'full'` 直接返回估算时长 + `ttsSkipped:'nsfw'`）——
  露骨文本永不出境到 MiniMax 官方端点。见 `specs/nsfw.md`。
- 未配 MiniMax key 时静默降级为无音频气泡，不报错、不阻断消息流。

## 已知坑
- 兜底话术也会走打字延迟（~7s），是有意为之（像"她在打字"），不是卡顿。
- 群聊走 `src/ai/group-engine.ts`（见 `specs/group-director.md`），不走本文件的单聊路径。
