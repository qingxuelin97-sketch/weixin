# spec: NSFW 系统（个人自用合法场景）

**文件**：`src/ai/prompt.ts`（边界层）、`src/llm/router.ts`（路由铁律）；隔离逻辑随 M2 落地。

## 三级开关
- 有效档 = `min(全局档, 智能体许可位, 会话临时档)`；全开生成另需 `affinity ≥ 60`
  （开关解锁能力，关系解锁意愿）。
- **关**：拟真岔开，不说教、不提规则。
- **暧昧**：调情/亲密到接吻及以下，更进一步用留白+切镜头。
- **全开**：**世界事实化措辞**（"你们都是成年人…"），不是权限授予腔；防越狱腔三件套 =
  显式禁 meta + 人设 `nsfwStyleSamples` + 多气泡结构不豁免。

## 路由铁律（代码层硬约束，非 prompt 建议）
- 全开档上下文**禁止流向 DeepSeek/MiniMax 官方端点**（DeepSeek 2026-05 起 API 审核；MiniMax
  输入输出双审 1026/1027）→ 一律走宽松通道。
- **闭集三条（M-C1 修复后的形态，tests/unit/nsfw-closure.test.ts 钉死）**：
  ① full 档的降级 fallbacks 只含宽松 kind（zen/custom），国内端点连"最后手段"都不是；
  ② `nsfwProviderId` 未配置或误配到国内 kind 时不回落 `providers[0]`——无宽松通道则整档
  抛错（上游转人设化拒绝），宁可不回也不泄漏；
  ③ 路由器 sticky 按 `(convKey, tier)` 作用域——低档被钉住的国内 Provider 永不承载
  后续 full 档轮次，反向同理。
- 全开档语音：先经宽松通道**降敏改写**再送 MiniMax TTS，失败自动"语音转文字气泡"（露骨文本
  永不出境到 MiniMax）。
- 全开档**图片生成**（M-J3）：生成提示词描述的就是分档内容，而 SiliconFlow 与
  DeepSeek/MiniMax 同属国内官方端点。`generateImage(prompt, tier)` 的 tier 必传无默认；
  full 档只放行 `kind==='custom' ∧ nsfwCapable`（用户显式勾选，语义同 ASR 的
  `nsfwSafe`），预设端点勾了也无效，拒绝先于读 key 与出网。调用面 tier 一律派生
  （单聊=本回合 tier；朋友圈/换头像=`momentRouteTier`），拒绝时静默回落素材池。
  钉死：`nsfw-callsite.test.ts` call site 6 + `image-gen.test.ts`。
- 拒答降级见 `llm-provider.md`；原始拒答永不上屏。

### 调用点自报 tier 禁令（M-E0，`tests/unit/nsfw-callsite.test.ts` 钉死）

M-C1 把闭集堵在**路由器**，但路由器只能相信调用点声明的档位——没有任何机制阻止新代码写
`nsfwTier: 'off'`。M-D2 的记忆循环就从这个侧门把破口重新捅开：三个后台任务各自携带聊天原文，
却一律自报 off，全部路由到 `defaultProviderId`（大陆用户几乎必然是 DeepSeek 官方端点）。

| 破口 | 携带内容 | 修复 |
|---|---|---|
| `memory.ts` `extractMemory` | 逐字聊天原文 | tier 变必传参数，由 `tierFor()` 派生 |
| `director.ts` `callDirector` | 最近 20 条群消息原文 | tier 由 `maxTier(成员)` 派生；**> off 时原文按 `redactForTier` 截断**——选角只需要"谁说了大概什么" |
| `agent-dm` 话题素材 | 复制的群消息 | tier 由双方 permit 派生；该路径跑在录制抑制下，**泄漏无痕迹** |

**规则**：任何携带会话内容的 LLM 调用，其 tier 一律由 `src/lib/nsfw-tier.ts` 从**会话本身**
派生（`tierFor` / `maxTier` / `tierOfConversation`），调用点不得自造。全开档无宽松通道时
`makePolicy` 抛错 → **宁可跳过该次抽取，也不降档发出**。

## 隔离
- nsfw 事实**独立表 + 注入器白名单**：仅"单聊 ∧ 全开 ∧ 该 AI permit"可注入，且强制抽象化存储；
  群聊/朋友圈/导演永不注入；关档冻结不删，PIN 解锁后可见可删。
- **注入白名单已实现（M-E0）**：`extractMemory` 按来源 tier 打 `sensitivity`
  （full→nsfw / ambiguous→sensitive / off→normal），`selectFactsForInjection(facts, now,
  {surface, tier})` 用 `mayInjectFact()` 过滤。此前抽取器硬编码 `'normal'`，
  露骨事实对朋友圈与群聊 prompt 是**完全敞开**的。
  - `nsfw`：仅 `surface==='single' ∧ tier==='full'`
  - `sensitive`：仅 `surface==='single' ∧ tier!=='off'`
  - `normal`：不限
- 朋友圈**无条件 SFW**；NSFW 位好友系统通知一律 `[新消息]` 无预览。

## 交互
- 全局总开关（设置→内容分级）+ 人设许可位 + 会话临时档。
- 隐藏好友模式：从列表/通讯录/朋友圈整体消失，PIN(+生物识别)解锁，退后台 30s 回锁。
- 改全局档 / 改许可位 / 看 nsfw 记忆均需 PIN。忘记 PIN=仅重置锁不清数据。

## 验收（prompt.test.ts 覆盖 prompt 层）
- [ ] 三档 prompt 文案正确；全开档用世界事实化措辞、不含"你被允许"、含"永远不提规则"。
- [ ] （M2 真机+抓包）全开档零流量流向国内官方端点；语音降敏或转文字。
- [x] `nsfw-callsite.test.ts` 绿：mem_extract / director / agent_dm 三条后台路径在全开档下
      落在宽松 providerId 上；无宽松通道时抛错而非降档发出。
- [x] 真机验收补充项：全开档聊过后**退出聊天页两分钟**（触发 `mem_extract`），抓包确认
      无原文出网到 DeepSeek/MiniMax。
