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

## M-J6 · 通话大版本

### 体验修复（J6a）

- **barge-in**：`CallSession.holdFloor()`——abort 生成 + 停 TTS + speaking=false，但**不
  end**。`onTalkDown` 第一行就调（按下即闭嘴，不等录音结束和 ASR 往返）。
- **句间预取**：`respond()` 拿到全部台词后，第 2 句起 `tts.ensure()` fire-and-forget
  预热，第一句还在播时后续句已在合成——消灭句间静默。
- **静音**：`setMuted(true)` 立即停播；后续台词只走字幕节拍不进 TTS；可恢复。
- **最小化**：会话所有权从 CallPage 的 effect 迁到 `call-host.ts` 模块单例
  （`adoptCall`/`getActiveCall`/`hangupActiveCall`/`setCallMuted`，immutable 快照 +
  `useSyncExternalStore`）。切走不断线；壳里挂 `MiniCallPill`（绿胶囊：波纹 + mm:ss +
  挂断）。挂断唯一路径：页面按钮和胶囊按钮走同一个 `hangupActiveCall`，通话记录 +
  纪要 stamp 只写一次。恢复路径：`?in=1` + `getActiveCall()?.convId === convId` → 直接
  active，不重铃不重拨。
- **诚实不做**（需原生 AudioManager/逐句 emotion 链，未装假开关）：听筒/免提切换、
  通话 TTS emotion。

### 视频通话（J6b）

- **入口名实相符**：聊天页「视频通话」格 → ActionSheet 真二选一（视频通话/语音通话），
  视频走 `/call/:id?video=1`。
- **video 旗全链路**：CallPage 入参或恢复时读 host 旗 → `adoptCall({video})` → 快照 →
  挂断/未接记录 `meta.video: true`（语音记录**不带**该键）→ 投影「[视频通话 …]」/
  「[对方打来视频通话，未接通]」→ 气泡换摄像机图标（文案仍「通话时长 mm:ss」，
  真微信靠图标区分）→ 胶囊返回 URL 带 `&video=1`。
- **她的画面是诚实的假**（`VideoStage.tsx`）：头像全屏 Ken Burns 慢漂 + 呼吸缩放 +
  说话辉光（`--color-call-speaking-glow`）+ 暗角/噪点「暗房手机摄像头」质感层。
  全部 CSS transform/opacity 动画，**禁 rAF**（截图门禁只能冻结 CSS/WAAPI）。
- **你的画面是真的**：`SelfCam` getUserMedia 前置镜头 PiP；失败/拒权降级为安静的
  「摄像头不可用」占位卡，绝不报错——通话本体不依赖摄像头。清理必
  `getTracks().stop()`（镜头灯不能常亮）。manifest 声明 CAMERA（不声明 = WebView
  权限请求被系统静默拒绝）。
- 转红：`tests/unit/j6-call.test.ts`（16 条：holdFloor 不终结会话 / 预取时序 / 静音零
  play / 单例收养与唯一挂断 / video 旗三级断言 / 接线扫描）。

### 群语音通话（J6c）

- **成本闸是结构**：每轮（开场/你说一句）恰好 **1 次 LLM 生成**。「导演」是零成本
  纯函数 `pickCallSpeaker`（seededRng 加权轮盘：proactivity 抬权、刚说过的 ×0.35、
  被点名 ×25 几乎必接）——通话对延迟敏感，一次导演 LLM 往返就出戏。
  转红：`j6-group-call.test.ts` 断言 opener 1 次、userSaid 再 1 次。
- **每个人还是自己**（M-J1 纪律）：发言者 system 走 `buildCallSystem`（记忆/心情/
  目标/纪念日全在，整通电话内按人缓存），殿后场景块换 `groupCallScene`（群名 +
  在线名单 + 「某某：」前缀规则 + 别替别人说话）。接通前群聊近况经
  `renderTranscript(nameOf)` 带名注入。
- **铁律 6 分人**：tier 逐发言者 `effectiveTier` 推导落在 generate 调用上（转红：
  permit=false 成员在 full 全局下仍以 off 发言）；全场最严 tier（`strictestTier`）
  给入站 ASR 闸与纪要调用；全开档成员在场 → voiceOn 熄灭全程字幕。
- **UI**（`GroupCallPage.tsx`，路由 `/group-call/:convId`，群里的通话格直通）：
  头像宫格（我 + ≤`GROUP_CALL_MAX_MEMBERS`=6 名成员，缺人设的成员"没接"）+
  说话绿描边（speakingId 经 host 快照）+ 带名字幕 + 与单聊同构的按住说话/打字条。
  仅呼出（无 scheduled kind 就没有群来电——加一种 kind 必须走台账）。
  会话归 call-host（`makeSession` 分支）；胶囊返回走 `/group-call`；挂断同一个
  `hangupActiveCall`，群会话落一条 `type:'call'`。
- **纪要**：`recordGroupCallOutcome`——conv-state 承诺 + conv_summaries「刚开了
  群语音」+ **只给开过口的成员**各记一条 memory（没说话的不凭空长记忆）。
