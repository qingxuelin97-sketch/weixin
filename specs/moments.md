# specs/moments.md — 朋友圈

## 为什么这样设计

朋友圈的可信度**几乎全在时间上**。真朋友不会在你发完的瞬间齐刷刷点赞，而是几小时里零零散散
地来，顺序毫无规律，而且大多数人根本不评论。所以本模块把「谁在什么时候反应」（纯函数、种子化、
可单测）与「说了什么」（唯一碰网络的部分）彻底切开——前者决定像不像真的，后者只决定好不好看。

## 验收清单

- [x] 发布：文本 + 选图（0/1/3/4/9），发完立刻回到 feed
- [x] Feed：封面 + 自己头像昵称、动态卡片、1/4/9 三种宫格、赞评块
- [x] 导航栏随滚动由透明渐变为实底（`--nav-alpha` 由真实 scrollTop 驱动，非阈值猜测）
- [x] 用户自己发的动态**也会**被 AI 错峰点赞评论——这才是这个功能的意义
- [x] 评论必须针对帖子内容本身（prompt 里钉入原文），不能是「说得好」这种通用话
- [x] 无条件 SFW
- [ ] 长按点赞菜单的按压动画、下拉刷新（留给打磨阶段）

## 铁律

**朋友圈无条件 SFW**（宪法铁律 6 / `specs/nsfw.md`）——这是**内容**规则：
`assembleSystemPrompt` 的 `nsfwTier` 永远钉 `'off'`，不看全局档位、不看人设
`nsfwPermit`。feed 是共享界面，一条越界的帖子是突兀而非「按需开启」。

但**路由**档位是另一个问题（M-J3 修正）：router 的 `nsfwTier` 声明的是这次请求
**携带**什么——全开许可人设的卡片（core、nsfwStyleSamples）随每条帖子的 system
prompt 出网，声明 'off' 就把它路由到 `defaultProviderId`（大陆用户≈DeepSeek 官方），
这是 M-D2 破口的第四个面。所以三处 `router.complete` 的 tier 一律经
`momentRouteTier(persona)` = `maxTier(global, [persona])` 派生（handlers.ts 先例）；
全开档且无宽松通道时 `makePolicy` 抛错 → 该次发帖/评论静默跳过，宁可不发不降档。
守卫：`tests/unit/j3-model-surface.test.ts`（源码扫描三处 + 派生真值表）。

## 数据

| 表 | 要点 |
|---|---|
| `moments` | `imageRefs` 存**不透明引用**而非 URL，换图不动已存帖子 |
| `moment_likes` | id = `${momentId}:${contactId}`，「一人一赞」由 store 主键保证 |
| `moment_comments` | `replyToCommentId` 支持互回，深度限 2 |

SQLite 里 likes 是复合主键 `(momentId, contactId)`；IndexedDB keyPath 只能单值，
故用合成 id 表达同一个不变量。换驱动时这层对应关系要保住。

## 排期规则（`planReactions`，纯函数）

- 作者永不给自己点赞/评论
- 概率 = 人设 `likeRate`/`commentRate` × 亲密度缩放（affinity 0→0.6x，50→1.0x，100→1.4x）
- 点赞落在发布后 **1min–2h**，评论 **3min–4h**，且**必定晚于本人的赞**（真实顺序如此）
- 每个反应都被推进该人设的 `activeHours`——没人会在凌晨四点给你点赞
- 种子 = `react:${momentId}:${contactId}`：同一条帖子永远吸引同一批人，回填可重放

## 配图槽位

`src/assets/moments/` 是**素材导入槽位**：丢进 PNG/JPG/WebP 即自动启用，不改代码
（`import.meta.glob` 构建期扫描）。目录为空时回落到程序生成的占位渐变，feed 不开天窗。
素材被删后，引用它的旧帖回落到**按文件名哈希选取的稳定占位**——版式不塌、不出现裂图。

占位色写在 `src/data/moments-images.ts`：那是**内容**（同占位头像色），所以放在 `src/data/`
这个颜色检查豁免目录，而不是去放宽豁免规则。

## 已知坑

