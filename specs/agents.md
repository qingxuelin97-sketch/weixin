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

## M-D2 记忆闭环（2026-08）

自 M2 起 `extractMemory` 零调用方——聊天从不产生记忆。现闭环：

- **触发**：离开聊天页且自上次抽取新增 ≥6 条文本消息 → 排 `mem_extract`
  （2min 后火，稳定 id=`mem_<conv>_<frontier>`+`actionExists` 防重发，走唯一时间路径）。
- **一次调用三件事**（role:'memory' 廉价路由）：抽事实（source:'chat'
  confidence:0.9，证据闸门不变）+ 会话滚动摘要（写 conv_summaries 表，
  engine 注入「上次你们聊到：…」替换原 settings 死读）+ `maintainMemory`
  归档（importance≤2 且 30 天未引用 → archived，pinned 豁免）。
- **流转**：注入进成功回复的事实 `touchFacts`（refCount++/lastRefAt，
  首次引用 pending→confirmed）；八卦入库 source:'hearsay' confidence:0.4。
- **成本**：每会话每静默期 ≤1 次，估 +3~6 次/天；marker 无论有无产出都前移。
- MemoryPage 显示来源标签（聊出来的/八卦）、低置信提示、引用次数。

---

## M-E 轮新增模块（2026-08）

| 模块 | 文件 | 一句话 |
|---|---|---|
| 投影层 | `ai/render-msg.ts` | 模型看见的消息文本的**唯一**来源。红包/转账/图片/语音不再是 `[rp]` 这类占位符。 |
| 实体图谱 | `ai/entity-graph.ts` | trigram + BM25 话题检索、Ebbinghaus 遗忘曲线（用得越多越牢）、矛盾 supersede。纯函数。 |
| 情绪脉冲 | `lib/affect.ts` | 事件驱动，叠加在当日心情上，数小时衰减。复用 mood 的 `cpmMul`/`proactMul`。**`simulate()` 不读**。 |
| 生活线 | `ai/lifeline.ts` | 每人两条并行的慢线 + 日程。种子化纯函数，零 LLM、零存储、可重放。 |
| 伏笔 | `ai/threads.ts` | 「上次你说要去看牙，去了吗」。零增量 LLM，搭心跳的车。 |
| 有向立场 | `ai/relationship.ts` | `stance:<a>:<b>` settings 行；`pairKey` 保持对称不动。 |
| 对话状态 | `ai/conv-state.ts` | 话题栈 / 未答问题 / 承诺。**双通道**：启发式每轮即时更新 + 记忆通道后修。 |
| 剧情模式 | `ai/story-*.ts` | GM 走图、expr/llm 双轨触发、回档级联撤销。 |
| 用量 | `lib/usage.ts` | 按来源计每日调用次数。故意是**计数不是账单**。 |
| handler | `ai/handlers.ts` | 11 个 handler 的纯函数版 + 窄依赖包。 |

### 这一轮定下的规矩

- **调用点不得自报 nsfw tier**——一律由 `lib/nsfw-tier.ts` 从会话派生。见 `specs/nsfw.md`。
- **自续链的 kind 一律先续链后干活**（`registerChainedHandler`）。一次抛错不能永久终结一条链。
- **新 handler 必须是 `ai/handlers.ts` 的导出纯函数**——闭包里的 handler 不可测。
- **新状态一律 settings 行**，不动 `DB_VERSION`（v6 已含 story 两表与 `byFireAt` 索引）。
- **prompt 六段层序一字不动**，新内容只追加在 scene 之后（前缀缓存）。
- 尾层每多一句就稀释一分人设：立场/生活线/对话状态在没话说时**一律输出空串**。

## M-I3 · 社交织体

四个新 kind，全部登记真源 + handler（wiring 测试自动看守）：

- **joint_plan**：AI↔AI 私信完成后种子化孵化（`maybeJointPlan`，纯函数），20-44h
  后物化为两条互相咬合、两种声线的朋友圈。成本闸 `JOINT_PLAN_LLM_CALLS = 1`
  （一次调用写两侧），单测锁死。
- **agent_forward**：AI 把**用户可见会话**里的话原文带进群（模板包引号，零生成）。
  铁律：隐藏私信内容永不原文外传——`canForwardFrom` 排期时查一次、fire 时再查
  一次（屏幕上的东西收不回来）；发起人已退群则静默。
- **group_event**：聚会三段弧 propose→rsvp→aftermath，`registerChainedHandler`
  （先续链后干活）。每相位 ≤1 次 LLM 调用；RSVP 是一次派发调用写出全部接话
  （名字白名单、每人一条、上限 `RSVP_MAX`）。前台 pass 每群每周种子化掷骰 +
  stable id + `actionExists` 守卫（enqueue 按 id upsert 的坑）。
