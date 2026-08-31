# specs/call.md — 语音通话 v2 + 在线感

M-D2 出通话壳（能响、能接、能挂），M-H1 让她会主动打来，**M-I16 让她在通话里真的说话**。

## 通话 v2 的三条链

1. **台词**（`src/ai/call-script.ts`）。接通后经 `getRouter()` 生成开场白与逐句应答，
   prompt 复用 `assembleSystemPrompt`（persona + 关系 + 边界 + 记忆，**六层顺序不动**），
   通话场景块 `CALL_SCENE` 追加在最后——与 engine 的 `extraDirective` 同一纪律，
   前缀可缓存。场景块明确「这是嘴上说出来的话」：只出 text 气泡、不发表情图片、
   一次 1~3 句。`openerDirective(direction)` 区分是她拨来还是你拨去。
2. **发声**（`src/lib/voice.ts` TTS + 缓存）。逐句合成播放，音色取 `persona.ttsVoice`。
   播放队列可被挂断/插话中断（AbortController，与引擎的可打断设计同构）。
3. **纪要**（`summarizeCall` → `recordCallOutcome`）。挂断时一次 LLM 出纪要，失败落
   `ruleSummary` 规则兜底；`extractCallPromises` 把「说好了周五」这类承诺写进
   conv-state 的 promises 通道（上限 `MAX_PROMISES = 2`），后续聊天因此能引用电话里说过的事。

## 铁律

- **全开档禁 TTS**：`callTtsAllowed(tier) === false when tier==='full'`，退化为**字幕模式**
  （台词照出，只是不发声）。理由与铁律 6 同源——大陆 TTS 端点不接全开档内容。
  单测直接钉死这个函数。
- 通话轮次**不落聊天消息**（微信通话内容不进聊天记录）。落进聊天的只有一条
  `type:'call'` 消息，meta 带时长与纪要——纪要同时进 `render-msg` 投影，
  所以模型后续看得见「电话里说好了周五」。
- tier 一律推导（`effectiveTier(globalTier, persona.nsfwPermit)`），新调用点进
  `nsfw-callsite` 测试。
- 无 TTS key / 无 ASR 配置时**逐级降级**而不是报错：无 TTS → 字幕；无 ASR → 文字输入条。

## 在线感（同期交付）

- **正在输入的节奏**（`src/lib/typing-rhythm.ts`）：seeded 纯函数产出「敲一阵—停—再敲」
  的节拍，替代恒定三点。种子化=可重放（铁律 4）。
- **已读回执**：微信本身没有已读回执，所以这是**可选拟真项**，settings KV `readReceipts`
  **默认关**；开启后自己最后一条被"看过"的消息下方出现小号「已读」。
- **刚刚活跃**（`src/ai/presence.ts` `recentlyActive`）：由 activeHours + 半小时种子桶
  推导的低频绿点，朋友圈作者名旁显示。纯投影：不落库、不新建计时器。

## 验收清单

- [x] 接通后她先开口，你能按住说话（ASR）或打字，她逐句应答
- [x] 挂断落 `type:'call'` 消息 + 纪要，承诺进 conv-state 且能被后续聊天引用
- [x] 全开档不发声只出字幕（单测钉死）
- [x] 通话内容不进聊天记录
- [x] 输入节奏/已读/活跃点全部 seeded 可重放
- [ ] 真机验收：耳返、蓝牙耳机、锁屏中断后的恢复（容器测不了）

## 已知坑

- **AudioContext 每次退后台都被 Android 挂起**，`resume()` 是异步：播放前必须
  `await resume()`，否则在挂起态排的音窗永远无声。一次性的 unlocked 标志挡不住第二次挂起。
- 通话是**双生产者**页面：app 内接听（`?in=1`）与来电全屏（`?incoming=1&accept=1`）
  都进同一个 CallPage，改参数解析时两条路径都要走一遍。

## M-J1 · 通话同脑

- **buildCallSystem 补层**：mood/affect 进场景层（与引擎同源 `affectLine`），
  lifeline → goal → occasion 依引擎惯例追加在 scene 之后、`CALL_SCENE` 补充块之前。
  goal 走 goal-service（按人设生成的模板 + 用户改名/放弃覆盖），电话里聊到的
  是她微信里正在忙的同一件事。关系层仍然只带 user 一条（通话是两个人的事）。
- **纪要三落**：`recordCallOutcome(convId, contactId, summary, promises, now, tier)`
  除 conv-state 承诺外，加写 `memory_facts` 一条（importance 3、evidenceMsgIds 空——
  通话轮次不落消息本无 msgId 可引；sensitivity 按通话 tier 分级，全开档纪要进不了
  群/朋友圈注入白名单）+ 更新 `conv_summaries`（「刚通了电话：…」并入滚动摘要）。
- **先落纪要再 end**：`CallSession.finalize()` 幂等（memo 同一个 promise），
  `end()` 第一件事就是 fire 它——CallPage 卸载路径（返回手势）只调 `end()`，
  此前纪要整个丢失；挂断按钮分支 join 同一个 promise，绝不双写。
  转红：`j1-mind.test.ts`（end() 单独落纪要 / summarize 只跑一次 / memory 只一行）。