- **`likesFor`/`commentsFor` 必须返回稳定引用**：store 里按 momentId 建映射，空集合用模块级
  常量。返回新数组 = 无限重渲染 = 生产白屏（见 CLAUDE.md §3.5）。
- **AI 点赞用 `applyLike` 而不是 `toggleLike`**：AI 的反应永远是「加」。曾经的写法是先
  `repo.putLike` 再调 `toggleLike`，结果第二步立刻把刚加的赞又取消了。
- 新增 store 记得 `DB_VERSION` +1（v4 就是为朋友圈加的）。

## M-C2 增补：配图池标签化

`pickImages(seed, count, tags?)`：`tags` 来自 `PersonaVM.imageTags`，按标签过滤
`idb:` 照片池（吃货人设不发健身照）；空标签或过滤后为空 → 回落全池（宁可跑题不可
让人设永远无图）。优先级：运行时媒体库 > 构建期 assets > 渐变占位。同种子同图不变。

**配图只有这一条路径。** M-I3 的聚会事后帖（`handleGroupEvent` 的 aftermath 相位）
曾经写死 `imageRefs: []`——没人从火锅局回来一张照片都不发，那条帖子因此一眼是生成的。
现在它和正常发帖一样走 `pickImages`：张数由 `aftermathImageCount(eventId)` 种子化
（0/1/3，比日常帖更偏向有图），尊重发起人的 `imageTags`，素材池为空时返回空数组
→ 优雅退化成纯文字，不报错。新增任何"AI 发帖"的入口，配图都接这里，不要另写。

## M-I15 增补：朋友圈 v2

### 转发/引用（转发卡片 + 泄漏铁律）

- 数据：`MomentVM.repostOf`（**根**原帖 id，链条永远塌缩到根）+ 快照
  `repostAuthorId` / `repostExcerpt`（原帖删除后卡片仍可渲染）。
- **泄漏铁律**：引用内容只能来自「已入公开 feed 的 moment 行」。唯一构造器
  `src/ai/moment-repost.ts`——`buildRepost` 只接受 `MomentVM` 并自行从
  `source.text` 派生摘录（没有任何参数能注入任意文本）；服务层 `repostMoment`
  只接受 **id** 并从存储重读，伪造的内存对象带不进任何内容。隐藏会话
  （AI↔AI 私信）因此在结构上无法经转发链上屏。转红测试见
  `tests/unit/moments-v2.test.ts`（repost leak rule）。
- 删除联动：deleteContact 级联会抹掉引用了死者的快照
  （`repostExcerpt: '原内容已删除'`），store 内存镜像 1:1 同步。
- **悬空的「回复 X」**（M-I18）：回复目标可能先没（用户删自己的评论，或级联删掉了
  死者的评论）。旧代码用 `?? c.authorId` 兜底，渲染成「我 回复 我：…」——微信不会
  写出这句话。现在 `replyTargetAuthor()` 找不到目标就返回 undefined，卡片退化成
  普通评论（微信本身的行为）。修在**渲染侧**而不是级联侧，因为「用户删自己评论」
  这条路径级联根本碰不到。
- 入口：卡片胶囊「转发」（仅他人的帖）→ `/moments/repost/:momentId`。
- **AI 也会转发你**：`planRepost`（种子化，~8%，仅 `authorId==='self'` 的帖、
  affinity ≥ 55 的密友，30min–6.5h 后落地）→ 新 kind `moment_repost`（已入
  `SCHEDULED_ACTION_KINDS` + `registerHandler`，无第二计时器）→
  `runMomentRepost` 经同一 `repostMoment` 存储重读路径发布，配文
  `generateRepostText`（失败=无配文，不丢行为）。AI 的转发帖不会再被转发
  （planner 只认用户帖），不成环。

### 话题标签

- 解析器 `src/lib/topics.ts`：`#…#`（1–12 字符），未配对 `#` 与空白标签不算；
  `topicSegments` 对正文**无损**切分供渲染高亮。
- 聚合页 `/moments/topic/:tag`：`hasTopic` 严格匹配（提到词 ≠ 参与话题），
  扫描最近一页（200 条）。