- **agent_invite**：有两个共同 AI 好友、且三人没有共同群时，每周种子化低概率
  在 1:1 里提议拉群；建议名单进 `meta.suggestGroup`。建群永远是用户的动作，
  AI 只提议。

孵化点：joint_plan/agent_forward 挂在 `handleAgentDm` 成功之后（stable id 上插，
重放不复制）；group_event/agent_invite 由前台 pass 播种。规划模块
（social-plans/agent-forward/group-events/agent-invite）全部禁 Date.now/
Math.random（铁律 4，源码级测试**逐个文件列名**看守）。

### M-I3 补齐（拉群提议闭环 / 聚会照片 / 有界三人）

I3 首版留下三条"写了没接线"，现补：

- **拉群提议是可操作的，不是死信**。`meta.suggestGroup` 之前只有写入方。现在：
  `parseSuggestGroup`（纯函数，坏数据一律退化成普通文本气泡）→ MessageBubble
  的「邀请你加入群聊」卡（双侧白底，同 I13 名片/链接卡的那套规则）→ 点击
  `suggestGroupHref` 进 `/group-new?preset=a,b,c`，名单**预先勾好**、可改、
  可直接返回。**建群仍然只发生在用户点「完成」那一刻**。
  投影（`render-msg`）追加 `[附了一张拉群邀请卡片，等用户决定]`——模型要知道
  有个提议悬着，但**永远看不到 contactId**（名字本来就在正文里）。
- **她还会把人介绍给你**：提议之后隔几秒（种子化）跟上两张 `contact_card`。
  这是 I13 名片类型的**第一个非模型产出的生产消费者**；卡片形状由
  `bubble-materialize.contactCardPayload` 唯一提供，避免两份不一致的名片。
- **建群只有一条路径**：`group-build.presetState()` 把"这些人已经存在"变成
  一个所有成员预标 `made` 的 BuildState，`buildGroup` 因此零人设卡、零调用。
  发起群聊页（M-D3 手选）与拉群提议卡都走它——那一页原本自己拼装
  conversation 行，是第二份建群实现。
- **有界三人私信**：`DmPlan.c?` + `participantsOf()`（唯一的"取名单"入口，
  去重且截断到 `MAX_DM_PARTICIPANTS = 3`）。`planNextDm` 以 `TRIO_CHANCE`
  种子化把配对升级成三人，第三人**必须来自同一个群**，且排期的醒着时段走查
  三人全覆盖。成本闸 `DM_LLM_CALLS_PER_SESSION = 1`：三人**仍是一次导演式
  分派调用**写出全部台词（同 RSVP 轮），单测锁死。会话 id `dm_<sorted ids>`
  —— 三人局和其中的两人局是**不同**会话，不会互相 upsert。
  隐藏性不变：`isHidden` 是唯一那道墙，搜索/转发/年度报告/小组件/通知五个面
  都按它过滤（三人局的多面泄漏测试见 `tests/unit/social-fabric.test.ts`）。

## M-I13~I17 · 智能体新增能力（并行波交付）

- **目标与长期叙事**（`goals.ts`，I14）：每个 agent 持有跨周目标（考证/攒钱/减肥/换工作…），
  `goalStateAt(contactId, t, epoch)` 是**纯函数**——里程碑与挫折由种子推导，不落库、
  不排队。注入顺序：生活线（arcLine）之后追加 `goalDirective`，仍在 scene 之后（层序不动）。
  终结事件（达成/放弃）经 `goalShareDirective` 变成她**主动跟你说**的一条消息，
  用 `goal_told:<contactId>` 台账保证一辈子只说一次；`goalMomentMaterial` 让进展成为
  朋友圈素材（I15 的连续剧式发帖据此串成系列）。
- **表情接梗**（`game-react.ts`，I13）：你掷骰子/出拳后给她一条指令层，
  **禁止剧透**——石头剪刀布在她自己那手落定前，指令里不含结果；两手齐了才给
  「得意/耍赖」的判定权。过 4 条消息即失效，不复读。
- **气泡物化**（`bubble-materialize.ts`，I13）：新消息类型（位置/名片/文件/链接/游戏）
  从 Bubble 落成消息行的唯一路径，被单聊/群聊轮/群主动**三条播放路径共用**——
  三处各写一遍就是三种不一致。名片按备注/本名解析，解析不到降级为文本。
