# spec: 主题（深色模式 · 字体大小 · 聊天背景）

**文件**：`src/lib/theme.ts`（引擎）、`src/styles/tokens.css` 的深色块、`index.html` 首帧脚本、
`src/native/system-bars.ts`（原生状态栏同步）、`src/features/settings/DarkModePage.tsx`。
**基准**：微信 8.0 Android「设置 › 通用 › 深色模式 / 字体大小」「设置 › 聊天 › 聊天背景」「聊天信息 › 设置当前聊天背景」。

## 深色模式（M-K0）

### 设计要点
- **只换 token，不改组件**：`<html data-theme="light|dark">` 一个属性决定一切；深色色值全部
  在 tokens.css 的 `:root[data-theme='dark']` 块里重定义语义层（`--color-*`）。组件里出现
  「if 深色」的条件分支 = 有颜色绕过了 token 层，按 bug 处理。
- **深色原始色板 `--wxd-*` 取 WeUI 深色值**（BG-0 `#111` 页面 / BG-2 `#191919` cell /
  BG-5 `#2C2C2C` 对方气泡 / FG-0 白 80% 主文字 / 自己气泡 `#3EB575` 黑字）。浅色以真机采样为准，
  深色目前还没有真机截图——拿到后**只改原始色板**，语义层不动。
- **三种偏好**：跟随系统（默认，与微信一致）/ 普通 / 深色。偏好存 **localStorage**
  `ui.theme`（跟随系统 = 无此键），不进 settings 表、不进 `.aiwx` 备份——它必须同步可读，
  且是设备显示偏好而非关系资产。
- **首帧不闪**：`index.html` 的同步脚本在第一次绘制前写好 data-theme；`theme.ts` 接管运行时，
  并在「跟随系统」时监听 `prefers-color-scheme` 变化（日落自动切换是常态）。
- **系统栏**：`theme-color` meta 与原生状态栏都用生效中的 `--color-nav-bg`（从计算样式读出，
  不在 src 写色值）；原生侧 `AiwxNative.setSystemBars` 决定图标深浅（深色主题配白图标）。

### 验收
- [x] `[data-theme='dark']` 块覆盖全部画在页面底色上的语义 token；其余登记为深浅一致并写理由
  （`tests/unit/k0-theme.test.ts` 的 THEME_INVARIANT，新增 token 不表态即转红）。
- [x] 组件不直接引用会随主题变的原始色（只允许图标色相白名单）。
- [x] 首帧脚本与引擎读同一个键、同一个媒体查询（守卫）。
- [x] 深色 golden：四个 tab + 单聊 + 朋友圈 + 设置 + 零钱（`tests/screenshot/theme.spec.ts`），
  另有「首帧即深色」「手动普通模式压过系统深色」两条行为断言。
- [ ] 真机：系统切深色时 App 不重启即跟随；状态栏图标深浅正确（Android 15 edge-to-edge 下尤其要看）。
- [ ] 真机深色截图叠图后校准 `--wxd-*`。

### 已知坑
- **漏表态的 token 不会报错**，只会在深色下变成一块亮白补丁——这就是台账存在的理由。
- **WebView 的 `prefers-color-scheme` 跟的是 App 主题**：Android 主题须是 DayNight（现为
  `Theme.AppCompat.DayNight.NoActionBar`），否则系统深色时 WebView 仍报告 light。
- **不要开 WebView 的算法变暗**（algorithmic darkening）：targetSdk ≥ 33 默认关闭，开了会把
  已经是深色的页面再「反色」一遍。

## 字体大小（M-K5）

- **一个系数**：tokens.css 的全部 `--fs-*` 都是 `calc(Npx * var(--fs-scale))`，`--fs-scale` 默认 1；
  例外只有 `--fs-badge`（未读角标是定尺寸的圆，字变大会撑破它）。缩放的是**字**不是版式。
- 八档 `FONT_SCALES = [0.875, 1, 1.125, 1.25, 1.375, 1.5, 1.625, 1.75]`，下标 1 是标准；偏好存
  localStorage `ui.fontScale`（标准档 = 无此键、无内联值，DOM 与新装一致，基线一像素不动）。
- 首帧脚本同样写 `--fs-scale`。**坑**：`Number(null) === 0`（最小档），首帧脚本与 parseFontIndex
  都必须先判空（守卫在 jsdom 里真的跑一遍首帧脚本）。
- 页面：预览气泡用聊天页同一套气泡样式；下方 `StepSlider`（分档滑杆，K6 复用）。

## 聊天背景（M-K5）

- 存 settings：`chatBgDefault`（全局）与 `chatBg:<convId>`（会话级，压过全局；登记在
  SETTINGS_KEY_CASCADE，随会话删除级联）。值 = `{kind:'none'} | {kind:'preset',id} | {kind:'image',ref}`；
  「跟随全局」写 null（Repo 接口不为此长出删除方法），`parseChatBg` 把脏数据一律读成没设过。
- 预置 8 种是 `--color-chatbg-*` 渐变 / 点阵纹理（零 PNG），深色块里各有压暗版（守卫：每个预置
  两套都在）；相册背景走素材库导入（跟着备份走）。
- 有背景时时间行垫半透明胶囊（`--color-chat-stamp-pill`），否则灰字落在渐变上读不出来。
- 入口：设置 › 聊天 › 聊天背景；聊天信息 › 设置当前聊天背景。

### 验收（K5）
- [x] 字号档位解析 / 改档写键与内联值 / 首帧脚本两条分支 / token 全部乘系数（`k5-font-bg.test.ts`，三条变异验证）。
- [x] 背景解析、优先级、预置双主题 token、级联台账登记。
- [ ] 真机：大字号下各页面不溢出（长昵称、红包卡、通话页）；相册背景在深色模式下是否需要压暗。
