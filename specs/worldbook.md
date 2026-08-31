# specs/worldbook.md — 世界书（用户自著设定注入）

M-I4 交付。用户手写的世界观/设定条目，按当轮话题匹配后注入 prompt——
「她住的城市」「你们的学校」这类既不是记忆提取物、也不该塞进人设卡的背景事实。

## 数据

- IDB store `worldbook`（**DB_VERSION 8** 引入，migration 台账已登记，备份收录）。
- 条目：`{ id, title, keywords[], content, scope, priority, enabled }`，
  scope = `global | persona(contactId) | conv(convId)`。
- 上限（`WORLDBOOK_LIMITS`）：title 20 / content 200 / keywords 8×16 字，写入即 clamp。

## 注入

- `worldLinesFor({ query, contactId, convId, tier })` → 行数组，交给
  `assembleSystemPrompt` 的 `memory.world`——**渲染在记忆层（# 你记得的事）内部**。
  六层宪法层序不动：世界书是"她知道的事"，不是第七层。
- **两档模型（有意设计，别合并）**：
  - **关键词留空 = 常驻**：scope 内一直生效。这是用户的逃生口——匹配不听话时，
    清空关键词是一个不用读文档就能按下的开关。常驻档不参与打分、不做近似。
  - **有关键词 = 触发**：先精确子串命中（原样保留）；M-I18 起在这一档**下面**
    叠一层**近似档**，复用 `entity-graph.ts` 的 trigram + BM25（`WORLDBOOK_FUZZY_MIN`
    做闸、BM25 做排序、`WORLDBOOK_FUZZY_MAX = 2` 封顶）。
- 近似档的分词是 `trigrams()` **加 CJK 单字**——这是「条目写年糕、聊天说你家猫」
  能连上的唯一通路（两边共有的只有「猫」这一个字）。单字只在 worldbook 这一档加：
  记忆检索跑在几十条事实上，单字是噪音；世界书只有十几条，单字才是信号。
  高频虚字走 `STOP_CHARS` 停用表，因为三条条目的语料里 IDF 压不住它们。
- **近似命中永远排在所有精确/常驻命中之后**，且照样过 5 条/600 字的总闸——
  最松的那一档最多给 prompt 加两行，且只在没人要那个位置时。
- 预算双封顶：`WORLDBOOK_MAX_ENTRIES = 5` 条 + `WORLDBOOK_CHAR_BUDGET = 600` 字；
  超字数的条目跳过去试更短的，不截断内容（截断的设定=错误的设定）。
- tier 参与匹配调用（铁律 6 沿用）：世界书内容与其他上下文同一 tier 推导，
  全开档上下文不流向国内官方端点。

## SillyTavern 互通

`character_book` 双向映射（导入不再丢卡里的 lorebook；导出带走）。
scope 映射：ST 卡内条目 → persona scope，绑到该卡的 contactId。

## UI

- 设置 → 世界书：全局与按会话条目的列表/编辑（I0 组件）。
- 人设页分区「她的世界书」（M-I18 补齐）：只列 `scope='persona' && scopeId=该角色`
  的条目，就地增删改。此前只能去全局列表里靠「· 角色 XX」后缀用肉眼认领属。
  两个页面共用 `features/settings/worldbook-edit.ts` 的对话框——四个字段四条 clamp
  规则，抄两份必然走形。

## 转红测试

- 注入永不超 5 条 / 600 字（构造超额 fixture 断言被裁）
- disabled 条目零注入；关键词一档无命中、且近似也不过闸时零注入
- 近似档：「你家猫」命中写「年糕」的条目；「今天买菜」「嗯」这类无关句仍零注入
- 近似档同样受 scope / tier 墙约束（`nsfw-callsite.test.ts` call site 5）
- migration 台账：worldbook store 版本=8（`idb-migration.test.ts` 守卫）
