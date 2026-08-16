# CLAUDE.md — 仓库宪法（Repo Constitution）

本项目是一款**个人自用**（不商用、不公开）的「AI 微信」App：1:1 复刻微信大陆版 8.0.x
的前端，核心是可任意配置的智能体（充当好友/群友）+ 智能单聊/群聊/朋友圈 +（V3）剧情
模式 + NSFW 开关。技术栈 **Web-first + Capacitor**，local-first、无自建服务器、API key
用户自填。完整规划见 `docs/PLAN.md`。

编码主要由 Claude Code 完成，用户负责真机验收与提供素材。因此本文件是**所有会话都必须
先读**的约束层：它定义模块边界、接口契约、禁止事项。改代码前先读相关 `specs/*.md`。

---

## 0. 铁律（违反即回退）

1. **颜色只走 token**：任何颜色必须引用 `src/styles/tokens.css` 的语义变量。组件 CSS/TSX
   里禁止出现 `#hex` / `rgb()` / `hsl()` 字面量。`pnpm lint` 会用
   `scripts/check-no-hardcoded-colors.mjs` 强制检查（`src/data/` 的占位头像色是数据，已豁免）。
2. **真实 API key 禁止入库**：代码、日志、fixture、注释里都不许出现真实 key。key 只在运行时
   从安全存储（Android Keystore / Web WebCrypto）读取。DB 只存 `key_alias`。`.gitignore`
   已收口 `.env*` / `*.keystore` / `*.jks`。
3. **金额一律整数「分」（fen）**，时间一律 epoch ms。禁止用浮点表示钱。
4. **不使用 `Date.now()` / `Math.random()` 于引擎与可回放逻辑**：时间由外部注入，随机由
   `seededRng(seed)` 提供，保证离线回填与红包拆分可确定性重放。截图与测试同理（种子化）。
5. **单一时间演化路径**：所有"随时间自动发生的事"（心跳、错峰赞评、抢红包、撤回、离线回填）
   只能经由 `scheduled_actions` 表 + `simulate()` 纯函数。禁止出现第二套时间推进代码。
6. **NSFW 全开档上下文禁止流向国内官方端点**（DeepSeek/MiniMax）——只能走宽松通道
   Provider。这是代码层硬约束，不是 prompt 层建议。详见 `specs/nsfw.md`。
7. **提交署名只用仓库主人身份**（`qingxuelin97-sketch <mesakurax@gmail.com>`，本地
   git config 已固定）。提交信息**禁止**出现 `Co-Authored-By: Claude*`、`Claude-Session:`
   等任何 AI 署名尾注——用户已明确要求 Claude 永久移出贡献者列表，此要求覆盖默认行为。

## 1. 目录与模块边界

```
src/
  styles/       设计 token（tokens.css 是唯一可写死颜色的文件）+ reset + 布局
  db/           schema.ts(关系型真源，SQLite 目标) / idb.ts(IndexedDB 驱动)
                / repo.ts(Repo 接口——M3 换原生 SQLite 只替换驱动)
  llm/          LLM 适配层：types(契约) / http(传输) / openai-compatible(基类)
                / presets(三家预设) / bubbles(多气泡解析) / router(路由+降级)
                / service(配置→Provider/Router 的接线)
  ai/           AI 业务纯逻辑：prompt(分层组装) / engine(单聊) / group-engine(群聊)
                / director(调度决策) / memory(打分+抽取) / heartbeat(主动消息排期+素材+nudge)
                / agent-dm(AI↔AI 私信与八卦扩散)
                / scheduler(唯一时间演化路径) / money-service(红包转账编排)
                / moments-engine(朋友圈排期+生成) / moments-service(朋友圈编排)
                / simulate(离线回填规划，纯函数) / backfill(屏障+物化)
                / notify-service(队列→通知，含一致性铁律)
  lib/          通用纯函数：money(钱+种子随机) / wallet(红包/账本规则) / time(时间戳)
                / sound(提示音) / voice(TTS 缓存+播放) / keystore(密钥加密存储)
                / notify(预调度通知+内容分级) / backup(.aiwx 导出恢复) / search(全局搜索)
  native/       原生桥 JS 侧（M-I10）：bridge(AiwxNative 插件包装，超时真拒绝)
                / deep-link(aiwx:// allowlist) / reply-drain(通知回复队列→正常发送路径)
                / background-notify(后台消息→通知/气泡/来电) / widget-sync / battery
  data/         UI 视图模型类型 + 种子数据（占位色豁免颜色检查）
  store/        zustand 状态（由 Repo 水合 + 写穿，选择器签名稳定）
  components/   通用 UI：Avatar / NavBar / SubNav / icons(手写 SVG，零 PNG)
  features/     按页面/功能分域：chat-list / chat / contacts / discover / me / settings
  app/          导航骨架 TabScaffold + ErrorBoundary
```

