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
