# spec: 关系演化引擎（M-D1）

**文件**：`src/ai/relationship.ts`（计分+回归+持久化+反哺）、`src/ai/agent-state.ts`（防刷屏）。
零 LLM、零新 store（settings 承载：`rel_edges` 一行、`agent_state:<id>` 每 AI 一行）。

## 模型
- 无向边 `(fam, aff, baseline, day)`，键=`sort(a,b).join('~')`，user 即 'self'。
- **familiarity 0..100 单调升**（认识了就不会不认识）；**affinity 0..100 有界**，
  每日向 baseline（=人设 affinityInit）复合回归 10%——热度会凉，人设底色不变。
- 回归是纯函数惰性结算（按整天差），无挂钟读取、无随机 → 回填/重放完全一致。

## 事件计分（唯一入口 `recordRelEvent`）
| 事件 | fam | aff | 挂钩点 |
|---|---|---|---|
| user_reply 用户回信 | +1 | +0.5 | engine.sendUserMessage |
| group_chat 群内同轮 | +0.3 | 0 | group-engine 播放后 |
| rp_received 领到红包 | +1 | +3 | money-service.claimRedPacket（发给自己不算） |
| transfer_received 转账到账 | +1 | +3 | money-service.acceptTransfer |
| moment_liked 被点赞 | +0.5 | +1 | appStore.toggleLike/applyLike（自赞不算） |
| teased 被导演安排抬杠 | +0.5 | −2 | group-engine intent=disagree 且 target 为成员 |
| dm_gossip 私下聊过 | +1 | +0.5 | agent-dm 成功一场后 |

**铁律**：新事件只能加进计分表+经 `recordRelEvent`；散落的直接写边=计分漂移，禁止。
并发写经模块内 promise 链串行化（单 settings 行的读改写竞态）。

## 反哺面（aff 生效处）
1. 心跳间隔 × `heartbeatAffinityMul(aff)`——**默认亲密度 20 时恒为 ×1.0**（激活引擎
   不改变从未互动档案的节奏，回填重放对等）；aff 100 → ×0.73。
2. prompt 关系层追加「你们现在的熟络程度」一条（陌生 <30 / 熟 30-65 / 密 ≥65 三档
   措辞）；**只并入现有关系层，不新增层**（DeepSeek 前缀缓存纪律）。
3. 朋友圈赞评概率：collectReactors 用活边 aff 替换静态 affinityInit。
4. 群导演「小团体」情报：群内 AI↔AI aff≥65 的对 → 「X和Y走得近」（≤2 对）。

## agent_state（防刷屏）
连续主动（heartbeat/nudge）2 次未获回复 → 24h 冷却（`nextHeartbeatAt` 的 notBefore
下限）；用户回信立即清零。宪法条款：写了必接线——交付时 grep 验证
noteProactiveSent/noteUserReplied/getAgentState 各有调用方。

## 心情耦合（同批交付，src/lib/mood.ts）
`moodParams(key)` 查表：cpmMul 乘打字速度、proactMul 除心跳间隔。calm 恒 (1,1)；
参数表由快照单测钉住，改校准=改测试，必须是有意的。

## 验收
- [x] 计分/回归/夹取/边键无序性/并发写 12 项单测（tests/unit/relationship.test.ts）
- [ ] 真机观感：连聊几天后该 AI 更快主动找你；被怼的两个 AI 群里疏远；AI 连发两条
  你不理，它 24h 内不再来。
