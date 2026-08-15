# specs/year-report.md — 聊天年度报告（M-I14）

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

- [ ] 各统计项对手工构造的 fixture 逐项断言正确。
- [ ] 隐藏会话（isHidden）对每一项统计零贡献（转红：去掉过滤即红）。
- [ ] 金额输出为整数分；无浮点钱。
- [ ] me 页有「聊天年度报告」入口，路由 `/report` 挂在 src/App.tsx。
