# specs/motion.md — 动画系统契约（iOS 级手感 × 截图门禁共存）

M-H3 建层，M-I0 接返回语义，M-I8 补余量。这份 spec 主要是**约束**，因为动画是全仓
唯一一个"写对了也可能把 22 张 golden 打闪"的子系统。

## 铁约束（违者回退）

1. **非手势动画只许 CSS / WAAPI，禁止 rAF 循环驱动。**
   `toHaveScreenshot` 默认 `animations: 'disabled'` 只会把 CSS 动画、CSS 过渡与
   Web Animations API 推到终态；裸 `requestAnimationFrame` 弹簧不在此列，会让 golden
   随机闪烁。`lib/spring.ts` 的弹簧参数最终编译成 WAAPI keyframes，不逐帧驱动。
2. **手势跟踪例外**：拖拽期间允许在 `pointermove` 里直写 transform（边缘返回、Sheet
   拖拽、下拉刷新、双指缩放都这么做）——手势中途不会被截图，松手后的收尾动画回到 WAAPI。
3. **只动 `transform` / `opacity`**（GPU 合成层），全部收进 `prefers-reduced-motion`。
4. **返回语义只有一套**：边缘手势、硬件返回键（`useBackButton`）、导航栏返回按钮都
   经过同一条路径——浮层 dismiss 栈（`src/app/dismiss-stack.ts`）先 pop，空了才 pop 路由。
   任何新浮层必须走 `useDismissable` 登记，否则 Android 返回键会越过它直接退页面。
5. **动画不许留下残余 transform**（M-I8 新增，血泪条款见下）。凡是 `fill: forwards/both`
   的动画（CSS `animation-fill-mode` 与 WAAPI 都算），收尾时必须把值落成 inline style
   再 `cancel()`，或者干脆用 `backwards`。

## 已交付面

- 路由双向转场：`PageStack` 保持出场页挂载到动画结束（push 右入+旧页左移压暗；pop 反向）。
- iOS 边缘返回：左缘拖拽实时跟手、速度+位移判定、可反向取消（`useEdgeBack`）。
- 弹簧参数组 `--spring-*` + `lib/spring.ts`（弹簧→WAAPI 编译）。
- 会话行侧滑、气泡 pop、面板升起、toast、微交互（`src/styles/motion.css`）。
- **FLIP 共享元素**（M-I8，`lib/flip.ts` + `lib/useFlipEnter.ts`）：纯测量+WAAPI 编译，
  三个接入点——联系人行头像→资料卡头像、聊天图气泡→查看器、朋友圈九宫格→查看器。
  源矩形经模块级注册表（TTL 1.5s）跨路由传递，**在点击那一刻测量**（列表随后会滚动/卸载）。
- **Sheet 拖拽关闭**（M-I8，`components/useSheetDrag.ts`）：跟手下拉、速度+位移判定、
  向上橡皮筋、body 未滚到顶时让位给滚动；关闭走同一个 `onClose`（dismiss 栈语义不变）。
- **下拉刷新**（M-I8，`components/usePullRefresh.ts` + `PullRefresh.tsx`）：会话列表与
  朋友圈 feed。橡皮筋 `d·max/(d+max)`、越过阈值改文案/满环、松手停在阈值高度跑刷新。
  刷新动作复用 store 已有加载方法（`loadMoments(true)` / `refreshConversations()`）。
- **ImageViewer 双指缩放**（M-I8）：pinch（围绕双指中点，不是中心）、单指平移并夹到
  图片边界、双击 2×、下拉关闭、左右翻页、开合 FLIP。
- **红包完整开启序列**（M-I8）：金币翻转 → 信封（发送者+祝福语）上移淡出 → 金额逐字滚上来
  → 已存入零钱。全 CSS，静止态 DOM 不变（`rp-open` golden 未动）。
- **`.stagger-in` / `.skeleton` 接活**（M-I8）：首屏错峰淡入（`lib/stagger.ts`，仅首次挂载
  的前 8 行、400ms 窗口内），图片加载骨架（朋友圈格子 / 聊天图气泡 / 查看器）。
- **`<RollingNumber/>`**（M-I8）：旧数上移出 + 新数下移入，取代只动新值的 `.badge-roll`
  （已删除）。用在会话未读角标与 tab 角标。

## I8 余量（剩余）

- [ ] 引擎渐进上屏（流式 SSE 的 UI 端，见 specs/streaming.md）

## 已知陷阱（M-I8 踩到的）

- **残余 transform = fixed 定位陷阱**。`.stagger-in` 原本写 `animation-fill-mode: both`，
  终帧 `translateY(0)` 会被永久保留，计算值是 `matrix(1,0,0,1,0,0)`——而**任何非 `none`
  的 transform 都会让该元素成为 `position: fixed` 子孙的包含块**。于是每张错峰进场过的
  朋友圈卡片都变成了"视口"，从卡片里打开的全屏图片查看器渲染成了 390×276 卡内小窗
  （不是 390×844 全屏）。现象离病因十万八千里。
  修法：错峰用 `backwards`（延迟期间保持首帧，结束后不留值）；WAAPI 侧
  （`usePullRefresh` / `useSheetDrag` / `flip`）收尾时先落 inline style 再 `cancel()`。
- **FLIP 的源矩形必须在点击瞬间量**，不能等目标页挂载后回头量：列表在这中间会滚动，
  甚至已经卸载。注册表带 TTL，就是为了「点了但没跳转」的那次不会污染下一次进场。
- **0..1 归一化弹簧比像素弹簧短**，但仍有 ~500-800ms：`SPRINGS.settle` 在单位区间要 817ms，
  用作双击缩放收尾会被读成卡顿。查看器用 `SPRINGS.pop`（467ms，带 10% 回弹）。
- **clip 与 host 必须是两个元素**（下拉刷新）：指示器停在 host 上方，把 `overflow: hidden`
  写在 host 上会把裁剪一起平移下去，指示器永远不出现——这是自制下拉刷新最常见的哑火方式。

## 转红测试（`tests/unit/motion-i8.test.ts`）

- 动画模块 + 手势模块 rAF 零命中（手势的豁免只到"pointermove 里直写 transform"为止，
  不含自跑循环）
- `.stagger-in` / `.skeleton` 必须有真实消费者；`.badge-roll` 必须保持删除状态
- `.stagger-in` 不得 `both`/`forwards`；三个 WAAPI 收尾必须 `cancel()`
- `flip.ts` 纯函数：inversion 算术、退化矩形、终帧恰好为 `none`、offsets 递增、
  注册表 TTL 与不泄漏
- 橡皮筋曲线：起点跟手、单调、有界、阈值可达
- 每个动画 CSS 文件都必须有 `prefers-reduced-motion` 分支；`@keyframes` 只许动
  transform/opacity（例外走带理由的 `KEYFRAME_EXEMPTIONS` 台账）
- 新浮层必须在 dismiss 栈注册（components.test 的 dismiss registrations 断言）
