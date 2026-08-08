# specs/agents.md — 智能体系统：拟人化 · 主动性 · AI↔AI 私信化学

## 核心设计观

化学反应不是"让 AI 演戏给用户看"，而是让状态**真实存在于库里**——谁认识谁（relations）、
谁知道什么（memory）、谁和谁私下聊过（隐藏 DM 会话）。台词从状态里自然长出来：
B 在群里说「听小雨说你最近在减肥」，是因为那条八卦确实作为 MemoryFactVM 存在于
B 的记忆里，注入走的是**和其他记忆完全相同的管道**（`selectFactsForInjection`）。
没有"演出脚本"这种第二套机制。

## 一、拟人化

### relations 层（接线）

`assembleSystemPrompt` 的 relations 块自 M2 就存在，但 engine/group-engine/seed
**从未传入**——AI 们互不相识，一切"化学"无从谈起。现接线：

- `PersonaVM.relations?: Record<string, string>`，键 = `'user'` 或对方 contactId，
  值 = 关系描述。`makePersona` 默认 `{}`。
- 组装时把 contactId 键**翻译成显示名**再传（prompt 里出现的是「Ada：大学同学」
  而不是「ai_ada：大学同学」——模型不该见到内部 id）。
- 种子设定（可在人设编辑页改）：小雨↔Ada 大学同学；陈叔是众人熟识的长辈；
  毛球是小雨养的猫的"代运营号"（群里的梗担当）。

### 反 AI 腔（BASE_REALISM 硬规则）

追加到基底层（改动 = 改行为，`prompt.test.ts` 断言同步更新）：
- 禁止列表、分点、编号；禁止解释自己为什么这么说；
- 禁止客服式收尾（"还有什么我可以帮你的吗"类）；
- 回复长度跟随语境：对方一句"嗯"，你也不需要三段话；
- 偶发只回一个贴纸/表情（按人设 `stickerTags`）。

### 阅读延迟

`generateAndPlay` 在 `setTyping(true)` 之前插入 seeded 1.5–8s 停顿（`sleep`+signal，
用户再发消息即中断重来）。真人要先看到、想一下，才开始打字。
心跳/回填路径不加（到达时间本就由排期决定）。

### 心情（零存储）

`mood(contactId, dayBucket)` 纯函数：seeded 骰子 → 当日心情枚举（平静/开心/有点烦/
疲惫…）→ 场景层一行。不建 store、不加 LLM 调用、离线回填可精确重放。
刻意不做"事件驱动情绪"——那需要 LLM 抽取，成本与复杂度都不配 V1 的收益。

### 撤回戏

- AI 的先发后撤走 `recall` kind（schema 早已预留）：发出 → 入队 fireAt+1.5s →
  handler 置 `isRecalled`。跨重启可重放，消灭 engine 里的内联计时器（铁律 5）。
- 用户长按自己消息 → 「撤回」（`canRecall`：2 分钟窗口、仅 text/image/voice/sticker
  ——红包转账不可撤，账本还在，"撤回"会自相矛盾）。
- 文本撤回后灰条带「重新编辑」→ 原文回填输入框（撤回是 UPDATE 不清 content，正好复用）。
- AI 撤回后 40% 概率（seeded per msgId）追一句圆场话，口头禅前缀 50% 概率。

## 二、主动性

### 素材化开场白

heartbeat 到期生成前，从三源 seeded 择一注入"由头"指令：
1. **记忆追问**：从对方记忆里挑一条可追问的事实（"面试怎么样了"）；
2. **分享朋友圈**：自己 24h 内发过 moment → "发了个朋友圈你去看看"；
3. **时段问候**：兜底（现有 gap directive 逻辑并入此源）。

主动消息从"打招呼"变成"有事找你"——后者才像真人。

### 未回追问（nudge）

会话末条是 AI 发的、且已过 6 小时未获回复 → 按 `proactivity` 概率排**一次** nudge。
stable id = `nudge_<convId>_<lastMsgId>`：同一条消息**绝不追第二次**——纠缠感是
拟人化的反面。之后安静等用户。

## 三、AI↔AI 私信（八卦扩散，PLAN.md V2 既有条目）

### 数据

DM = 正式 `conversations` 行，id = `dm_<a>_<b>`（a/b 按字典序，保证唯一），
`isHidden: true`。消息复用现有一切（rowid 序、备份自动覆盖、engine 落库路径）。

