# spec: 重原生 Android（M-I10）

五个各自独立可弃的特性：android/ 入库、消息悬浮气泡、通知 RemoteInput 直接回复、
来电全屏通知、电池白名单向导、桌面小组件。入库与再生成策略见 `docs/android-regen.md`。

## 架构不变量

- **唯一自定义插件** `AiwxNative`（`android/.../aiwx/AiwxNativePlugin.kt`），JS 侧唯一入口
  `src/native/bridge.ts`——全部是**普通函数返回普通数据**，插件代理永不作为 Promise 的
  resolution value（thenable 陷阱，tests/unit/plugin-proxy.test.ts）。每个桥调用都
  `withDeadline()` race 一个**会 reject** 的定时器（宪法 3.5「超时必须真拒绝」）。
- **深链是唯一回入口**：`aiwx://chat/<id>`、`aiwx://call/<id>?incoming=1[&accept=1]`、
  `aiwx://chats`、`aiwx://settings/{battery,native}`。native 侧由 `DeepLink.kt` 统一构造，
  JS 侧 `src/native/deep-link.ts` **allowlist** 校验（exported activity 谁都能投 URI，
  allowlist 是安全边界；`/persona/*`、`/settings/api` 永不深链）。路由挂载于
  `<DeepLinkBridge/>`（App.tsx，Router 内），冷启走 `getLaunchUrl()`，热启走 `appUrlOpen`，
  3 秒窗口去重防双导航。
- **web 降级**：`src/native/*` 每个入口在非原生平台返回惰性默认值，绝不 throw；
  两个新页面（原生增强 / 电池向导）在浏览器里保留为说明书。
- **依赖方向**：`native → store/ai/llm/lib/db/data`（与 features 同级），`app → native`。

## 各特性设计要点

### 悬浮气泡（BubbleService）
- `SYSTEM_ALERT_WINDOW`；授权入口在 设置→原生增强（`requestOverlay` 发系统页，回前台轮询
  `overlayGranted` 刷新状态）。
- 非前台服务：生产者是活着的 WebView（见「后台监听」），进程死了气泡也没意义。
- 顶部横条样式，可拖动，点按深链进会话并消失，12s 自动消失；权限被中途收回时静默降级。

### 通知 RemoteInput 直接回复
- 双通道分工：`@capacitor/local-notifications` 管**预调度**（app 死了也能响，lib/notify.ts
  原路不动）；`Notifier.kt` 管**活着但在后台**时的即时通知，只有这条通道能带 RemoteInput
  action 与自定 PendingIntent。
- 回复链：RemoteInput → `ReplyReceiver`（BroadcastReceiver，10 秒、无 WebView）→
  `ReplyQueue`（SharedPreferences JSON 队列，commit() 同步落盘，封顶 50 条）→ 下次回前台
  `runForegroundPass` 第 0.5 步 `drainNativeReplies()` → **正常发送路径**
  （sendUserMessage / sendGroupMessage）。通知栏回复与打字回复对引擎完全同构。
- 收到回复必须以同 id 重发通知（「已收下，打开应用即发送」），否则系统 spinner 永转。
- 已知重叠：预调度通知与即时通知 id 不同，可能近邻出现一次；回前台重建会清掉过期的一半。
  接受，不引入跨通道去重状态机。

### 来电全屏
- `Notifier.notifyCall`：CATEGORY_CALL + fullScreenIntent（锁屏直接全屏拉起）+
  接听/拒绝 action。接听=深链 `&accept=1` 直进通话中；拒绝=ReplyReceiver 入队
  `call_declined`，回前台物化成 type 'call'、meta `{direction:'in'}` 的未接记录
  （M5 起就有投影、至此才有生产者）。CallPage 新增 incoming 相位（响铃、接听/拒绝 UI），
  进页即取消通知。
- 生产者：后台监听在单聊文本消息上以 `seededRng('nativecall_'+convId+'_'+msgId)`
  按 7% 概率把消息升级为来电（宪法铁律 4：无 Math.random）；设置页开关
  `nativeIncomingCall` 可关；「模拟一次来电」按钮供验收。

### 后台监听（src/native/background-notify.ts）
- store 订阅 + 每会话尾消息 id 水位；仅 `document.hidden` 时动作；水合首见不算新消息。
- 1.5s 尾随防抖合并多气泡一轮；burst 内 call 覆盖 message。
- **隐藏会话（AI↔AI）在此层再挡一次**；全开档会话通知体降级为 `[你收到一条消息]`
  （NO_PREVIEW_BODY——锁屏不是给 NSFW 预览的地方）。

### 电池白名单向导（/settings/battery）
- 纯逻辑在 `src/native/battery.ts`：`detectVendor(Build.MANUFACTURER)` →
  8 家 ROM 的人话步骤；原生 `openBatterySettings(vendor)` 走「厂商专属 Activity 阶梯 →
  AOSP 电池优化列表 → 本应用详情页」，永不 reject，返回打开了哪一级。
- 标准豁免走 `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`；状态在 visibilitychange
  时重读（从系统页回来即刷新）。

### 桌面小组件（AiwxWidgetProvider）
- 数据单向：JS `syncWidget()`（回前台第 5 步 + 退后台时）→ `updateWidget` 桥 →
  SharedPreferences → RemoteViews 渲染。`updatePeriodMillis=0`，launcher 永不自拉。
- **隐藏会话在 JS 生产者过滤**（buildWidgetSummary），Kotlin 渲染层根本见不到。
- 点按深链进最新会话（无会话时进 /chats）。

## 验收

- 门禁：`pnpm typecheck && pnpm lint && pnpm test`；转红测试
  `tests/unit/native-wiring.test.ts`（接线缺失/workflow 退回 cap add/生成物入库 都会红）。
- 模拟器（device-test.yml，debug-only `SelfTestReceiver` 驱动）硬断言：通知已发出且用
  aiwx_messages 通道、合成回复入队且被 JS 排空（AIWX-REPLYQ drained=）、来电通道已发出、
  气泡窗口已显示（AIWX-BUBBLE shown）、widget provider 渲染不崩（AIWX-WIDGET render）。

### 真机验收清单（模拟器测不了的）
1. **悬浮窗授权流**：MIUI/ColorOS 的授权 UI 与 appops 不同；设置→原生增强→去授权→
   回来状态变「已授权」→ 弹测试气泡 → 切到桌面收一条 AI 消息，气泡浮在桌面上，点按直达。
2. **RemoteInput 真键盘**：切后台等一条 AI 消息 → 通知栏展开直接输入 → 通知变
   「已收下」→ 打开 app：你的话已在会话里、AI 已接话。
3. **锁屏来电**：锁屏等到概率来电（或设置页「模拟一次来电」后立刻锁屏）→ 全屏铃响页 →
   接听进通话/拒绝留未接记录。
4. **OEM 电池页深跳**：各厂商 Activity 名随 ROM 版本漂移，`openBatterySettings` 的阶梯
   逐级回退是否落在可操作页面，只能真机确认。
5. **widget 实装**：桌面添加小组件 → 未读角标与预览随开关 app 刷新 → 点按直达会话。
