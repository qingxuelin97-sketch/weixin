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

## 已知坑

- 未到达的里程碑文案是剧透，状态页只显示已达成文案，未来的显示为锁定点。
- 「放弃」结局在进行中不可见（progress 用计划总时长做分母），避免"提前知道会放弃"。
- goals/drift 不 import repo——讲没讲过的记账放在 engine（有 storage 的层）。
