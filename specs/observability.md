# specs/observability.md — 可观测性（errlog / usage / llm-recorder / 提示词工作台）

手机上没有控制台。本 App 的一切「为什么没反应」都必须能在 App 内自答，这是 M-D
那次「浏览器一切正常、真机什么都不发生」的一天换来的立场。

## 四件套与铁律：只有这四件，不许并列第五套

| 模块 | 存哪 | 管什么 |
|---|---|---|
| `src/lib/errlog.ts` | 内存 + localStorage 环形（60 条） | 所有被 `logError` 捕的异常 + 全局 unhandledrejection |
| `src/lib/usage.ts` | settings KV `usage:daily`（14 天） | LLM 调用**计次**（分用途），刻意不是账单 |
| `src/lib/llm-recorder.ts` | localStorage 环形（100 条，opt-in） | 真实调用的完整请求/响应体（永不含 key/头） |
| `src/lib/selftest.ts` | settings KV | 免密钥传输连通性探测（fetch/桥/App 三通道） |

M-G 轮工作流审计的结论写进这里：**新的观测能力只能吸收进这四件，不得新建第五套**
（当时差点出现 errlog + recorder + usage + trace 四套并列、各自 GC、各自脱敏、各自导出）。

## 页面

- `/settings/env` 环境自检：探针 + 传输自检 + 今日用量 + 错误日志 + 一键导出诊断报告。
- `/settings/usage` 用量明细（M-I11）：14 天按天条形，点开按用途拆分。
- `/settings/prompt-lab` 提示词工作台（M-I11）：读 recorder 环形，把每轮实际发送的
  系统提示**按层拆开**（标题 + 字数 + 折叠），附上下文窗口条数、模型返回、错误、时延；
  超 `PROMPT_LIMITS.totalWarn` 标红。拟人化与世界书的调参闭环靠它。

## 设计要点

- **工作台只解析、不重组**（`src/ai/prompt-lab.ts`）。引擎在六层宪法结构之后追加十余个
  条件层（生活线/目标/会话状态/伏笔/纪念日/反AI腔/语音倾向/配图…），任何"试算"式的
  二次拼装都会在一个里程碑内漂移成谎言。真源永远是录制到的那个字符串。
  解析依赖的结构不变量：每层一个 `\n\n` 分隔块（prefix-cache 纪律的副产品），
  六层以 `# ` 开头。单测钉死六层顺序——装配器改层序会先打红解析测试，逼出评审。
- **隐藏私信不进任何观测面**。recorder 在 tap 层有 suppression 计数器
  （`beginRecordingSuppression`），AI↔AI 私信窗口内的调用一概不记——工作台与导出
  **结构上**拿不到，而不是页面记得过滤。
- **errlog 永不抛错**，且冷启恢复路径与内存路径同为 newest-first
  （M-I11 修掉了恢复漏 `.reverse()` 的老 bug——诊断页恰恰是重启后最常看的）。
- **usage 是计次不是账单**：各网关的 token 报法互不兼容、有的不报，宁可给一个诚实的
  次数也不给一个常错的金额。M-J3 在此立场内加了 **token 尽力而为**：响应带
  `usage.total_tokens` 才累计（router 在成功 rung 后以 `n=0` 补记），拿不到就不估算、
  不显示——它是量级参考，永远不是账单。同轮修掉**断流双记**（流式失败回落 complete
  时同一回合记两次——`completeInner` 带「本回合已记」标记），并把 TTS / ASR / 图片生成
  纳入计次（新 UsageKind `tts`/`asr`/`image`，各在其唯一出网点记一次）。
  守卫：`tests/unit/j3-model-surface.test.ts`。

## 验收清单

- [x] 全局错误捕获（unhandledrejection + window.error）
- [x] 用量按天×按用途，14 天保留，可清空
- [x] recorder opt-in、含 suppression、导出 JSON（ApiConfigPage 与工作台两处入口）
- [x] 工作台分层视图 + 超限标红 + 上下文/响应可见
- [x] 诊断报告一键导出（探针+自检+错误日志合并为文本）
- [ ] ~106 处静默 catch 的甄别收口（约 40 处该补 logError）——排在并行波合并后（I18）
- [ ] 截图 CI job 转阻塞 + 缺失 golden 补齐——同上，避免与并行 UI 波互相踩基线

## M-J1 · 全局成本闸

usage（M-E6）让花费可见；cost-gate 让它有界。小时/日 LLM 调用预算（默认 60/600），
router 派发前检查、超限抛 `LlmError('budget')` 不入账不走降级梯；调度器把 LLM-bound
动作保留 pending 顺延到窗口翻转（`ACTION_LLM_BOUND` 逐 kind 表态，编译器强制）；
聊天回复转人设化「累了晚点聊」。用量页显示今日/本小时消耗对预算。计数器与预算都是
global settings 行（`llmSpend` / `llmBudget`），挂钟计时（与 recordUsage 同一先例——
预算是对真实时间里真实花费的运营策略，不是可回放世界状态）。

## M-J11 · 组件渲染测试进仓

16k 行 `.tsx` 此前**零渲染测试**：所有测试都是纯函数或源码字符串扫描，没有任何
东西真的把组件画出来过。装 jsdom + @testing-library/react（都是 devDep，不进包），
`.test.tsx` 用文件头 `// @vitest-environment jsdom` 单独选环境，其余一百多个纯函数
文件继续跑更快的 node 环境。

第一个目标选 `MessageBubble`：它是全 App 最宽的投影面（16 种消息类型全在这里落地），
而且**已经产生过这一类 bug**——M-I18 审计发现收藏页把红包渲染成字面量「[rp]」，
内部枚举名直接上屏，没有任何测试失败，因为没有任何测试渲染过东西。

### 全类型清扫，以及它第一版为什么不够

清扫对每种类型渲染一次并断言：没有 `[object Object]`、没有 `undefined`、
没有 `[类型名]`。**这三条不够**——我删掉 `file` 分支验证时它全绿：switch 的兜底是
`msg.content ?? [type]`，所以一个带 content 的卡片类型会**降级成普通文字气泡**，
文件名照常显示，字符串断言什么也看不出来，卡片就这么没了。这正是「[rp]」那个 bug
的静默版本。

所以加了第四条：每种类型必须走**它自己那个分支**，用只有该分支才会产出的 class
识别（`OWN_BRANCH` 表）。再删 `file` 分支，测试立刻按名字报出来
「file 没走自己的渲染分支（.file-card__main 不存在）」。

类型清单从 `src/data/types.ts` 的 `MessageType` 联合**扫源码**得到，不写魔数：
新增类型没登记样本会按名字转红。扫描要先剥注释——好几个成员的文档里带分号
（「content = 地名; meta: …」），按第一个 `;` 截断会把联合悄悄砍到前九个，
那种「看起来在工作、实际只查了三分之二」的守卫比没有更糟。
