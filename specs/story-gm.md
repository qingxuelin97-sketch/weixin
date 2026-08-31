# spec: 剧情模式 / GM（V3 完全体已实现，M-I7）

**状态**：引擎 M-E5/G0 交付；V3 完全体（可视化/选角/舞台/任意幕回滚/存档槽/多周目）
M-I7 交付。

## V1 预埋（已全部接线）
- `messages.story_script_id` + `story_seq` 标签列——**M-I7 起有写入方**：
  `story-stamp.ts` 的会话级戳记，beat 播放期间经 `appStore.appendMessage`
  统一打标（旁白/演员台词/用户插话都算这一幕的）。
- `memory_facts.source='story'` + `story_save_id`（回档级联清除，防"记忆穿越"）。
- `story_scripts` / `story_saves` 表（schema 已建）。
- 会话级 Provider 覆盖能力（成人剧情走宽松通道）。

## V3 完全体（M-I7 落地裁决）
- **标签命名空间 = 周目（save id），不是剧本 id**：`storyTag(save.id, seq)`。
  旧的 `scriptId#seq` 让同一剧本的两个周目互删对方的记忆/朋友圈；旧行靠
  `storySaveId` 列兼容（`isFromRunLaterBeat` 双路判定）。
- **回滚三面级联**：记忆 + 朋友圈 + **消息**。消息按快照水位（`msgCursor` =
  移动瞬间会话最新消息 id）裁剪：删除留 rowid 空洞，**绝不改时间戳、绝不重排**
  （rowid 序==时间序是宪法不变量）；cursor=0（I7 前的旧快照）只回状态、不裁消息。
  回滚后 UI 走 `reloadConversation` 强制换页，防止内存尾巴复活已删场景。
- **显式选角**：`story-runs.ts` 的 `suggestBindings`（按 contactId 排序，
  与成员数组顺序无关——数组序绑定是被修掉的 bug）+ `validateBindings`
  （缺角/一人双角/不在群里/幽灵角色）+ `assignRole`（点已上台的人=换角）。
  舞台由用户在 CastingSheet 里选，不再写死 stages[0]。
- **存档槽**：`writeSlot/dropSlot/restoreSlot`，槽=用户命名的完整状态快照
  （独立于有界 history），读档=回滚到槽的 seq；回滚过头的槽失效并被剪掉。
  每周目上限 `MAX_SLOTS=12`。
- **多周目**：save 带 `run`（1 起），`nextRunNumber` 数已结束的周目；
  结局由 `endRun(save, now, endingId)` 记录，`galleryFor` 推导结局画廊
  （未解锁显示 ？？？，不剧透）。手动"结束这一轮"不带 endingId、不解锁。
- **暂停可续**：`resumeRun` 清 stalls/stalledAt 并以时间为 tick 开新链
  （停摆的链没有 pending 后继，不触 enqueue upsert 陷阱）。
- **路由**：`/story`（库）→ `/story/script/:scriptId`（分支图/角色/画廊/周目）
  → `/story/run/:saveId`（走过的路/时间线任意幕回滚/存档槽）。聊天页横幅直达 run 页。
- **SVG 分支图**：`story-layout.ts` 纯几何（BFS 分层、行=到达序、back/self 边
  分类），确定性；颜色全走 token 类（story.css），TSX 内零色值字面量。

## V3 形态（裁决）
分层：主体=独立剧情会话（GM 驻场），世界感=廉价"涟漪钩子"（节点效果写长期记忆 / 触发发朋友圈）。
**不做全 App 世界事件模式**（爆炸半径大）。首发=线性节拍表 + GM 注入，DAG 分支编辑器无限期后置。

## 管线
串行 **GM → 导演 → 演员**，共用全局队列：GM 管剧情走向 + 改写各角色剧情段 prompt（不分配发言权）；
导演照常管谁发言/节奏（输入追加当前节点 goal 摘要）；旁白=灰色系统消息。

## Schema（字段级，V3 落地时按此实现）
```
Script{script_id, title, genre, nsfw_level:0|1|2, cast:[{char_id,role,secret}], vars, entry, nodes:[Node]}
Node{id, goal, directives:[{char_id,instruction,reveal,forbid}],
     triggers:[{when:"expr:vars.x>=3"|"llm:...", to, effects:{vars,mem_write,moment}}],
     timeout:{turns,to}, on_enter:{narrate,scene}}
```
触发双轨：expr 本地求值优先，未命中才让 GM 判 `llm:` 软条件。directives 按角色隔离注入
（绝不给角色整本剧本）。本地校验 DAG 无环 + 全可达。

## 一句话生成剧本（三步链）
大纲（logline+角色秘密+3-6 幕）→ JSON mode 结构化 → 本地校验+自修复≤2 次。成人题材且全开档
→ 整条生成链走宽松通道。

## 存档/回溯
节点跳转自动快照 `{node, vars, 消息游标, 各角色滑窗摘要}`；回档按 `(script_id,seq)` 级联撤销
mem_write 与朋友圈帖，否则角色"记得未来"。

## NSFW
生效档 = min(全局,剧本) 启动时锁定快照；成人节点须挂 vars 门槛 + `sfw_alt` 替代文案，禁 entry 直达。