- AI 发帖带标签：`maybeTopicTag`（moments-engine，种子门控 ~18%）；目标期帖子
  抽本 domain 的 `TOPIC_POOLS`，日常帖抽 `GENERIC_TOPICS`——话题页因此能攒出
  真正的系列。

### 连续剧式发帖（接 I14 goals）

`goalSeriesLine(goalStateAt(...))`：goal 素材帖从第二个里程碑起附加「上一集」
指令（引用上一里程碑文案），purely derived、零存储。只在 `goalMomentMaterial`
非空时追加——feed 不许变成进度日志。

### 封面 / 访客感 / 赞评通知（I6 遗留）

- 封面：settings KV `momentsCoverRef`（`idb:` ref），点击封面从照片库选，
  可恢复默认渐变。
- 访客：`recentVisitor`（moments-visitors.ts）按小时桶种子化，~28% 桶有访客、
  45min TTL，纯函数（铁律 4）。
- 通知：moment_like/moment_comment/moment_repost 的 pending 行经 notify-service 上锁屏，
  **只限用户自己帖子**（调用方用存储行构建 allowlist 传入）。分级：点赞正文是
  「行为本身」→ 新档 `reaction` 可预生成预览（转发同理「转发了你的朋友圈」）；评论文本 fire 时才生成 → 保持
  `followup` 无预览。红点：`momentsSeenAt` 水位 + `collectMomentsNews` 纯函数
  派生（点赞/评论/转发三类都算），Discover 行显示最新 actor 头像 + 红点 +「有新消息」。
- 个人相册页 `/moments/album/:contactId`：`repo.getMomentsByAuthor`（全扫描，
  点按级频率不配 index），MomentCard 复用，交互走 store 保持 feed 一致。

### 表情包 v2

- 媒体库新 kind `'sticker'`（行内字段，**无需迁移**）；素材库页第三个分段。
- composer 表情面板「我的表情」区：点击即发 `type:'sticker'` +
  `content:'idb:<id>'`；MessageBubble 对 `idb:` ref 渲染 110px 图（材质化前
  渐变占位）；render-msg 投影为 `[表情]`——内部 id 永不进模型上下文。
- AI 收藏：`sticker-taste.ts`——`stickerSent` KV 记录你**发过**的表情（上限
  30），每个 agent 按 (agent, ref) 种子收藏 ~55%；引擎在模型自己决定发表情的
  回合按 ~30% 种子率把词表 glyph 换成收藏的自定义表情。
- 斗图：`sticker-battle.ts`（voice-send 式门控）——单聊发表情后按
  `${convId}:${msgId}` 种子掷骰：连发 2–4 条时概率峰值 0.65、长战衰减；命中
  则 0.8–2.5s 后**零 LLM** 回一张（优先她收藏的、永不复读你刚发的）；未命中
  走正常引擎回复。
  **那 0.8–2.5s 走 `scheduled_actions`（M-I18）**：新 kind `sticker_reply`
  （已入 `SCHEDULED_ACTION_KINDS` + `registerHandler`，并进 `FAST_KINDS`——
  它是零成本的即时反应，排在回填的 LLM 批次后面会把唯一一个「秒回」变成
  两分钟后的冷笑话）。原先是 ChatPage 里一个裸 `setTimeout`：这是**产生真实
  消息**的第二条时间推进路径（违反铁律 5），窗口内退出会话就把这一回合吃掉，
  而 `stickerStreak` 已经把它算进连击了。决策与随机仍在发送时一次算完，
  排期行只搬运结论——所以 handler 不需要 rng、不需要人格、不需要 prompt。

### 已知坑（v2 新增）

