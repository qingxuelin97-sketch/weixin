# specs/search.md — 全局搜索 + 会话内搜索

## 为什么是线性扫描，不是索引

这是**一个人**的聊天记录——几千条消息量级。IndexedDB 没有全文索引，要建一个就意味着
新 store + `DB_VERSION` 迁移 + 每条消息写入路径上的钩子，只为加速一个本来就几毫秒完成的
扫描。`src/ai/memory.ts` 对 V1 是同样立场：关键词，不做向量。

代价明确记下来：**当扫描被实测为慢时再回来重构**，而不是现在为想象中的规模付迁移成本。
届时候选方案是倒排索引 store（写入时增量维护），而非全表扫描加缓存。

## 验收清单

- [x] 会话列表 / 联系人 / 发现 三处的搜索按钮接上（M1 起是无 handler 的死按钮）
- [x] 四类结果分组：联系人 / 聊天 / 聊天记录 / 朋友圈
- [x] 命中词绿色高亮（微信是着色而非加框）
- [x] 长消息按命中位置开窗摘要，命中词不会被截到省略号外
- [x] 结果可点击跳转
- [x] 消息级深链（M-I6）：`/chat/:convId?at=<msgId>`——聊天页向前分页直到目标消息在场，
  滚动居中并闪烁一次（`msg-anchor-flash`）。两个停止条件：翻到历史顶部；已加载的最老
  消息 id 已小于目标（说明消息被删）——都静默落在会话里，不假装跳转成功
- [x] 会话内搜索（M-I6）：`/search?conv=<convId>`，ChatInfoPage「查找聊天记录」入口。
  只出该会话的消息命中；`searchConversation` / `searchConversationAll` 直接复用
  `search()`/`searchAll()` 的评分、摘录与撤回规则

## 设计要点

- **打分**：`KIND_WEIGHT`（联系人 1000 > 聊天 900 > 消息 100 > 朋友圈 80）
  + 覆盖率 + 起始位置加成 + 轻微时间新近度。效果是搜「林小雨」时**人排在提到她的消息之前**，
  这符合直觉：搜一个名字通常是想找这个人，不是想找提到这个名字的句子。
- **备注与本名都可搜，但显示备注**。改过备注的人，用户凭哪个名字都可能想起来；
  显示则应当一致地用他现在看到的那个称呼。
- **时间新近度只做轻微 tiebreaker**（上限 20 分）：一条久远的精确匹配仍应压过一条新鲜的
  部分匹配。

## 铁律

**撤回的消息不进搜索结果**（`search()` 里 `if (m.isRecalled) continue`）。
聊天界面对撤回消息只显示「撤回了一条消息」；如果搜索能把原文捞出来，撤回就等于作废了。
这条有单测钉住（`does not leak the text of a recalled message`）。

**隐藏会话（AI↔AI 私信）的过滤在 search 模块内部，不在 UI 层**——`search()` /
`searchAll()` / `searchConversation` / `searchConversationAll` 四个入口各自拒绝，
调用方忘了预过滤也漏不出去。会话内搜索对隐藏 convId 直接返回空且**一页都不扫**
（单测断言 deps.page 零调用）。

## 已知限制

- 搜索不覆盖：语音转写文本、图片、红包/转账留言。这些的 `content` 为空或非文本。
- 朋友圈结果统一跳 feed 顶部（朋友圈没有单条详情页）。

## 复用

`src/lib/search.ts` 全是纯函数（`findRanges` / `highlightParts` / `excerpt` / `search` /
`groupByKind`），无存储、无时钟，输入由调用方从 store 传入——29 条单测直接打在这一层。

## M-J12 增补

- 朋友圈命中改跳 `/moments/:momentId` 单条详情页（此前落 feed 顶部，命中帖
  在折叠线以下）。id 正确性由 moment-detail-e2e.spec.ts 转红。
- 收藏页有自己的全文过滤（`lib/favorites.filterFavorites`，收藏行是快照，
  不进全局 search() 的语料）；隐藏会话零可见仍由 `repo.getFavorites()` 兜底。
