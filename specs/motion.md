# specs/motion.md — 动画系统契约（iOS 级手感 × 截图门禁共存）

M-H3 建层，M-I0 接返回语义，M-I8 补余量。这份 spec 主要是**约束**，因为动画是全仓
唯一一个"写对了也可能把 22 张 golden 打闪"的子系统。

## 铁约束（违者回退）

1. **非手势动画只许 CSS / WAAPI，禁止 rAF 循环驱动。**
   `toHaveScreenshot` 默认 `animations: 'disabled'` 只会把 CSS 动画、CSS 过渡与
   Web Animations API 推到终态；裸 `requestAnimationFrame` 弹簧不在此列，会让 golden
   随机闪烁。`lib/spring.ts` 的弹簧参数最终编译成 WAAPI keyframes，不逐帧驱动。
2. **手势跟踪例外**：拖拽期间允许在 `pointermove` 里直写 transform（边缘返回、Sheet
   拖拽都这么做）——手势中途不会被截图，松手后的收尾动画回到 WAAPI。
3. **只动 `transform` / `opacity`**（GPU 合成层），全部收进 `prefers-reduced-motion`。
4. **返回语义只有一套**：边缘手势、硬件返回键（`useBackButton`）、导航栏返回按钮都
   经过同一条路径——浮层 dismiss 栈（`src/app/dismiss-stack.ts`）先 pop，空了才 pop 路由。
   任何新浮层必须走 `useDismissable` 登记，否则 Android 返回键会越过它直接退页面。

## 已交付面

- 路由双向转场：`PageStack` 保持出场页挂载到动画结束（push 右入+旧页左移压暗；pop 反向）。
- iOS 边缘返回：左缘拖拽实时跟手、速度+位移判定、可反向取消（`useEdgeBack`）。
- 弹簧参数组 `--spring-*` + `lib/spring.ts`（弹簧→WAAPI 编译）。
- 会话行侧滑、气泡 pop、面板升起、toast、微交互（`src/styles/motion.css`）。

## I8 余量（未交付清单，接活时逐项勾）

- [ ] FLIP 共享元素（头像→资料卡、聊天图→查看器；测量+WAAPI）
- [ ] Sheet 拖拽关闭（I0 留的桩）
- [ ] 下拉刷新（会话列表/朋友圈）
- [ ] ImageViewer 双指缩放 + 开合转场
- [ ] 红包完整开启序列
- [ ] `.stagger-in` / `.skeleton` 接进真实列表（当前零消费者死 CSS）
- [ ] 引擎渐进上屏（流式 SSE 的 UI 端，见 specs/streaming.md）

## 转红测试

- 动画模块 rAF 零命中 grep（手势文件白名单内除外）
- 新浮层必须在 dismiss 栈注册（components.test 的 dismiss registrations 断言）
