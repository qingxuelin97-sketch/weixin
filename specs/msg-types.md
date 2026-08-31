# 消息类型补全 + 收藏 + 表情游戏（M-I13）

四种富消息卡片（位置/名片/文件/链接）、表情游戏（骰子/猜拳）、收藏。

## 验收清单

- [x] `location` / `contact_card` / `file` / `link` / `game` 五种 `MessageType`
      （schema enum + VM union 同步），MessageBubble 各有专属渲染，
      render-msg 各有投影——**模型永远看不到 `[object]` 或内部 id**。
- [x] `group_bill`（M-J8 群收款/AA）：同一纪律——schema enum + VM union 同步、
      MessageBubble 白卡（发起人/人均/已付未付名单，名字发起时定格）、render-msg
      投影（总额/人均/未付名单，金额公开是 AA 的语义）、previewOf `[群收款]`。
      结算真源在 settings `bill:<convId>`（见 specs/money.md），meta 只是镜像。
- [x] AI 能发：`BubbleSchema` 扩展 `location｜contact｜file｜link｜dice｜rps`，
      `parseBubbles` 修复路径同源（`BUBBLE_TYPES` 唯一列表）；
      prompt 基底告知模型可用类型与 content 写法。
- [x] 单聊/群聊/群主动三条播放路径都经 **同一个** `materializeBubble()`
      （`src/ai/bubble-materialize.ts`）落 meta——两引擎不再各写一份映射。
- [x] 收藏：长按菜单「收藏」→ `favorites` store（DB v9）→ /favorites 页
      （按类型筛选）；me 页入口接活。
- [x] 表情游戏：composer 表情面板可发；AI 可发（dice/rps 气泡）；
      结果进投影（"掷出了骰子，点数是 3 点"），AI 能接梗。
- [x] 收藏二期（M-J12）：/favorites 全文搜索（正文/来源/meta 可读值，
      `lib/favorites.filterFavorites`）；「笔记」= `type:'note'` 的收藏行
      （右上角 + → 编辑 Sheet；长按可编辑，编辑不换 id 不动 favedAt）；
      长按菜单「转发到聊天」复用 `components/ForwardSheet`（自 ChatPage
      抽出的"发送给"选择器），note 以 text 出门、meta 克隆不别名。

## 设计要点

- **卡片是快照**：contact_card 的头像色/字、file 的 sizeBytes、收藏行的
  content/meta 全部在生成时定格。源头改名/删除不回写。
- **种子纪律（铁律 4）**：游戏结果 = `seededRng(gameSeed(convId, createdAt, salt))`，
  发送时掷一次存进 `meta.result`，渲染/投影/回放只读不掷。文件大小同理
  （`fakeFileSize`，同一文件名同一会话同一时刻 → 永远同一大小）。
  引擎里 `at = hooks.now()` 只读一次，种子与 createdAt 是同一个数。
- **名片只对解析得到的名字发卡**：`cardResolver` 用备注/本名匹配，排除
  self 与说话者本人；解析不到 → 降级为纯文本（指向不存在的人的卡=点开 404）。
- **模型不知道自己掷了几点**：prompt 明确"结果由系统决定，同一轮别报点数"；
  结果下一轮经投影可见，接梗发生在下一轮。
- **收藏零泄漏**：隐藏会话过滤在 `repo.getFavorites()` 内部（同 search()），
  UI 忘了也漏不出去。转红测试直接向 store 塞一条隐藏会话行验证。
  M-J12 起转发**目标**列表同纪律：`forwardableConversations` 在 helper 内部
  滤 isHidden（tests/unit/j12-favorites.test.ts 转红），隐藏会话既当不了
  来源也当不了去处。
- **`note` 是收藏专属 kind**（M-J12）：`FavoriteVM.type = MessageType | 'note'`，
  绝不进消息表——转发时映射为 `text`。ChatPage 的收藏闸门 FAVORITABLE 与
  FavoriteBody 渲染器的同口径守卫（i18-contacts-gaps）对 note 显式豁免。
  笔记行 senderId='self'、convId=''，因此删联系人级联永远扫不到它。
- **deleteContact 级联**：收藏行按 senderId 或死亡会话 convId 清除，
  台账 `DELETE_CONTACT_CASCADE.favorites = 'cascade'`（守卫测试盯着）。

## 已知坑

- `{"type":"dice"}` 不带 content 是**正确**输出——`dropNulls` 里补 `content:''`，
  否则 schema 校验失败会被修复成打印"dice"两个字的文本气泡。
- 卡片在自己那侧也要是白底：`.loc-card` 等覆盖 `bubble--self` 的背景和气泡尾。
- 收藏是快照但**不是**备份豁免：favorites 走 STORES 通用导出，天然进 .aiwx。
- 游戏消息 content 为空字符串，凡"按 content 搜索/预览"的路径要走 previewOf
  的 `[动画表情]`，不要读 content。