- 转发链只塌缩不递归：`buildRepost` 读 source 的快照字段而非追链查库。
- `toNotifiable` 不带 `selfMomentIds` 时 moment_* 一律静默——旧调用方行为不变。
- **通知要带落点**（M-I18）：`toNotifiable` 早就为「只通知你自己的帖」读了
  `momentId`，然后把它丢掉，而 `ScheduledNotification` 根本没有目的地字段——
  于是「XX 赞了你的朋友圈」点进去只是打开 App，用户还得自己在 feed 里翻。
  现在 moment_* 带 `aiwx://moments?at=<momentId>`、heartbeat 带
  `aiwx://chat/<convId>`，随 `extra.route` 下发；点击回来经
  `onNotificationTap` → **同一个** `parseDeepLink` 白名单（通知 payload 不比
  任何别的 intent 更可信），`/moments` 已入白名单。落地端
  `MomentsPage` 读 `?at=`，必要时把 `shown` 涨到目标下标、滚到居中、
  `.moment-anchor-flash` 闪一下（复用聊天页 `msg-anchor-flash` 那套；
  `backwards` 不是 `both`——卡片包装器留残余样式就是 I8 那个把全屏图片查看器
  缩成 390px 的包含块陷阱）。
- 自定义表情是 `idb:` ref，**收藏/斗图池要过 `startsWith('idb:')`**，词表
  label 混进池子会被当 ref 渲染成裂图。

## M-J3 增补：生成配图与 AI 换头像

### 配图生成（素材池优先，生成兜底）

「配图只有一条路径」的规则不变，路径内部多了一级：`generateMomentPost` 在
`imgCount > 0` 且 `hasPoolMaterial(imageTags)` 为**假**（素材库无真图可用、只剩
占位渐变）时，经 `generateToLibrary`（src/ai/gen-media.ts，动态 import
src/llm/image.ts）生成**最多 1 张**配图（成本考虑），prompt = 帖子正文 + 人设
`imageTags` 风格词。任何失败/未配置回落 `pickImages` 老路径——退化后与 M-J3 前
逐字节相同，零报错上屏。生成图落媒体库 `kind:'generated'`，**不进随机照片池**
（生成的饼干后来变成随机晚霞=穿帮）、进备份、素材库页第四分段可管理。

### AI 换头像（挂 moment_post 尾部，无新 kind）

`runMomentPost` 尾部 → `maybeAvatarSwap`：种子门控 `AVATAR_SWAP_RATE`（3%，
`shouldSwapAvatar(contactId, stamp)` 纯函数），命中且生成可用时生成 512 头像
（落库 `kind:'avatar'`——hydration 只对 avatar 急性材质化、LRU 也豁免它，存成
别的 kind 冷启后头像会退回占位色）、`updateContact` 改 `avatarRef`、再发一条
「换了个头像」朋友圈（imageRefs=[新头像]，照常吸引赞评）。不加新 action kind：
它搭发帖的便车，离线回填经同一条 `moment_post` 物化路径自然覆盖。
守卫：`tests/unit/image-gen.test.ts`（门控确定性 + 行为 + 接线扫描）。

## M-I18 增补：可见范围（公开 / 私密 / 部分可见 / 不给谁看）

I6 把它列为「预列裁减位」并砍掉，M-I18 补上。微信的四档语义原样照搬。

### 数据

`MomentVM.visibility?: { mode, ids }`（`src/data/types.ts`），schema 侧是
`moments.visibility_json`——**JSON 列演进，两个驱动都存整行 JSON，不需要
`DB_VERSION` +1**（没有新 store）。**缺失 = 公开**：M-I18 之前的所有行、以及
AI 发的每一条帖子都是这个状态，所以旧库零迁移。

`ids` 只对 include/exclude 有意义，另两档存空数组——一列一个形状，解析侧不用
分支。写入前一律过 `normalizeVisibility()`：
- 空白名单 = **私密**，不是公开（"分享给谁"清空了不能反手公开发出去）；
- 空黑名单 = 公开（塌缩成缺失态）；
- 名单去重、剔掉 `self`（作者不是自己受众的成员）。

### 过滤做在数据层，不在 UI

规则函数在 `src/lib/moment-visibility.ts`，**调用点全在 lib/db/ai**：

| 位置 | 作用 |
|---|---|
| `IdbRepo.getMoments` / `SqliteRepo.getMoments` | 出库即过滤，`viewer` 默认 `'self'` |
| `getMomentsByAuthor(authorId, viewer?)` | 个人相册页同一条路 |
| `planReactions` / `planRepost` | **排期前**就把看不见的人剔掉 |
| `runMomentLike/Comment/Repost` | fire 时**再查一次**（同 `canForwardFrom` 的两次查） |
| `simulate()` | `recentMoments` 带 `visibility` 进来，离线回填同样尊重 |

