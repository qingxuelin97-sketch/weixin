# spec: 红包 / 转账 / 零钱（M3；J8 钱二期）

**文件**：`src/lib/wallet.ts`（纯规则）、`src/ai/money-service.ts`（编排）、
`src/ai/bill-service.ts`（群收款编排，J8）、`src/ai/money-motive.ts`（送/收/AA 决策）、
`src/features/money/*`（UI）、`src/ai/scheduler.ts`（时间驱动）。

## 铁律
- **金额一律整数「分」**，禁止浮点。
- **红包创建时即预拆分**：拼手气 `splitLuckyPacket(total, count, seed = rpId)`；
  均分 `splitEvenPacket(total, count)`（无 rng，余数前置：10/3 → [4,3,3]）；
  专属恒为 `[total]` 一份。`sum(shares) === total` 恒成立且可重放；领取按顺序消费份额。
- **红包玩法 (J8)**：`RedPacketVM.mode` = `'lucky' | 'even' | 'exclusive'`，
  **undefined = lucky**（M3 起的旧行零迁移），读侧经 `rpModeOf()` 归一。
  专属包的领取守卫在 `claimShare`（纯规则层）——旁观者的 `rp_grab` 行连排都不排
  （createRedPacket 过滤），漏网旧行也领不走；开包页的「专属红包」提示只是礼貌，
  不是边界。rp/send 页群聊三选；单聊无选择器。
- **手气最佳只在领满后裁定**（未领满不显示皇冠），平局取最早——与 `bestLuckIndex` 一致。
- **一人只能领一次**；领完再点返回 null（UI 显示"手慢了"）。
- AI 抢包延迟按人格 `grabSpeed` 种子化（fast 1-8s / mid 5-20s / slow 10-45s），
  同一红包不同人延迟必不同 → 天然错峰，不会齐刷刷。
- 时间驱动一律走 `scheduled_actions`（宪法铁律 5），不另起定时器。

## 零钱账本
`WalletTxVM` 带符号金额 + 冗余 `balanceAfterFen`（明细页直渲，无需累加）。
`currentBalance` = 最新一条的 `balanceAfterFen`。发红包即时扣款，领取即时入账；
转账发出即扣款，对方接收后才计入对方（用户为收款方时才 `transfer_in`）。

**J8 账单页改造**：`getWalletTxs(opts?)` 向后兼容加游标——`limit` 取最新 N 条
（页内仍升序，游标 `before` 往回翻），无参 = 老契约全量（年度报告/备份）。
IDB 走 v10 的 `wallet_tx.byCreatedAt` 索引倒走游标（getAll 一次都不调），
SQLite 镜像 SQL 带 `, key DESC` 平局键与 IDB 索引序对齐——两驱动分页必须逐字节一致
（sqlite-repo parity + perf-budget「账单首屏读 ≤ 一页」都盯着）。
`recordWalletTx` 只读最新一行推进余额，并可选定格 `peerId`（对手方 contactId，
账单页按联系人筛选的数据来源；群发红包无单一对手方则不写）。
WalletPage：首屏一页 + 加载更多 + 按月分组小计 + 类型/联系人筛选 chips；
余额永远取自首屏页（最新页按构造含最新一行）。
`kind` 新增 `bill_in`/`bill_out`（群收款两个方向）。

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

## 红包 24 小时过期退还（M-J8）
`red_packets.expiresAt` 从 M3 就在 schema 里，**零读零写**——没人领的红包永远亮着，
钱永远回不来。J8 补上，构造与 transfer_return 完全同族：

- 发包时写 `expiresAt = now + 24h` 并 `enqueue({kind:'rp_return', id:'rp_return_<rpId>'})`
  ——一次性动作问「有没有过」（`actionExists` 守卫；enqueue 按 id upsert，盲目重排会
  把已退还的行复活成 pending）。
- `returnRedPacket()` 只对 `active` 生效 → 天然幂等：领完（status done）与已退（expired）
  的行排到也零动作。**过期未领 → 未领余额**（totalFen − 已领）整数分退回发送方钱包
  （`rp_in`，refId `<rpId>_ret`；AI 的包不动账本——她的钱是虚构的）。
- UI：气泡转 `已过期` + dim；灰条「红包已过期，退回 X 元」（AI 的包只说「已过期」）。
  时间戳同样 `max(fireAt, 最后一条)`。过期后 claim 一律 null（status 检查兜底），
  开包页显示「红包已过期」。
- 执行顺序自洽：rp_grab 是 FAST_KIND，离线三天回来后先抢后退——退款金额永远是
  抢剩下的那份。

## 群收款 / AA（M-J8）
新消息类型 `'group_bill'`（schema enum + VM union）；卡片渲染 发起人/人均/已付未付名单，
render-msg 投影全量数字（AA 的金额在微信里本来就是公开的——总额/人均/谁没付正是
「还差谁」要问的），**名字定格进 meta（名片快照纪律），id 永不上屏**。

