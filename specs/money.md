# spec: 红包 / 转账 / 零钱（M3）

**文件**：`src/lib/wallet.ts`（纯规则）、`src/ai/money-service.ts`（编排）、
`src/features/money/*`（UI）、`src/ai/scheduler.ts`（时间驱动）。

## 铁律
- **金额一律整数「分」**，禁止浮点。
- **红包创建时即预拆分**：`splitLuckyPacket(total, count, seed = rpId)`，
  `sum(shares) === total` 恒成立且可重放；领取按顺序消费份额。
- **手气最佳只在领满后裁定**（未领满不显示皇冠），平局取最早——与 `bestLuckIndex` 一致。
- **一人只能领一次**；领完再点返回 null（UI 显示"手慢了"）。
- AI 抢包延迟按人格 `grabSpeed` 种子化（fast 1-8s / mid 5-20s / slow 10-45s），
  同一红包不同人延迟必不同 → 天然错峰，不会齐刷刷。
- 时间驱动一律走 `scheduled_actions`（宪法铁律 5），不另起定时器。

## 零钱账本
`WalletTxVM` 带符号金额 + 冗余 `balanceAfterFen`（明细页直渲，无需累加）。
`currentBalance` = 最新一条的 `balanceAfterFen`。发红包即时扣款，领取即时入账；
转账发出即扣款，对方接收后才计入对方（用户为收款方时才 `transfer_in`）。

## 流程
发红包页（金额/个数/留言）→ 气泡（三态）→ 点击 → 全屏拆包（金币「開」3D 翻转 900ms）
→ 详情页（我领到多少 / 已存入零钱 / 领取列表 / 手气最佳皇冠）。
转账页 → pending 气泡 → 对方点收 or 到期自动接收 → 双方气泡转 accepted。

## 转账 24 小时自动退还（M-I18）
`TransferVM.status` 的 `'returned'` 从 M3 起就在 schema / 类型 / 投影里，**零生产者**——
未收的转账永远停在「请收款」，发出去的钱永远不回来，而 `render-msg` 那条分支比的还是
`'refunded'`（本仓从不写入的字符串），所以连模型都读不到。M-I18 按微信真实行为补上：

- 发送时（**两个方向都**）`enqueue({kind:'transfer_return', fireAt: now + 24h,
  id: 'tr_return_<transferId>'})` —— 铁律 5，没有第二个计时器。用户→AI 那条正常在 4 秒内
  被 `transfer_accept` 结清，这行只是**兜底**：accept 一旦抛错（执行器先标 done 再跑、不重试），
  钱已经出了钱包却再没人放回来。
- `returnTransfer()` 只对 `pending` 生效 → 天然幂等，accept 之后那行排到也什么都不做，
  不必再花一次 pending 全扫去取消它。
- 账本：`fromId === 'self'` 才入账（`transfer_in`，整数分，refId `<id>_ret`）——
  AI 的余额是虚构的（同 `sendRedPacketFrom`），给她记一笔会让用户的余额变成谎话。
- UI：气泡转 `returned`（`已退还` + dim，不再可点），并追加一条系统消息。
- 时间戳取 `max(fireAt, 该会话最后一条消息)`：行是「现在」插入的，倒挂会破坏
  `rowid 序 == 时间序`（CLAUDE.md 3.5）。

## 验收
- [x] 15 个纯函数单测：份额守恒、顺序一致、重复领取拒绝、领完拒绝、皇冠唯一/未满不评/
      平局取最早、抢包延迟确定性与人格窗口、余额推进与收支往返归零。
- [x] E2E：发 8.88 元 4 份到群 → 三个 AI 先后领取（陈叔 slow 未到）→ 零钱 1288→1279.12；
      点开种子红包 → 翻币 → 详情 ¥18 + 皇冠 → 余额 1306.00。
- [x] 转账退还（M-I18）：排期为 `transfer_return` 行且 id 稳定 / 她转你没收 → 状态+气泡+
      系统消息+投影四处一致 / 你转她没收 → 零钱整数分往返归零 / accepted 后再跑退还是空操作 /
      跑两次只退一次 / 回填晚到时系统消息不早于会话最后一条。
- [ ] 真机验：翻币动画手感、拆包页返回不误触、隔夜未收的转账第二天确实变「已退还」。

## 已知坑
- `idb.ts` 的 `DB_VERSION` 每加 store 必须 +1，否则 `onupgradeneeded` 不触发（v2 加钱、v3 加 TTS 缓存）。
- 详情页轮询 1s 刷新领取列表（AI 还在陆续抢），离开页面即停。
