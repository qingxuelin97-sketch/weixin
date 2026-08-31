# spec: 群聊导演调度（M3）

**文件**：`src/ai/director.ts`（决策）、`src/ai/group-engine.ts`（执行）。

## 两层设计（为什么不是一层）
1. **`prefilter`——纯代码，<1ms**。处理显而易见的情况，**约半数轮次直接跳过导演 LLM**，
   这是"跳导演首响 ≤3s"的来源。
   - 被 @ 的成员必回 → `mode:'direct'`，直接命中演员
   - 剔除：不在 `activeHours` / 冷却期内（默认 45s）/ 连续发言达上限（默认 3）
   - 候选 0 → `silence`；候选 1 → 按 `proactivity` 种子掷骰；候选 ≥2 → `director`
   - **无人设卡的成员被跳过而非崩**（种子里可能有没配人设的群友）
2. **`callDirector`——一次轻量 LLM**，只在真正歧义时调用，输出调度 JSON。

## 硬规则
- **演员并发生成、按 priority 顺序播放**。串行会把 3 个演员叠成 20s+ 才出第一条；
  并发后首条 = 最快的那个演员返回即可上屏，其余被打字延迟吸收。
- 导演解析失败（坏 JSON / 网络 / 拒答）→ **降级为"选最相关 1 人"**，绝不因此让群哑掉。
- 导演可能幻觉出不存在的 agentId → 一律按候选名单过滤；cast 上限 3 人。
- 演员生成失败 → **静默**（该成员这轮不说话），不把报错甩进群里。
- 用户再次发送 = `AbortController` 硬中断，丢弃未播队列后重排。
- 导演提示注入 system prompt **末尾**（吃 recency），内容是方向而非台词。

## 数据依赖
`ConversationVM.memberIds`（V1 上限 4 个 AI）、每个成员的 `PersonaVM`。
`assembleSystemPrompt` 的 `scene.kind='group'` + `groupRoster` 已支持。

## 验收
- [x] 决策表单测 19 例（@必回 / 冷却 / 连发 / 非活跃 / 0候选 / 单候选确定性 / 无人设跳过 /
      坏 JSON 降级 / 幻觉成员过滤 / cast 上限）。
- [ ] 有 key 后真机验：跳导演首响 ≤3s、全量 ≤6s；群聊涌现自然、无刷屏；插话即重排。

## 已知坑
- `prefilter` 的种子含时间戳，同一轮内确定性、跨轮次不同——这是有意的（否则每轮同一人发言）。
- 群聊目前不注入 `relations`（`assembleSystemPrompt` 支持但未接），成员间关系感待 M4 补。

## M-I1 · 一键群聊配置

- **每群旋钮**：settings KV `groupCfg:<convId>`（activity 0-3 / spice 0-3 / topics ≤5）。
  缺行 = 默认 = 旋钮出现前的行为。读点**四处**：
  ① 群引擎每轮拼一次 `groupCfgDirective`（spice 语气行 + 话题行，附加在 scene 层之后）；
  ② 前台回填把 `activityMultiplier` 挂到 `SimGroup.activity`（simulate 是纯函数，不读
  存储）；activity 只放大**预算**，间隔不动——「15 分钟 ≤2 条」的完成标准在任何档位
  都成立（测试锁定）；
  ③ **导演预筛**（I18 补接）：`prefilterKnobs(cfg)` 把 activity 映射成
  `{cooldownMs, maxStreak, speakBias}` 传给 `prefilter`——冷清=冷却更久/更早让位/
  独苗更可能不接话，热闹反之。**档位 2 与 director.ts 的默认值逐字节相同**
  （45s / 3 / 0.35），所以没有 groupCfg 行的群行为一字不变；
  ④ 同一轮**只读一次**：`sendGroupMessage` 开头 `getGroupCfg` 一次，预筛用它、
  提示词行也用它（`groupCfgLine(cfg)`），不做第二次 settings 往返。
  掷骰仍是 `seededRng`（铁律 4），旋钮只挪动被比较的那个阈值。
- **重配置既有群**：`rebuildState(blueprint, convId, existingByName)` 绑定既有
  convId；名字匹配的现有成员直接沿用（不重复付费），关系二遍**逐边合并**（群外
  关系边不丢），名册取并集（蓝图没提到的现有成员留下），补历史时间戳以会话最新
  真实消息为下限。build state 每群一行 `groupBuild:<convId>` + ACTIVE 指针；
  旧单例行首次进入生成页时迁移。
- **成员管理**：ChatInfoPage 的「＋」改为从现有 AI 联系人拉人（原来错跳新建群）；
  「－」进入移出模式（移出=离开本群，联系人保留）；「一键重新配置本群」入口带
  `?rebuild=<convId>` 进生成页；7 个模板（`group-templates.ts`）填 brief/规模/
  旋钮，建成后旋钮落到 `groupCfg`。模板在**重配置路径上同样可用**（I18 补）：
  此时语义是「用这套气质重配」——brief 与旋钮照套，**规模不套**（群里现有多少人就是
  多少人，否则「重新配置」会把 12 人群悄悄缩成模板的 4 人）。
- **deleteContact 级联**（资料卡「删除联系人」）：顺序 = 中止在飞 → 调度队列 →
  隐藏私信双向 → 1:1 会话 → 群名册 → 记忆 → 他人卡逐边遗忘（绝不重建 relations
  整表）→ settings 定向键 → settings 行内按条清除 → 朋友圈痕迹 → 人设+联系人。
  钱相关 store 明确豁免（账本不蒸发）。`DELETE_CONTACT_CASCADE` 台账穷举全部
  store，加 store 不分类即转红；守卫还会逐个 store 播种死者痕迹、跑完级联后要求
  痕迹归零，「标了 cascade 却没接线」当场红（tests/unit/i1-group-config.test.ts）。
- **settings 键前缀台账 `SETTINGS_KEY_CASCADE`**（M-I18）：`settings` 是一张 KV
  表干十几张表的活，所以「settings: 'cascade'」这一个词什么也没保证——`agent_state:`
  / `goal_told:` / `giftAt:` / `callAt:` / `memext:` / `groupNick:` 曾整整一年
  逃过删除。现在**每个键（或带冒号的前缀）必须表态** scope（global/contact/conv/
  pair）+ row（cascade/exempt）+ 理由，**级联直接读这张表**：登记即修好。守卫测试
  静态扫描 src/ 里所有 `putSetting`/`getSetting` 的键表达式（含绕过 putSetting 直写
  settings store 的 keystore / 恢复 / 迁移三处），与台账**精确比对**——新键未登记
  即红；带 id 的模板键不许填 `global`，非 global 的键不许填 `exempt`（两个一词开溜的
  口子都堵死）。
- **行内按条清除**（台账的 `entries` 字段）：`rel_edges` 把**整张社交图存在一行里**，
  删行=清空所有人的关系，留着更糟——种子 id 是**固定**的（会话数归零时 appStore 用
  同一批 id 重新播种），残留的边会让下一个「林」直接继承死者攒的 fam/aff，第一天就是
  老关系的心跳频率与点赞率。所以按 `pairKey`（分隔符 `REL_PAIR_SEP`，定义在 repo.ts
  以防与写入侧漂移）逐条删。`groupNick:<convId>` 同理：群活下来，死者那条昵称不能活。
