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

**朋友圈无条件 SFW**（宪法铁律 6 / `specs/nsfw.md`）。`generateMomentPost` 与
`generateMomentComment` 永远传 `nsfwTier: 'off'`，不看全局档位、不看人设 `nsfwPermit`。
feed 是共享界面，一条越界的帖子是突兀而非「按需开启」。

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

### 已知坑（v2 新增）

- 转发链只塌缩不递归：`buildRepost` 读 source 的快照字段而非追链查库。
- `toNotifiable` 不带 `selfMomentIds` 时 moment_* 一律静默——旧调用方行为不变。
- 自定义表情是 `idb:` ref，**收藏/斗图池要过 `startsWith('idb:')`**，词表
  label 混进池子会被当 ref 渲染成裂图。