**依赖方向**：`features → components/store/lib/ai/llm/native/data`，`native → store/ai/llm/lib/db/data`，
`ai → llm/lib`，`llm → lib`。禁止反向依赖（如 lib 不得 import features）。
`android/` 自 M-I10 起入库（手写 Kotlin 原生层）；CI 只 `cap sync` 不 `cap add`，
再生成策略见 `docs/android-regen.md`。

## 2. 关键接口契约（改动需同步 specs 并慎重）

- **`ChatProvider`**（`src/llm/types.ts`）：`complete()` 单次补全 + `generate()` 返回
  `AsyncIterable<Bubble>`。V1 非流式（一次性 yield 全部气泡），但**签名即流式**，升级
  NDJSON/SSE 不改任何调用方。新增 Provider 走 `presets.ts` + `makeProvider()`。
- **`Bubble`**（`BubbleSchema`）：`{type, content, emotion?, delay?}`。AI 输出一律经
  `parseBubbles()` 归一（NDJSON / JSON 数组 / 纯文本兜底）+ zod 校验。
- **`LlmRouter`**：按 `role`（chat/director/memory/reasoning）+ `nsfwTier` 路由，内置
  三级降级（软化重试+prefix → 宽松链粘性 → 人设化拒绝）。原始拒答永不上屏。
- **`assembleSystemPrompt()`**：分层顺序固定 = 基底 → 人设 → 关系 → **NSFW 边界层** →
  记忆 → 场景。改顺序=改行为，需评审。
- **`scheduledActions` 表**：见铁律 5。新增时间驱动行为 = 在 `SCHEDULED_ACTION_KINDS`
  （`src/db/schema.ts`，**唯一那份列表**，`ActionKind` 由它派生）加一项 + `registerHandler`，
  **不要**新建计时器。M-I 轮结束时共 **19 种**：heartbeat / rp_grab / transfer_accept /
  moment_post / moment_like / moment_comment / group_msg / agent_dm / recall /
  mem_extract / story_tick / ai_money / ai_call / joint_plan / agent_forward /
  group_event / agent_invite / moment_repost / auto_backup。自续链的那几种用
  `registerChainedHandler`（先续链后干活，失败只暂停不终结），并且必须进 wiring 测试的
  SELF_CHAINING 清单。
- **前台生命周期**（`src/app/useForegroundLifecycle.ts`）：回前台 = 回填 → 撤销并重排通知。
  没有它，`runBackfill` 只在冷启动跑一次——而手机上「切后台→回前台」才是常态。
- **`simulate(t0,t1,state,seed)`**（`src/ai/simulate.ts`）：离线回填的规划器，纯函数——
  不调 LLM、不碰存储、不读挂钟。它只产出「何时该发生什么」，由 `backfill.ts` 物化成 fireAt
  在过去的 scheduled_actions，交给同一个执行器排空。改限额或窗口规则要同步 `specs/backfill.md`。

## 3. 禁止重写清单（已定型，勿推倒重来）

- 设计 token 命名与语义分层（`--wx-*` 原始色 / `--color-*` 语义别名）。**色值以用户真机
  截图采样为准**（如自己气泡 `#AAEA7A`、未读红 `#E75E58`），不要改回网上流传的"标准"值。
