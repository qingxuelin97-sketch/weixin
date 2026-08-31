# specs/year-report.md — 聊天年度报告（M-I14；多维 + 年份切换 M-J12）

## 目标

`/report`：微信年度报告风格的整屏滚动页，**纯本地统计**，零 LLM、零网络。me 页加入口。

统计口径（`src/lib/report.ts` 的 `computeReport`，纯函数）：

| 项 | 口径 |
|---|---|
| 谁话最多 | 按 senderId 计每个 AI 的消息数，top 5；用户自己单列 |
| 几点最活跃 | 用户自己消息的 24 小时直方图 + 峰值小时 |
| 红包往来 | wallet 台账聚合：rp_out+transfer_out 为「发出」，rp_in+transfer_in 为「收到」，**全程整数分**（铁律 3），页面展示才 `fenToYuan` |
| 最长连聊 | 单会话内相邻消息间隔 ≤5min 视为同一场连聊，取消息数最多的一场（会话、条数、时长、日期） |
| 常用词 | 用户文本消息的 CJK 双字组 + ASCII 词，停用词表过滤，top 10 |
| 彩蛋 | 最晚的一条深夜消息、聊得最多的一天 |
| 朋友圈（J12） | 发帖数按帖子年份；获赞/收到评论按**反应**的年份（挂在自己帖上、作者非 self）；评论 TOP3 |
| 通话（J12） | type:'call' 行：有 `meta.durationMs` = 接通（次数/总时长/最长一通），无 = 未接/拒接/取消 |
| 剧情（J12） | story_saves 里 `endingId && endedAt` 的存档按 endedAt 归年；结局数按 (scriptId, endingId) 去重。**只读**（story-gm 绕 Repo 直连 idb 是已知债，报告不改架构） |
| 表情游戏（J12） | 同会话游戏子序列里相邻两掷（同游戏、一方是 self）成一局：rps 走 `rpsCompare`，骰子比大小；另计自己的掷数与六点数 |

## 年份维度（M-J12）

- `computeReport` 接 `input.year`（缺省 = now 的年份），**每一项**统计都按
  `yearRange(year)` 本地时间窗过滤——往年数据只入对应年（转红测试）。
- `/report?year=2025` 选年；页面切换 chips 由 `yearsWithData` 列出
  「数据出现过的年份」（消息/流水/自己的帖/剧情结局；隐藏会话不参与枚举）。
- 取数走 `scanAllMessages`：逐会话游标分页拉全，**上限 20k/会话**
  （`REPORT_SCAN_CAP`）。命中上限记 `cappedAt`（最老已读时间戳）；
  `scanTruncatedForYear` 判断所选年是否不完整——**不许静默**，页顶常驻
  「统计已截断」横幅。短页 = 历史见底 = 完整，哪怕总数正好跨过上限也不亮牌
  （顺序写反即转红）。
- 长图导出：`lib/report-image.ts` —— `reportImageLines`（纯函数，画面内容，
  单测锁）+ `renderReportImage`（Canvas 390 宽 ×2 倍采样）。调色板由页面
  运行时 `getComputedStyle` 从 `--color-report-*` token 解析后注入，模块内
  零色值字面量；导出走 `saveBlobFile`（原生 = Filesystem base64 + Share，
  与 .aiwx 的 saveTextFile 同先例；Web = anchor 下载）。

## 铁律遵守

- **隐藏会话零统计**（穿帮不可逆）：`computeReport` **内部**按 `conv.isHidden` 过滤——
  与 `search()` 同款「过滤做在数据层」纪律；页面侧再滤一次只是纵深防御。
  有转红测试：塞一条带独特发送者/独特词的隐藏会话，断言产出与「只有可见会话」逐位相等。
- **金额整数分**（铁律 3）：`computeReport` 输出 fen，浮点只出现在展示层格式化。
- **颜色只走 token**（铁律 1）：报告页深色底/金色强调是新增语义 token
  （tokens.css 的 `--color-report-*`），组件 CSS 零字面量。
- **动画 CSS-only**：入场动画 = IntersectionObserver 加 class + CSS transition/keyframes，
  禁 rAF；整页 scroll-snap 分屏。
- **不冻结业务时钟**：`now` 由页面注入 `computeReport`，组件用真实时钟。

## 验收清单

- [x] 各统计项对手工构造的 fixture 逐项断言正确。
- [x] 隐藏会话（isHidden）对每一项统计零贡献（转红：去掉过滤即红；
      report.test.ts 的 deep-equal 自动覆盖后加的新维度）。
- [x] 金额输出为整数分；无浮点钱。
- [x] me 页有「聊天年度报告」入口，路由 `/report` 挂在 src/App.tsx。
- [x] 年份隔离：往年数据只入对应年（j12-report.test.ts 转红）。
- [x] 截断条件：上限打断且所选年未扫完 → 亮牌；扫完整（含短页跨上限）不误报。
- [x] 长图内容含年份/总量/金额格式化，零数据维度不画（reportImageLines 单测）。
