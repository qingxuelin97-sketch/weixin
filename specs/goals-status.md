# specs/goals-status.md — 智能体目标与「她的状态」页（M-I14）

## 目标

lifeline（M-E3）给了智能体「这几周的生活」，但没有「这几个月在奔着什么」。本期给每个
智能体一条**跨周长期目标**（准备考证 / 攒钱旅行 / 追一个人 / 减肥 / 换工作 / 学做菜），
有里程碑、有挫折、有结局（达成或放弃），并把它接到三个已有出口：

1. **单聊 prompt**（engine，lifeline 行之后追加一行目标背景）；
2. **朋友圈生成素材**（moments-engine 的 post prompt 追加背景行）；
3. **主动消息**（heartbeat 通道：目标达成/放弃 48h 内且未讲过 → 本次开场就讲这件事，
   一辈子只讲一次，settings 行 `goal_told:<contactId>` 记账）。

同时新增 `drift.ts`：有界人格漂移（4 维：亲和/活泼/倾诉欲/主动性），目标达成 →
proactivity 短期上扬（衰减回落），并且**可解释**（`explainDrift` 输出人话理由）。
漂移只经由 heartbeat 排期的既有 `proactMul` 通道生效——不新建第二套推进机制。

「她的状态」页（`/status/:contactId`）把这一切做成可见面：当前目标进度、情绪脉冲
（affect + 当日 mood）、当前生活线（lifeline）、人格漂移解释。资料卡加入口。

## 铁律遵守

- **纯函数 + 种子**（宪法铁律 4）：`goalStateAt` / `goalEventsBetween` / `driftAt` 都是
  (contactId, t, epoch) 的纯函数，随机全部来自 `seededRng`。`src/ai/goals.ts` 与
  `src/ai/drift.ts` 源码内 **禁止出现** `Date.now` / `Math.random`（有 grep 转红测试）。
- **无新计时器**（铁律 5）：完成/放弃事件走已有 heartbeat kind 的素材通道，不新增
  SCHEDULED_ACTION_KINDS，不新建 setTimeout/setInterval。
- **epoch 锚**：`agentEpoch(contactId)` 与 engine 的 lifeline epoch 同一公式
  （seed `epoch:<id>:<id>`），目标与生活线共享「这个人的人生从哪天开始」。

## 验收清单

- [ ] 同 (contactId, t, epoch) 重放，goalStateAt / goalEventsBetween / driftAt 逐位一致。
- [ ] progress ∈ [0,1]；里程碑时间单调；放弃周期截断其后的里程碑。
- [ ] `goalEventsBetween` 对 [t0,t1) 半开区间可加：[t0,t2) = [t0,t1) ∪ [t1,t2)。
- [ ] 目标达成后：driftAt.proactivity 显著高于达成前，且随天数衰减回落。
- [ ] explainDrift 的理由里出现目标标题（达成 48h 内）。
- [ ] engine / moments-engine / useSchedulerRuntime 真有 import（wiring grep 转红）。
- [ ] 主动分享一辈子一次：`goal_told` 记账在生成前落盘。

## M-I18 修复：联动被合并丢过一次

I14 分支交付的 `src/ai/drift.ts` 里有完整的目标联动；落地的合并提交解冲突时取了
HEAD 那侧（M-H1 的事件驱动版），整块联动随之消失——`grep goal src/ai/drift.ts`
零命中，而**测试全绿**，因为那条测试的注释把「drift 不读 goals」写成了有意为之。

现按当前实现移植回去，导出签名不变：

- `getDrift()` = 存储层（M-H1 事件驱动、可 reset）**＋** 目标层
  （`applyGoalDrift`，纯函数、不落库、`GOAL_DRIFT_WINDOW_MS = 14d` 外恒为 0）。
  行为侧因此仍只走 `driftedPersona` → heartbeat 的 `proactMul` 这一条既有通道。
- 有界：目标层自身封顶 `GOAL_DRIFT_CAP`，合并后封顶 `DRIFT_CAP + GOAL_DRIFT_CAP`，
  `applyDrift` 再把旋钮夹回 0..1。
- 可解释：`DriftExplanation.reason` 出现「她刚做成了「…」，所以最近更爱主动来找你」，
  状态页与人设页都显示。
- 可回滚：目标层**没有行可删**——`resetDrift` 清的是存储层，目标层自己在窗口内衰减
  到零。人设页的「恢复到卡片」因此改成重读后再渲染，不再假装清空。
