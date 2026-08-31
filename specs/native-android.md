# spec: 重原生 Android（M-I10）

> **M-I18 实测记录（重要）**：device-test 自 M-I10 起一直是红的，但红的**不是 App**。
> 那次运行的日志证明：debug APK 构建成功（手写 Kotlin 能编译）、装进模拟器、
> `MainActivity` 起来了、`AIWX-SELFTEST` 行打了出来（`allReachable=true`，zen 走桥
> 200，deepseek/minimax 无 key 401），且**没有任何 FATAL EXCEPTION**——只有 web fetch
> 通道的 CORS 报错，而那正是桥通道存在的理由。真正的失败是 shell 语义：
> `android-emulator-runner` 的 `script:` 是**逐行**交给独立 `sh -c` 的，跨行变量与函数
> 活不过一行，`: > "$NA"` 于是展开成 `: > ""` 并 exit 2 —— 五组原生面断言**一次都没跑过**，
> 而「Native surfaces verdict」只会说结果文件不存在。已搬进
> `scripts/device-native-asserts.sh`（单一 shell，`sh -n` 可校验）。
> 结论：I10 的**编译与冷启动**已被 CI 证明；悬浮窗 / RemoteInput / 来电全屏 / 小组件的
> **行为**断言，从这次修复起才第一次真正开始跑。
>
> **第二次实测（同轮，断言真跑起来之后）**：9 项里 7 项 PASS（RemoteInput 回环、
> 悬浮气泡、小组件全部真的通了），2 项通知频道 FAIL。第一反应是 `dumpsys` 脱敏，加了
> `--noredact` 仍红——**猜错了**。把 evidence 工件拉下来读，`dumpsys` 里写着
> `AppSettings: com.personal.weixinai importance=NONE`，且**零个 `aiwx_` 频道**：
> POST_NOTIFICATIONS 自 Android 13 起是运行时权限、**默认拒绝**，无头模拟器上没人点
> 「允许」，于是 `Notifier.canPost()` 为 false，两个 notify 入口在第一行就 return——
> 而 `ensureChannels()` 恰恰写在那道闸**之后**。
>
> 这暴露了一个**真机上也成立的 App 缺陷**（不只是测试环境问题）：用户授权之前，
> 「设置 → 应用 → 通知」里只有 Capacitor 的 `default` 频道，**没有**消息 / 来电两个
> 分类可调——建频道本来就不需要任何权限，它却被锁在权限后面。已把
> `Notifier.ensureChannels(this)` 提到 `MainActivity.onCreate`，启动即注册、幂等。
>
> 同时发现 `notify-record-posted` 是个**假绿**：它在整份 dump 里 grep 包名，而
> `dumpsys` 会为**每个已安装应用**打一行 `AppSettings: <pkg>`——所以这条断言无论有没有
> 发出通知都会 PASS，那一轮它正是在「通知列表里只有一条、且属于 `pkg=android`」的情况下
> 报的绿。阻塞门禁里的假绿比它旁边两条诚实的红更危险。现在 posted-ness 只从
> `Notification List` 段读（`posted_record` / `posted_on_channel`），频道「注册了」与
> 「真的发在上面」拆成两条断言——它们是两种不同的故障。
>
> **第三次实测：11 项原生断言全 PASS**（run #8，提交 0e86a67）——通知发出、两个频道
> 各自收到真实记录、RemoteInput 回环、悬浮气泡、小组件全部在设备上验过。M-I10 的
> **行为**至此第一次被机器证明，不再只是「能编译能冷启动」。
>
> 但那一轮 job 仍报红，原因在**测试脚手架**，又是两条：
> ① 那台 runner **没有 DNS**（三个端点的原生通道全是 `Unable to resolve host`；
> 上一轮同样的代码是 401/401/200，解析正常）。连通性自检因此判失败——可这是环境，
> 不是 App。判据已加区分：**只有当每个端点的原生通道都是解析失败**才算环境问题
> （降为 warning）；只要有一个端点解析成功，DNS 就是活的，其余失败一律仍然算 App 的问题。
> 这条测试真正要抓的回归（M-C 那个 Capacitor 插件代理传输 bug）不会表现为解析失败，
> 所以闸门没有被放松。
> ② 更要命的是**遮蔽**：原生面断言那一步没有 `if: always()`，连通性判定一红它就被
> skip 掉。于是 11 项全 PASS 的结果**根本没被打印出来**，job 只显示一个红叉。
> 两个判定互相独立，已改成 `always()`——否则一次网络抖动就能把真正的原生回归藏起来。

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

## M-J4b · 精确闹钟 + 锁屏来电真着屏

- **manifest 声明双精确闹钟权限**：`SCHEDULE_EXACT_ALARM`（12-13，可被用户在系统
  设置关掉，@capacitor/local-notifications 会自动退回不精确）+ `USE_EXACT_ALARM`
  （14+ 自动授予；有 Play 政策限制，但本 App 个人侧载不进店）。不声明时预调度通知
  在 Android 12+ **全部**静默退化成不精确投递——「早安」中午才到。
- **锁屏来电 flag 是动态的**（MainActivity.applyLockscreenForIntent）：只有
  `aiwx://call/...?incoming=1` 的 intent 才 `setShowWhenLocked(true)+setTurnScreenOn(true)`；
  任何其他 intent 显式复位。**绝不**写进 manifest 静态属性——那会把整个 App 抬到
  keyguard 之上，锁屏点一条消息通知就能翻聊天记录，是隐私洞不是功能。
  singleTask 实例活得比一次来电久，不复位=旧旗帜永久漏全 App。
- 转红：`j4-notify-coverage.test.ts`（manifest 双权限在、`showWhenLocked` 不在
  manifest、动态 set/复位路径在 MainActivity）。
- 真机验收追加：锁屏收 AI 来电 → 屏幕自己亮起且铃响页盖在锁屏上（3 的强化版）；
  Android 14 真机上「设置→应用→闹钟与提醒」应显示已允许。
