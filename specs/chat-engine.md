# spec: 单聊拟真引擎（M2）

**文件**：`src/ai/engine.ts`、`src/ai/memory.ts`、`src/ai/heartbeat.ts`、`src/llm/service.ts`。

## 一次发送的完整链路
1. 用户消息**立即入库上屏**（永不因为等 AI 而卡住输入）。
2. 组装上下文：`assembleSystemPrompt`（人设 + **记忆注入** + NSFW 边界层）+ 近 30 条消息窗口。
3. 标题切「对方正在输入…」→ `LlmRouter.generate`（role=chat，convKey=convId，带三级降级）。
4. 多气泡**边收边播**（M-I5，见 `specs/streaming.md`）：气泡一到就按
   `typingDelay(bubble, persona.typingCpm)`（上限 6s）延迟后入库 + 播提示音，不再等
   整轮收完；「最后一条」由 `playbackFeed.finished` 判定（源排空且缓冲为空），
   落地前先撤下「正在输入」。首气泡之后流断了 → 追加人设化收尾（不是拒答话术）。
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

## M-K11：ChatPage 拆成三块

ChatPage 长到 1,996 行，「她怎么回」的编排在里面复制了五份（发送 / 重试 / 发图后 / 发语音后 /
游戏位置名片文件之后），每份都自己读档位、拼钩子、按会话类型分流。拆成：

| 块 | 文件 | 管什么 |
|---|---|---|
| 线程 | `features/chat/ChatThread.tsx` | 时间条、钉底与事后长高的重新贴底、加载更早历史、`?at=` 锚定与闪烁、多选外壳、「正在输入」气泡。每条消息画成什么样由页面的 `renderMessage` 给出 |
| 发送管线 | `features/chat/send-pipeline.ts` | `sendText` / `replyToNewest` / `regenerate` / `stickerRound` / `memExtractOnLeave` / `translateMessage` / `micTierFor`。状态一律在调用时从 store 现读 |
| 组合器 | `features/chat/Composer.tsx` | 输入条、表情与「＋」面板、三个隐藏选择器。三态状态机仍是 `useComposerPanel`（实例由页面持有——面板高度同时决定线程区留白） |

页面本身留下的是**页面状态**：会话横幅、置顶、公告、剧情条、长按菜单、各种 Sheet、`onAction`
的分支（导航与开面板）。

- **发送管线只许懒加载**：经 `app/ai-runtime.ts` 进来，与调度运行时同一个动态入口、同一个块；进聊天页
  时预取。主包 312.0 → 305.3KB。store 删联系人时中止回复改从 `ai/inflight` 拿（那一个静态 import
  曾把整棵引擎树钉在主包里）。
- **拆分不改一像素**：本地同一 Chromium 下，拆分前后单聊 / 群聊 / ＋面板 / 表情面板 / 语音模式 /
  打了字的输入条六个状态逐像素一致；golden 门禁再复核一次。
- 跟着代码搬家的守卫：引用在两种会话里都带上（chat-ops W1，现在一半断言页面、一半断言管线）、
  发图/语音后请求回复（W2）、斗图走队列（handlers、j2）、群聊离开时带 group 标记（j2）、
  回车发送（k4）、两个话筒都接了 onClip（j7a）。