**铁律：四个泄漏点必须过滤 `isHidden`**——列表（ChatListPage）、未读合计
（ChatListPage `totalUnread`）、Tab 徽标（TabScaffold）、**搜索输入组装**。
搜索泄漏最致命：用户一搜就看到 AI 私聊原文，穿帮且不可逆。有单测钉死。

### 排期与预算

- 新 kind `agent_dm`（`SCHEDULED_ACTION_KINDS`，唯一真源列表）。
- **每日全花名册 ≤2 场**（`DM_PER_DAY`）；双方 `activeHours` 交集内；seeded；
  仅前台排期；**离线回填不生成 DM**（每场都是真 LLM 调用，用户付钱）。
- 排期时随机配对有共同群的两人（有共同群才有外溢出口）。

### 生成（单次调用）

一次 `complete` 产出整场对话，NDJSON 逐行：
```
{"speaker":"a","text":"..."}   × 4–8 行，两人交替
{"gossip":{"about":"user"|contactId,"fact":"≤30字"}}   末行
```
- 话题源：双方记忆 top 事实 ∪ 最近共同群聊窗口 ∪ 最近 moments（seeded 选一）。
- **无条件 SFW**：产物会外溢到群聊这个共享面，同朋友圈铁律（宪法 6）。
- 解析失败 = 本场静默作废，**不落半截对话**。
- 消息行 `createdAt` 用排期 fireAt 起步、行间 30–90s seeded 递增——
  同样受"不得早于会话末条"不变量约束。

### 化学落地

1. gossip **双向**写 `MemoryFactVM`：
   - 说者（a）：`和{B名}聊到：{fact}`，subjectId = a；
   - 听者（b）：`听{A名}说：{fact}`，subjectId = b。
   importance 2、sensitivity normal、status confirmed。之后单聊/群聊 prompt 注入
   自动携带——零新管道。
2. DM 完成后 p=0.5 在两人共同群排一条 `group_msg`，payload 带 `hint`（DM 话题
   ≤20 字）→ `sendGroupProactiveMessage` 透传给 `plan.hint`（director 现成字段）。
3. 关系温度（agents 间动态好感）**刻意不做**：先看静态 relations + 八卦记忆的
   实际效果，避免为想象中的需求建状态。

### 可见性

用户**看不到** DM 本体（微信语义：你本来就看不到别人的私聊）。化学只通过群聊台词、
单聊提及被感知。数据在库、E2E 可查；将来要做「吃瓜查看器」= 一条路由的 UI 增量。

## API 成本一览

| 调用 | 频次上限 |
|---|---|
| agent_dm 对话生成 | ≤2 次/天（全花名册） |
| DM 后群聊引子 | ≤1 次/DM（p=0.5） |
| nudge / 素材化开场白 | 计入原有 heartbeat 调用，不新增 |

## 已知坑

- 隐藏会话消息进搜索 = 直接穿帮（见上，单测钉死）。
- gossip fact 的 `about` 若指向已删除联系人，落库前丢弃。
- DM 会话不参与 nudge / heartbeat 排期（participants 都是 AI，不需要"等用户回"）。
- 撤回的 DM 消息不存在（AI 私聊不演撤回戏——没有观众）。

## 用户可见配置面（M-B 全量化）

- 人设编辑页（/persona/:id）暴露 PersonaVM 全部字段，按 人设/行为/朋友圈/关系/
  模型与语音/NSFW 分组；主动频率与发帖频率用预设档下拉（heartbeatBaseMin、
  momentsPerDay 的字面值仍可通过既有数据保留为"自定义"项）。
- **关系编辑**：user + 每个其他 AI 一行；留空 = 互不认识 = planNextDm 不会配对。
- 记忆管理页（/memory/:id）：待确认（pending → confirmed）/置顶/删除；
  八卦来源（"和X聊到：/听X说："前缀）打「八卦」标签——化学要可读。
- 通讯录先进资料卡（/contact/:id：发消息/语音通话/编辑人设/记忆），再进编辑；
  「＋」走 /contact-new（makePersona 兜底全部行为默认——防 undefined 字段陷阱）。
- 每智能体模型 modelChat 见 specs/llm-provider.md「每智能体模型」。
