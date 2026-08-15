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
- 匹配 = 关键词精确命中 + trigram 打分（复用 memory 的检索基建），按 priority + 分数排序。
- 预算双封顶：`WORLDBOOK_MAX_ENTRIES = 5` 条 + `WORLDBOOK_CHAR_BUDGET = 600` 字；
  超字数的条目跳过去试更短的，不截断内容（截断的设定=错误的设定）。
- tier 参与匹配调用（铁律 6 沿用）：世界书内容与其他上下文同一 tier 推导，
  全开档上下文不流向国内官方端点。

## SillyTavern 互通

`character_book` 双向映射（导入不再丢卡里的 lorebook；导出带走）。
scope 映射：ST 卡内条目 → persona scope，绑到该卡的 contactId。

## UI

- 设置 → 世界书：全局与按会话条目的列表/编辑（I0 组件）。
- 人设页分区：该角色 scope 的条目就近编辑。

## 转红测试

- 注入永不超 5 条 / 600 字（构造超额 fixture 断言被裁）
- disabled 条目零注入；keywords 无命中时零注入（不做"常驻世界书"——常驻的该写进人设）
- migration 台账：worldbook store 版本=8（`idb-migration.test.ts` 守卫）