- **表情包口味**（`sticker-taste.ts` + `sticker-battle.ts`，I15）：你发过的表情进
  `stickerSent` 台账（上限 30），每个 agent 按种子"收藏"其中一部分
  （`collectedStickers`），回消息时 `AGENT_STICKER_SWAP_RATE` 概率改用收藏款——
  这才是"她学会了你的梗"。斗图 `battleReply` 命中时**零 LLM**：直接回一张，
  带 0.8~2.5s 的种子延迟（人在翻表情包），连战有衰减，不复读。
- **通话中的她**（`call-script.ts`，I16）：见 `specs/call.md`。对 agent 层的意义是
  第一次出现「不落聊天记录的对话」——通话轮次只在内存，落库的只有纪要与承诺。

上述模块**全部禁 `Date.now()` / `Math.random()`**（铁律 4，源码级测试看守），
时间由调用方注入、随机由 `seededRng` 提供；因此离线回填与重放里它们表现一致。

## M-I18 · 四条兑现（计划核查后补齐）

- **目标 ↔ 漂移联动回归**：I14 交付过、被合并丢掉。见 `specs/goals-status.md`
  「M-I18 修复」。要点：`getDrift` = 存储层 + 纯函数目标层，行为仍只走
  `driftedPersona → proactMul` 一条通道。
- **群聊读 `conv_summaries`**：写入侧从来覆盖群，读取侧只有 1:1——群摘要被生成、
  被备份、被级联删除，唯独不进 prompt。现由 `memory.withConvSummary()` 一份实现
  供两个引擎共用（层序不动，摘要在记忆层内部、事实之前）。
- **离线窗口补 gift 与 I3 社交 kind**：见 `specs/backfill.md`「M-I18」。
- **世界书近似匹配**：两档语义保持不变，只在「有关键词」那一档下叠 trigram/BM25。
  见 `specs/worldbook.md`。

## M-I18 · 表情使用率联动 persona

I15 的转红清单里写了「表情使用率联动 persona」，但只交付了斗图与表情收藏——
**联动没做**：`battleUrge` 的曲线和 `AGENT_STICKER_SWAP_RATE` 是两个模块常数，
全 App 每个角色共用。结果是「话痨爱斗图的」和「高冷的」发表情的频率一模一样，
而这两个词恰好就是人设卡上写着的东西。

- `PersonaVM.stickerRate`（0..1），走 `makePersona()` 补默认值——宪法点名的陷阱：
  漏了它，`undefined` 会被静默读成「从不发表情」，不报错、只是功能消失。
  schema 侧 `personas.sticker_rate` 默认 0.35。
- **中性点 = 默认值**：`STICKER_RATE_BASELINE = 0.35` 与 `PERSONA_DEFAULTS.stickerRate`
  是同一个常量（写在 `persona-defaults.ts`，两个必须相等的数只写一次）。
  `stickerScale(rate) = min(2, rate / baseline)`，所以未设值的人设行为**逐字节
  等同 M-I18 之前**。
- 三个作用点，全部保持原曲线形状、只缩放：
  1. `battleUrge(streak, rate)` — 斗图。连发仍然是邀请、长战仍然衰减；
     `rate = 0` 各分支直接归零，没有下限漏出去。
  2. `maybeAgentSticker(pool, seed, rate)` — 用你的收藏表情替换词表 glyph 的概率。
  3. `stickerHabitLine(rate)` — 人设层的一行提示词。**只在两端说话**
     （≥0.6 / ≤0.15），中间档一律空串：尾层每多一句就稀释一分人设，而且默认
     人设的 prompt 因此保持逐字节不变（前缀缓存）。前两个管「App 替她发的表情」，
     第三个管「模型自己决定发的表情」——不一起动，高冷人设照样吐 sticker 气泡
     而 App 只是不接话，角色会显得精神分裂而不是高冷。
- 接线：`toPersonaView()`（唯一漏斗，群聊/朋友圈生成器免费继承）、
  `engine.ts` 的贴纸播放点、`ChatPage` 的斗图闸。SillyTavern 卡的
  `extensions.aiwx` 带走它；AI 写卡（`persona-generate`）也会按人设给值。
- 种子人设按卡面文字对齐：陈叔 0.05（卡上就写着"很少用表情"）、Ada 0.15（高冷）、
  小雨 0.5（爱用颜文字）、毛球 0.85（爱玩梗和发表情包）。

### 转红测试（`tests/unit/sticker-v2.test.ts`）

- 两个不同 `stickerRate` 的人设在**同一批种子**下发表情次数有可复现的差异
  （斗图与收藏替换两条闸各测一遍，差值有下界，不是舍入噪声）
- `makePersona` 回填默认值；`undefined`/`NaN`/负数一律读成中性档，**不读成 0**
- `rate = 0` 两条闸都彻底不发
- 默认档的 `battleUrge` 与 M-I18 前的常数一致
- 人设层只在两端出提示词行