- **结算真源在 settings `bill:<convId>`**（一行一会话，值是 billId→BillState map；
  键尾是 convId 正是为了 `SETTINGS_KEY_CASCADE` 的 conv 级联能命中——`bill:<billId>`
  谁也删不掉）。卡片 meta 只是渲染镜像，每次付款后重写。
- 发起：用户走群聊 + 面板「群收款」→ BillSheet（总额 → `splitEvenPacket` 平摊预览）；
  AI 走 `planGroupBill`（每周 seeded 骰子、小额菜单、死群不收）→ 前台 pass 的
  `considerGroupBill`（actionExists + 稳定 id `gbill_<convId>_<week>`）→
  `ai_money` 行载 `kind:'bill'` → handleAiMoney 分流 `runBill` → `startAiBill`
  在**开火时**解析名册（中途退群的人不欠钱），用户以 `'self'` 列进 parts。
- 应答：新 kind `'bill_pay'`（零 LLM，ACTION_LLM_BOUND=false）。创建时按
  `planBillPayment(billId, contactId, persona)` 逐人决定：seeded 延迟 2–40min
  （大方的人手快）或**装死**（概率随 generosity 下降，铁公鸡 ≈44%）——装死的人
  根本不入队，那正是 AA 的戏剧性。
- `payBill` 幂等（重复行/双击只付一次）；钱包只动用户边：AI 付**你发起**的账 →
  `bill_in` 入账（claimRedPacket 先例：她的虚构钱变你的真余额），你付**AI 发起**的账
  →（点卡片 → 确认弹窗 →）`bill_out` 扣款。全付清 → 一条「群收款已完成」灰条
  （不逐人刷屏）。

## 收钱侧动机：AI 拒收转账（M-J8）
`transfer_accept` 的队列路径不再无条件 accept——runtime 把 deps.acceptTransfer 接到
`receiveTransfer`：user→AI 且有人设时走 `planTransferReception`（纯函数，种子 =
transferId，重放同结果）：

- **金额 > 阈值**（`acceptThresholdFen(affinity, generosity)`，随关系与大方度单调升）
  或 **近期 affect 恶劣**（valence ≤ −0.35，金额 ≥ ¥1——一分钱的玩笑不值得赌气退）
  → 拒收：她发一句模板解释（零 LLM），把发送时就排好的 `tr_return_<id>` 行
  **同 id 前移**到 20–60s（enqueue upsert = 移动，不叠行）——退钱走的还是那一条
  transfer_return 路径，拒收不新增第二条回钱通道。
- 其余照旧 accept。**用户自己点收款（ChatPage.onMoneyTap）永远无条件 accept**。

## 验收
- [x] 15 个纯函数单测：份额守恒、顺序一致、重复领取拒绝、领完拒绝、皇冠唯一/未满不评/
      平局取最早、抢包延迟确定性与人格窗口、余额推进与收支往返归零。
- [x] E2E：发 8.88 元 4 份到群 → 三个 AI 先后领取（陈叔 slow 未到）→ 零钱 1288→1279.12；
      点开种子红包 → 翻币 → 详情 ¥18 + 皇冠 → 余额 1306.00。
- [x] 转账退还（M-I18）：排期为 `transfer_return` 行且 id 稳定 / 她转你没收 → 状态+气泡+
      系统消息+投影四处一致 / 你转她没收 → 零钱整数分往返归零 / accepted 后再跑退还是空操作 /
      跑两次只退一次 / 回填晚到时系统消息不早于会话最后一条。
- [x] J8 单测（tests/unit/j8-money2.test.ts，31 条）：均分守恒/余数前置/确定性、
      专属只有本人能领（纯规则层 + 编排层双守卫）+ 旁观者 grab 不入队、
      rp_return 稳定 id + 过期退款分毫不差 + 领完零动作 + 幂等 + 不倒挂、
      拒收（高金额低关系转红）+ 同 id 前移 + 可回放、账单三页拼回全量、
      群收款创建/装死/幂等/双向钱包/完成灰条/投影无 id。另有 sqlite parity
      分页一致与 perf-budget 首屏 ≤ 一页。
- [ ] 真机验：翻币动画手感、拆包页返回不误触、隔夜未收的转账第二天确实变「已退还」、
      隔夜没人领的红包变「已过期」且零钱回账、专属红包旁观者点开吃闭门羹、
      群收款有人秒付有人装死、超大额转账被她原话退回来。

## 已知坑
- `idb.ts` 的 `DB_VERSION` 每加 store 必须 +1，否则 `onupgradeneeded` 不触发（v2 加钱、v3 加 TTS 缓存）。
- 详情页轮询 1s 刷新领取列表（AI 还在陆续抢），离开页面即停。