仿 `search()` 内部过滤隐藏会话的先例：**UI 忘传也漏不出去**。
`tests/unit/moment-visibility.test.ts` 有一条源码扫描守卫断言
`src/features/**` 里**不出现** `canSeeMoment` / `visibleMoments`——规则一旦搬进
组件，下一个新增的读取路径就会静默泄漏。

两个 planner 因此改成收**整行** `PlannablePost`（不再是
`(id, authorId, postedAt)` 三元组）：可见范围必须跟着帖子走，而第四个位置参数
是会被忘掉的东西。

### AI 侧（本条最重要的一点）

**她看不到的帖，她不会赞、不会评、不会转。** 不可见的人在掷骰之前就被剔除，
所以是"零条排期"而不是"排了再拦"——重放/回填也一致。转发更严：**任何非公开的
帖一律不可转**（不只是查这个转发者），因为转发是把你的话搬到别人墙上，面对的是
你从没选过的受众，且收不回来。

漂移/亲密度等其它调节量都在可见范围之后才生效，顺序不能反。

### 用户可见面

- 发布页「谁可以看」行：ActionSheet 选档 → 两个名单档进 `Sheet` 联系人多选
  （复用 I0 组件，没有新浮层）。候选人来自 **contacts**（`audienceCandidates`，
  只留 `type === 'ai'`），**永远不是 conversations**——用会话行拼人选器正是隐藏
  AI↔AI 私信泄漏到用户面的经典路径。
- Feed / 相册卡片：自己的非公开帖在时间戳旁显示「私密 / 部分可见 / 不给谁看」灰标。
  没有这个标，"到底存成私密了没有"在 App 里无处可查。
- 赞评通知、搜索命中、年度报告都读同一批出库行，天然继承。

### 删联系人

`deleteContactCascade` 逐条手术：把死者从每个名单里摘掉，**不删整行**——那行里
还有活人。白名单被摘空 → 退化成**私密**，不是公开。

### 转红测试（`tests/unit/moment-visibility.test.ts`）

- 不可见帖对该联系人的赞评规划为零；公开帖行为与 M-I18 前逐字节相同
- 过滤在**驱动层**（IdbRepo + SqliteRepo 双跑，viewer 换人结果就换）
- `visibleMoments` 只减不增（防止有人把过滤器改成取数器 = 泄漏）
- 未知 mode **fail closed**
- 人选器只出 AI 联系人；隐藏会话结构上进不来
- 级联手术后活人仍在名单里；空白名单变私密不变公开

## M-J12 增补：单条详情页

`/moments/:momentId`（App.tsx 路由表尾部；静态兄弟 `/moments/publish` 等按
React Router 段排名优先，参数路由只接 id）。

- **入口**：feed 点正文（`MomentCard.onTextTap`，#话题# 段 stopPropagation
  仍优先进话题页）；全局搜索朋友圈命中直落详情（带正确 id，e2e 转红）；
  未来的通知/深链同 URL。
- **数据**：feed store 只有最新一页，本页从 Repo 直读单帖 + 自己的社交行切片
  （相册页的既有纪律）；赞/评论/删除操作走 store，操作后 reload 本地切片。
- **可见范围在驱动层**：`repo.getMoment(id, viewer='self')` 自 M-J12 起在
  IdbRepo/SqliteRepo 内部过 `visibleMoments`——查无此帖与不给你看同为
  undefined。守卫测试禁止 feature 组件调用 `canSeeMoment`/`visibleMoments`，
  详情页因此**不自带**检查。
- **优雅空态**：不存在的 id（删帖、伪造 URL、过期深链）渲染「这条动态不存在了」，
  绝不白屏（moment-detail-e2e.spec.ts 转红）。
- **就地操作**：赞/取消、评论（含回复某人）、删自己的评论、转发、删自己的帖
  （删完返回上一页）；评论输入复用 feed 的内联 composer，评论全量展开。
- 路由台账：golden `moment-detail`（pendingCast，PNG 由 CI 铸）+ smoke 用种子
  `mo_seed_lin`；截图接进 pages.spec.ts。