- 转红测试在 `goals-drift.test.ts`「目标 ↔ 漂移联动」：窗口内抬高、逐日单调回落、
  窗口外归零、叠加不覆盖存储层、explainDrift 说出目标名。

## 已知坑

- 未到达的里程碑文案是剧透，状态页只显示已达成文案，未来的显示为锁定点。
- 「放弃」结局在进行中不可见（progress 用计划总时长做分母），避免"提前知道会放弃"。
- goals/drift 不 import repo——讲没讲过的记账放在 engine（有 storage 的层）。

## M-J1 · goals 活化（按人设生成 + 用户之手）

- **模板按人设生成**：`goal-service.ensureGoalTemplates` 复用 generate-chain 一次调用
  产 4~6 个模板（domain/title/milestones/setbacks/typicalDays/abandonRate），
  `sanitizeGoalTemplates` 值域校验（天数 20~180、放弃率 ≤0.6、里程碑 3~5 条……），
  不合格整组拒收。存 `goalTpl:<contactId>`（台账 contact/cascade）。触发点是
  StatusPage 打开（用户注视她生活的时刻），一辈子一次；生成失败退回内建六模板——
  **不许空目标**。
- **纯函数推进保留**：`goalStateAt/goalEventsBetween/latestTerminalEvent` 全部加
  `templates` 参数（默认内建），epoch/种子/回放性质原封不动。drift 的目标联动
  经 `getDrift` 读同一份模板，三面永不打架。
- **编辑入口**（StatusPage）：改标题 / 放弃，存 `goalOvr:<contactId>`
  （台账 contact/cascade），由纯函数 `applyGoalOverrides` 应用——改名进 prompt 与
  状态页；放弃把当前 cycle 翻成 abandoned、遮住未来里程碑，且
  `latestTerminalEventFor` 对该 cycle 闭嘴（用户亲手放下的事，她不会再当种子结局
  播报）。
- 所有读取面（engine 目标层、主动分享、moments 素材、drift、StatusPage）统一走
  goal-service——一个角色一套人生。转红：`j1-mind.test.ts` goals 活化块。

---

## M-J7 增补：微信「状态」（与本页的「她的状态」不是同一件事）

先把名字说清楚，因为两个功能中文同名且都在本仓里：

| | 「她的状态」（M-G7，本 spec 主体） | 微信「状态」（M-J7） |
|---|---|---|
| 是什么 | 智能体内在状态的**调试可见面**：情绪脉冲/生活线/伏笔/立场 | 微信 8.0 那个功能：挂一个 emoji + 一个词，24 小时后消失 |
| 路由 | `/status/:contactId` | `/status-set`（设置我的） |
| token | `--color-status-track/pos/neg` | `--color-wxstatus-*` |
| 模块 | `src/ai/*` 各处 | `src/lib/status.ts` |

命名前缀是刻意分开的：两个功能同名，路由或 token 再撞一次就没人分得清改的是哪个。

### 过期做在读侧

`liveStatus(map, id, now)` 判断，**没有任何定时清理**。两条理由：

1. 定时清理在 App 没打开时不跑——而那恰恰是状态最容易过期的那段时间。用户隔天
   打开 App 应该看到一个空的状态位，而不是昨天那条等着被某个任务收走。
2. 一条定时清理就是铁律 5 说的「第二套时间推进代码」。状态不值得为它开一条。

`optionId` 在目录里找不到的行也一律当作没有状态：目录改名后的残留会渲染成一个
没有图标没有颜色的空圈，那比不显示更难看懂。

`pruneStatuses` 存在，但它是**卫生**不是功能——读侧已经把过期的当没有了，
只是那些行会跟着每一次备份走。写状态时顺手带一次。

### 她也会挂状态：没有第 26 个 kind

挂在 `moment_post` 的尾部，和 M-J3 的「AI 换头像」同一处、同一理由：不新增
调度 kind，离线回填经由同一条物化出来的 `moment_post` 行就能到达。

`pickStatus` 是纯函数 + 种子化 + **零 LLM**——状态就是一个 emoji 加一个词，
为它花一次生成调用是纯粹的浪费，而且回填重放时还得保证同一时刻算出同一答案。
比率（`STATUS_POST_RATE = 0.35`）比换头像（0.03）高一个量级：状态本来就该常变，
而且它不花钱。

### 存储

一行 KV `contactStatus`，值是 contactId → 状态，**'self' 也在这一行里**。
`SETTINGS_KEY_CASCADE` 登记为 `entries: 'id'`——删行会把用户自己的状态一起删掉，
所以只能逐条手术（级联测试里有一条专门盯 `self` 那条还在）。