- `src/db/schema.ts` 的表结构与不变量（rowid 序==时间序、金额分、JSON 列演进）。
- `Repo` 接口（`src/db/repo.ts`）——换存储驱动只实现接口，不改调用方。
- LLM 适配层的 `ChatProvider` 契约与 `Bubble` 结构。
- 三级降级链与 NSFW 路由铁律。
- 组合器三态状态机 `useComposerPanel`（键盘⇄面板零跳变，面板高锁定键盘高）。
- 引擎的可打断设计（`AbortController` + 丢弃未播队列）与人设化兜底。

## 3.5 已知陷阱（踩过一次，别再踩）

- **zustand selector 禁止返回新数组/对象**（如 `s.contacts.filter(...)`）：
  `useSyncExternalStore` 每次拿到新引用会无限重渲染 → 生产构建白屏（React #185）。
  正确做法：选稳定引用后在组件内派生；空集合用模块级常量。
- **golden 截图阈值别放松**：`toHaveScreenshot` 的 golden 是 **CSS 像素**尺寸（390×844≈33 万像素），
  `maxDiffPixelRatio: 0.01` 等于放过 3300 个像素——**一个改掉的词（约 100 像素）完全藏得住**，
  曾导致改了群标题却没被回归网抓到。另外 `threshold`（单像素颜色容差）默认 0.2 会把文字抗锯齿
  边缘算作"没差别"，必须一起调低。现用 `threshold: 0.1 + maxDiffPixels: 40`，同容器内渲染确定性，
  连跑不飘。
- **`idb.ts` 每加一个 store 必须 `DB_VERSION` +1**，否则 `onupgradeneeded` 不触发，新 store 不存在。
- **回填时间戳不得早于该会话最后一条消息**：行是「现在」插入的（rowid 递增），时间戳倒挂会破坏
  `rowid 序 == 时间序`，游标分页随即错乱。`simulate()` 已按会话取 floor，改动那段要保住这条。
- **AI 的点赞用 `applyLike` 而不是 `toggleLike`**：AI 反应永远是「加」。曾写成先 `putLike`
  再 `toggleLike`，第二步把刚加的赞又取消了。凡是「幂等加」语义都别复用 toggle。
- **`PersonaVM` 加字段要走 `makePersona()`**（`src/data/persona-defaults.ts`）：否则种子、
  测试 fixture、人设编辑页三处都要手改，漏一处就在运行时变成 `undefined`——而 `undefined`
  在这里会被静默读成「从不发帖」「从不点赞」，不报错、只是功能消失。
- **Capacitor 插件要对齐主版本**：本项目 core 是 7.x，插件必须装 `@^7`。装成 8.x 只有一行
  peer warning，不会报错，但原生侧行为未定义。
- **构建 APK 需要 JDK 21，不是 17**：capacitor-android 7.6.x 以 `sourceCompatibility 21`
  编译。用 17 时前面一切正常，直到 Gradle 走到那个模块才报 `invalid source release: 21`
  ——已经过去 100 秒。CI 里 pin 死 21。
- **本容器构建不了 APK**：`dl.google.com` 被出网策略 403（Android SDK 与 Google Maven 都在
  这一个域名下），且无 `/dev/kvm`/`vmx`/`emulator`。APK 只能由 GitHub Actions 产出，
  见 `.github/workflows/release.yml`。
- **写了没接线 = 没做**：M2 的 heartbeat、M4 的 notify、M2 的 relations 层都曾
  「写完、有测试、零调用方」。交付前 `grep -rn "from '.*<新模块>'" src/` 确认真有调用方。
- **`enqueue` 按 id upsert**：给「一辈子只发一次」的动作（nudge）复用稳定 id 前必须
  `actionExists(id)`——否则会把已完成的行覆写回 pending，无限重发。
- **隐藏会话（AI↔AI 私信）的过滤做在 `search()` 内部**，不是 UI 层。UI 忘传也漏不出去。
  新增用户可见面（如导出预览、通知）时想一下：隐藏会话进去了吗？泄漏即穿帮且不可逆。
