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
                / director(调度决策) / memory(打分+抽取) / heartbeat(排期)
                / scheduler(唯一时间演化路径) / money-service(红包转账编排)
  lib/          通用纯函数：money(钱+种子随机) / wallet(红包/账本规则) / time(时间戳)
                / sound(提示音) / voice(TTS 缓存+播放) / keystore(密钥加密存储)
  data/         UI 视图模型类型 + 种子数据（占位色豁免颜色检查）
  store/        zustand 状态（由 Repo 水合 + 写穿，选择器签名稳定）
  components/   通用 UI：Avatar / NavBar / SubNav / icons(手写 SVG，零 PNG)
  features/     按页面/功能分域：chat-list / chat / contacts / discover / me / settings
  app/          导航骨架 TabScaffold + ErrorBoundary
```

**依赖方向**：`features → components/store/lib/ai/llm/data`，`ai → llm/lib`，
`llm → lib`。禁止反向依赖（如 lib 不得 import features）。

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
- **`scheduledActions` 表**：见铁律 5。

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

## 4. 每个 feature 一份 spec

改动某 feature 前，读 `specs/<feature>.md`（验收清单 + 设计要点 + 已知坑）。新增 feature
先写 spec 再写码。现有：design-tokens / data-schema / llm-provider / composer / nsfw /
chat-engine / group-director / money / build-distribution / story-gm（V3 预埋设计）。

## 5. 工程护栏

- 每次提交前跑：`pnpm typecheck && pnpm lint && pnpm test`（纯函数单测，零真 API，
  LLM 用录制 fixture）。UI 改动跑 `pnpm test:screenshot`（golden 回归）。
- 截图 golden 是 **AI 自检的前置滤网**；最终 1:1 判定权归**用户真机截图叠图**。
- CI 绿灯即打 tag（回滚锚点）。CI 与 App 必须同 CJK 字体，否则像素对不上。

## 6. 命令速查

| 命令 | 作用 |
|---|---|
| `pnpm dev` | Vite 开发服务器（热重载） |
| `pnpm build` | 类型检查 + 生产构建到 dist/ |
| `pnpm test` | vitest 纯函数单测 |
| `pnpm test:screenshot` | Playwright golden 截图回归 |
| `pnpm test:screenshot:update` | 更新截图基线（UI 有意变更后） |
| `pnpm lint` | eslint + 硬编码颜色检查 |
| `pnpm cap:sync` | 同步 Web 产物到原生工程 |
