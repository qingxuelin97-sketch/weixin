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

## 验收
- [x] 15 个纯函数单测：份额守恒、顺序一致、重复领取拒绝、领完拒绝、皇冠唯一/未满不评/
      平局取最早、抢包延迟确定性与人格窗口、余额推进与收支往返归零。
- [x] E2E：发 8.88 元 4 份到群 → 三个 AI 先后领取（陈叔 slow 未到）→ 零钱 1288→1279.12；
      点开种子红包 → 翻币 → 详情 ¥18 + 皇冠 → 余额 1306.00。
- [ ] 真机验：翻币动画手感、拆包页返回不误触。

## 已知坑
- `idb.ts` 的 `DB_VERSION` 每加 store 必须 +1，否则 `onupgradeneeded` 不触发（v2 加钱、v3 加 TTS 缓存）。
- 详情页轮询 1s 刷新领取列表（AI 还在陆续抢），离开页面即停。