- **原生桥的"超时"必须是真拒绝**：CapacitorHttp 无法从 JS 中断，曾经的超时守卫是个
  回调体为空的 setTimeout——挂起的桥调用就永远 await（真机"测试连接"卡死）。凡包装
  不可中断的原生 Promise，都要 `Promise.race` 一个**会 reject** 的定时器。
- **AudioContext 每次退后台都会被 Android 重新挂起**，且 `resume()` 是异步——在挂起态
  排 240ms 的音窗=永远无声。播放前 `await resume()`，回前台再 `resumeAudio()`；
  一次性的 `unlocked` 标志挡不住第二次挂起。
- **CryptoKey 经 JSON 序列化变 `{}`**：备份导出 settings 全表就会把主密钥导成空壳，
  恢复写回后 keystore 永久损坏。设备本地密钥行要行级排除（导出滤掉、恢复保本机），
  读取时用 `instanceof CryptoKey` 校验而不是 truthiness——空壳是 truthy 的。
- **golden 只能由 CI 生成，本地重基线一律作废**：截图 job 自 M-I11 起**阻塞**。本容器与 CI
  有**两处**渲染差异，任一处都会移动字形像素：① CJK 字体（本容器默认没有，装
  `fonts-noto-cjk` 可对齐）；② **Chromium 构建**——`playwright.config.ts` 本地走
  `PLAYWRIGHT_BROWSERS_PATH` 提供的那个 build，CI 走 `playwright install` 钉住的另一个
  build，两者抗锯齿不同。实测：只对齐字体后仍有 **30/52 张红**。所以 UI 有意变更后不要
  在本地 `test:screenshot:update` 提交，改为在你的分支上手动触发 **`regen-goldens`**
  workflow（workflow_dispatch），由 CI 生成并回推基线（它会连跑两次自检，不可复现的基线
  不许进仓）。本地 `pnpm test:screenshot` 只当快速冒烟，不是门禁。
- **不要为"截图稳定"冻结业务时钟**：组件里硬编码 NOW 常量意味着真机上所有相对时间戳
  永远错（diffDays 为负渲染成「星期六」）。确定性归测试侧：Playwright
  `page.clock.setFixedTime(种子纪元)`，业务代码用真实时钟（`useNow()` 分钟级 tick）。

## 4. 每个 feature 一份 spec

改动某 feature 前，读 `specs/<feature>.md`（验收清单 + 设计要点 + 已知坑）。新增 feature
先写 spec 再写码。现有：design-tokens / data-schema / llm-provider / composer / nsfw /
chat-engine / group-director / money / moments / backfill / backup（.aiwx 导出恢复，
M-I18 起自成一块）/ build-distribution / story-gm（V3 预埋设计）/
native-android（M-I10 重原生）。

## 5. 工程护栏

- 每次提交前跑：`pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:size`
  （纯函数单测，零真 API，LLM 用录制 fixture）。UI 有意变更后**在 CI 上**跑 `regen-goldens`
  重基线——本地生成的基线与 CI 的 Chromium 构建不一致，提交即让阻塞门禁全红。
- 截图 golden 是 **AI 自检的前置滤网**；最终 1:1 判定权归**用户真机截图叠图**。
- CI 绿灯即打 tag（回滚锚点）。CI 与 App 必须同 CJK 字体，否则像素对不上。

## 6. 命令速查

| 命令 | 作用 |
|---|---|
| `pnpm dev` | Vite 开发服务器（热重载） |
| `pnpm build` | 类型检查 + 生产构建到 dist/ |
| `pnpm test` | vitest 纯函数单测 |
| `pnpm test:screenshot` | Playwright golden 截图回归（**本地必然有差异**，见陷阱：基线由 CI 生成；本地只当冒烟） |
| `pnpm test:screenshot:update` | 只在本地实验时用；**产出不许提交**，重基线走 CI 的 `regen-goldens` workflow |
| `pnpm check:size` | 启动包 gzip 体积棘轮（CI 同步执行） |
| `pnpm lint` | eslint + 硬编码颜色检查 |
| `pnpm cap:sync` | 同步 Web 产物到原生工程 |
